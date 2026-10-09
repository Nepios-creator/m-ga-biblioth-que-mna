const pool = require('../db/pool');

async function callMistral(prompt) {
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: 'mistral-small-latest', max_tokens: 4000, temperature: 0.4, messages: [{ role: 'user', content: prompt }] }),
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

async function generateForPart(part, nFinal) {
  const text = (part.content || '').slice(0, 12000);
  const prompt = `Voici un extrait d'un livre chrétien (une partie d'un parcours d'étude), intitulé « ${part.title} ».

TEXTE :
${text}

Tâche : génère deux séries de questions à choix multiples (4 propositions chacune), strictement fondées sur ce texte, sans rien inventer d'étranger au texte :
1. "quiz_partie" : exactement 10 questions qui testent la compréhension de cette partie précise.
2. "quiz_final" : exactement ${nFinal} questions plus exigeantes, destinées à être combinées avec celles d'autres parties pour un grand test final sur l'ensemble du livre.

Règles impératives :
- Pour chaque question, les 3 mauvaises réponses doivent être des affirmations plausibles, elles-mêmes tirées ou inspirées du texte (jamais des absurdités évidentes), afin qu'on ne puisse pas deviner sans avoir lu.
- Varie la structure des questions (ne répète pas le même tour de phrase).
- Réponds UNIQUEMENT avec un objet JSON de cette forme exacte, sans aucun texte autour :
{"quiz_partie":[{"question_text":"...","choices":["...","...","...","..."],"correct_choice_index":0}],"quiz_final":[{"question_text":"...","choices":["...","...","...","..."],"correct_choice_index":0}]}`;

  return callMistral(prompt);
}

// Génère automatiquement les tests (par partie + grand test final, 40 questions) pour tout livre de l'espace d'étude qui n'en a pas encore
async function autoGenerateQuizzes() {
  if (!process.env.MISTRAL_API_KEY) return;
  try {
    const books = (await pool.query(
      `SELECT b.id, b.title FROM books b
       WHERE b.is_study_book = true
         AND EXISTS (SELECT 1 FROM book_parts bp WHERE bp.book_id = b.id AND bp.content_filled = true)
         AND NOT EXISTS (SELECT 1 FROM quiz_questions qq WHERE qq.book_id = b.id)`
    )).rows;

    for (const book of books) {
      try {
        const parts = (await pool.query(
          'SELECT id, part_index, title, content FROM book_parts WHERE book_id=$1 ORDER BY part_index', [book.id]
        )).rows;
        if (!parts.length) continue;

        const finalPerPart = Math.ceil(40 / parts.length);
        let totalFinal = 0;

        for (const part of parts) {
          const { quiz_partie, quiz_final } = await generateForPart(part, finalPerPart);

          for (const q of (quiz_partie || []).slice(0, 12)) {
            if (!q.question_text || !Array.isArray(q.choices) || q.choices.length < 2) continue;
            const s = shuffleChoices(q);
            await pool.query(
              'INSERT INTO quiz_questions (book_id, part_id, question_text, choices, correct_choice_index) VALUES ($1,$2,$3,$4,$5)',
              [book.id, part.id, s.question_text, JSON.stringify(s.choices), s.correct_choice_index]
            );
          }
          for (const q of (quiz_final || [])) {
            if (totalFinal >= 40 || !q.question_text || !Array.isArray(q.choices) || q.choices.length < 2) continue;
            const s = shuffleChoices(q);
            await pool.query(
              'INSERT INTO quiz_questions (book_id, part_id, question_text, choices, correct_choice_index) VALUES ($1,NULL,$2,$3,$4)',
              [book.id, s.question_text, JSON.stringify(s.choices), s.correct_choice_index]
            );
            totalFinal++;
          }
        }
        console.log(`Tests générés automatiquement pour "${book.title}" (${totalFinal} questions au test final)`);
      } catch (err) {
        console.error(`Échec génération des tests pour "${book.title}" :`, err.message);
      }
    }
  } catch (err) {
    console.error('Erreur autoGenerateQuizzes :', err.message);
  }
}

module.exports = { autoGenerateQuizzes };
