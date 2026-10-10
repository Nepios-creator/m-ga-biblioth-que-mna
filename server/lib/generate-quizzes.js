const pool = require('../db/pool');

const POOL_VERSION = 2;          // incrémenter pour forcer la régénération des réserves de tous les livres
const PART_POOL_SIZE = 30;       // réserve par partie (10 tirées au sort à chaque test)
const FINAL_POOL_TARGET = 140;   // réserve du test final (40 tirées au sort) — entre 120 et 160
const FINAL_POOL_MAX = 160;

async function callMistral(prompt) {
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: 'mistral-small-latest', max_tokens: 7000, temperature: 0.5, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error?.message || 'Erreur Mistral');
  let raw = (data.choices?.[0]?.message?.content || '{}').trim();
  raw = raw.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Réponse IA non exploitable');
  }
}

async function callWithRetry(prompt) {
  try { return await callMistral(prompt); }
  catch (e) { return await callMistral(prompt); }
}

// Mélange les propositions pour que la bonne réponse ne soit jamais prévisible
function shuffleChoices(q) {
  const choices = (q.choices || []).slice();
  const correctText = choices[q.correct_choice_index];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  const idx = choices.indexOf(correctText);
  return { question_text: q.question_text, choices, correct_choice_index: idx >= 0 ? idx : 0 };
}

function buildPrompt(part, count, kind) {
  const text = (part.content || '').slice(0, 14000);
  const purpose = kind === 'part'
    ? `qui testent la compréhension de cette partie précise, en couvrant tous ses passages (début, milieu, fin) et pas seulement les premiers`
    : `plus exigeantes, destinées à un grand test final sur l'ensemble du livre ; elles doivent porter sur des idées, arguments, exemples et versets différents de ceux qu'on retient au premier coup d'œil`;
  return `Voici un extrait d'un livre chrétien (une partie d'un parcours d'étude), intitulé « ${part.title} ».

TEXTE :
${text}

Tâche : génère exactement ${count} questions à choix multiples (4 propositions chacune) ${purpose}. Elles doivent être strictement fondées sur ce texte, sans rien inventer d'étranger au texte.

Règles impératives :
- Chaque question porte sur un point DIFFÉRENT (aucun doublon, aucune reformulation d'une autre question).
- Les 3 mauvaises réponses doivent être des affirmations plausibles, tirées ou inspirées du texte (jamais des absurdités évidentes), pour qu'on ne puisse pas deviner sans avoir lu.
- Varie la structure des questions.
- Réponds UNIQUEMENT avec un objet JSON de cette forme exacte, sans aucun texte autour :
{"questions":[{"question_text":"...","choices":["...","...","...","..."],"correct_choice_index":0}]}`;
}

function validQuestion(q) {
  return q && typeof q.question_text === 'string' && q.question_text.length > 8
    && Array.isArray(q.choices) && q.choices.length >= 3 && q.choices.every((c) => typeof c === 'string' && c.trim())
    && Number.isInteger(q.correct_choice_index) && q.correct_choice_index >= 0 && q.correct_choice_index < q.choices.length;
}

const norm = (t) => t.toLowerCase().replace(/[^a-zà-ÿ0-9]+/g, ' ').trim();

async function generateBookQuizzes(book) {
  const parts = (await pool.query(
    'SELECT id, part_index, title, content FROM book_parts WHERE book_id=$1 ORDER BY part_index', [book.id]
  )).rows;
  if (!parts.length) return;

  // Tout est généré AVANT de toucher à l'existant : en cas d'échec, les anciennes questions restent en place
  const finalPerPart = Math.ceil(FINAL_POOL_TARGET / parts.length);
  const partQs = [];
  const finalQs = [];
  const seenFinal = new Set();

  for (const part of parts) {
    const a = await callWithRetry(buildPrompt(part, PART_POOL_SIZE, 'part'));
    const seen = new Set();
    const list = [];
    for (const q of (a.questions || [])) {
      if (!validQuestion(q) || seen.has(norm(q.question_text))) continue;
      seen.add(norm(q.question_text));
      list.push(shuffleChoices(q));
    }
    if (list.length < 12) throw new Error(`Réserve trop petite pour la partie ${part.part_index} (${list.length})`);
    partQs.push({ partId: part.id, list });

    const b = await callWithRetry(buildPrompt(part, finalPerPart, 'final'));
    for (const q of (b.questions || [])) {
      if (!validQuestion(q) || seenFinal.has(norm(q.question_text))) continue;
      seenFinal.add(norm(q.question_text));
      finalQs.push(shuffleChoices(q));
    }
  }
  if (finalQs.length < 60) throw new Error(`Réserve du test final trop petite (${finalQs.length})`);

  // Remplacement de l'ancienne réserve par la nouvelle, en une seule transaction (tout ou rien)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM quiz_questions WHERE book_id=$1', [book.id]);
    for (const { partId, list } of partQs) {
      for (const s of list) {
        await client.query(
          'INSERT INTO quiz_questions (book_id, part_id, question_text, choices, correct_choice_index) VALUES ($1,$2,$3,$4,$5)',
          [book.id, partId, s.question_text, JSON.stringify(s.choices), s.correct_choice_index]
        );
      }
    }
    for (const s of finalQs.slice(0, FINAL_POOL_MAX)) {
      await client.query(
        'INSERT INTO quiz_questions (book_id, part_id, question_text, choices, correct_choice_index) VALUES ($1,NULL,$2,$3,$4)',
        [book.id, s.question_text, JSON.stringify(s.choices), s.correct_choice_index]
      );
    }
    await client.query('UPDATE books SET quiz_pool_version=$1 WHERE id=$2', [POOL_VERSION, book.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log(`Réserves de tests générées pour "${book.title}" : ${partQs.map((p) => p.list.length).join('/')} par partie, ${Math.min(finalQs.length, FINAL_POOL_MAX)} pour le test final`);
}

// Génère automatiquement les réserves de questions de tout livre de l'espace d'étude (nouveau, ou dont la réserve est périmée)
async function autoGenerateQuizzes() {
  if (!process.env.MISTRAL_API_KEY) return;
  try {
    const books = (await pool.query(
      `SELECT b.id, b.title FROM books b
       WHERE b.is_study_book = true
         AND b.quiz_pool_version < $1
         AND EXISTS (SELECT 1 FROM book_parts bp WHERE bp.book_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM book_parts bp WHERE bp.book_id = b.id AND bp.content_filled = false)`,
      [POOL_VERSION]
    )).rows;
    for (const book of books) {
      try { await generateBookQuizzes(book); }
      catch (err) { console.error(`Échec génération des tests pour "${book.title}" :`, err.message); }
    }
  } catch (err) {
    console.error('Erreur autoGenerateQuizzes :', err.message);
  }
}

module.exports = { autoGenerateQuizzes };
