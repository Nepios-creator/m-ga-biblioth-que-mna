const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth-middleware');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const router = express.Router();
router.use(requireAuth);

const SYSTEM_PROMPT = `Tu es l'Assistant IA du Ministère de la Nouvelle Alliance (MNA). Tu réponds comme une personne qui parle à une autre : avec chaleur, simplicité et naturel, comme un frère ou une sœur dans la foi qui connaît bien les enseignements du ministère et qui prend le temps d'expliquer.

FIDÉLITÉ AUX DONNÉES (règle la plus importante) :
- Pour tout ce qui touche à l'enseignement du ministère, tu t'appuies UNIQUEMENT sur les extraits fournis avec la question. Tu ne prêtes jamais aux livres une idée, une citation, un chapitre, un numéro de page ou un verset qui n'apparaît pas dans ces extraits.
- Si les extraits ne couvrent pas la question, dis-le simplement et honnêtement, par exemple : « Ce point précis n'est pas développé dans les textes que j'ai sous la main. » Tu peux alors donner un repère biblique général, en précisant clairement que cela ne vient pas des livres du ministère.
- Ne complète jamais un trou par une supposition. Mieux vaut une réponse courte et vraie qu'une longue réponse inventée.
- Cohérence : si le lecteur poursuit le même sujet, reste fidèle à tes réponses précédentes de cette conversation.

LA BIBLE DU SITE : « LES SAINTES ÉCRITURES — VERSION PAROLE PURE » :
- C'est ta Bible principale, celle du site. Chaque fois que tu cites un passage des Écritures, tu le prends dans les versets fournis avec la question (section « VERSETS DE LA BIBLE PAROLE PURE ») et tu le cites mot pour mot, avec sa référence (Livre chapitre:verset). Tu ne reformules, n'abrèges, ne corriges et ne mélanges jamais un verset que tu cites entre guillemets.
- Si le verset ou le passage demandé ne figure pas dans les versets fournis, dis simplement que ce passage n'est pas encore en ligne dans la Parole pure du site. Tu ne le cites alors pas de mémoire, dans aucune autre version : tu peux en donner l'idée générale, sans guillemets, en précisant que ce n'est pas le texte de la Parole pure.
- Les notes explicatives de la Parole pure (section « NOTES EXPLICATIVES ») sont là pour t'aider à expliquer un passage. Tu t'en sers seulement quand la question demande une explication, un éclairage ou le sens d'un passage, jamais systématiquement. Quand tu t'en sers, dis que c'est une note explicative de la Parole pure, puis explique-la simplement dans tes mots, sans rien y ajouter qui n'y soit pas.
- Les versets cités à l'intérieur des livres du ministère (extraits de livres) appartiennent à ces livres : quand tu rapportes ce qu'un livre dit, reprends ses versets exactement tels qu'ils y sont écrits, sans les modifier ni les remplacer par une autre version.

STYLE :
- Parle naturellement, à la première personne, avec des phrases courtes et vivantes, comme à l'oral. Vouvoie le lecteur avec douceur.
- N'écris jamais « en tant qu'assistant », « en tant qu'IA », ni de formules toutes faites d'ouverture ou de conclusion.
- Écris en paragraphes simples. Pas de titres, pas de listes à puces, pas de tableaux, pas d'émojis, pas de symboles décoratifs.
- Mets en gras avec **deux astérisques** uniquement les quelques mots ou phrases essentiels (l'idée clé, un verset important), sans en abuser. N'utilise aucun autre formatage.
- Reste concis : va à l'essentiel, sans répéter la question.

PÉRIMÈTRE :
- Tu ne traites que la foi chrétienne, la Bible, la théologie et la vie spirituelle. Pour tout autre sujet, décline avec douceur en une phrase.
- Aucun conseil médical, juridique, financier ou technique.`;


// Nettoie la réponse : garde uniquement le gras **...**, retire le reste du balisage inutile
function cleanAnswer(t) {
  return String(t || '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/`+/g, '')
    .replace(/__([^_\n]+)__/g, '**$1**')
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// =====================================================================
//  Outils de recherche (tout est lu en direct dans la base : dès qu'un livre ou un chapitre est
//  publié, modifié ou retiré, l'assistant le sait à la question suivante)
// =====================================================================

// Met un texte en minuscules et sans accents, sans changer sa longueur (indispensable pour repérer les passages)
const FROM = 'àâäáãåéèêëíìîïóòôöõúùûüýÿçñœæ';
const TO = 'aaaaaaeeeeiiiiooooouuuuyycnoa';
function fold(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[àâäáãå]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i')
    .replace(/[óòôöõ]/g, 'o').replace(/[úùûü]/g, 'u').replace(/[ýÿ]/g, 'y').replace(/ç/g, 'c').replace(/ñ/g, 'n')
    .replace(/œ/g, 'o').replace(/æ/g, 'a').replace(/[’‘]/g, "'").replace(/[–—]/g, '-');
}
const SQL_FOLD = (col) => `translate(lower(${col}), '${FROM}', '${TO}')`;

const STOP = new Set(('dans avec pour cette cela celui celle ceux comme plus tout tous toute toutes faire fait sont etre avoir quel quelle quels quelles quand dire dit donne donner donnez moi nous vous leur leurs mais aussi selon sans sous entre encore peut peux peuvent veux voudrais explique expliquer expliquez pourquoi comment parle parler bible verset versets passage passages texte ecritures ecriture chapitre livre livres quoi dont chez alors ainsi cest cet ces ses mes tes notre votre etait sera serait ete suis aime peux savoir connais connaitre trouve trouver cherche chercher aide aider merci bonjour salut svp').split(' '));
function keywords(text) {
  const words = fold(text).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 8);
}
const likeParam = (w) => '%' + w.replace(/[\\%_]/g, '\\$&') + '%';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Références citées dans la question : « Jean 3:16 », « 1 Jean 2.1-3 », « Psaume 23 », « Jn 1 »…
async function findReferences(text) {
  const books = (await pool.query('SELECT id, name, abbreviation FROM bible_books WHERE published')).rows;
  if (!books.length) return [];
  const names = [];
  books.forEach((b) => {
    names.push({ b, n: fold(b.name).trim() });
    if (b.abbreviation) names.push({ b, n: fold(b.abbreviation).replace(/\.$/, '').trim() });
  });
  names.sort((x, y) => y.n.length - x.n.length);
  let work = ' ' + fold(text) + ' ';
  const refs = [];
  for (const { b, n } of names) {
    if (n.length < 2) continue;
    const re = new RegExp('(^|[^a-z0-9])' + esc(n).replace(/\s+/g, '\\s+') + '\\.?\\s*(?:chapitre\\s+|chap\\.?\\s*|ch\\.?\\s*)?(\\d{1,3})(?:\\s*(?:[:.,]|v\\.?|verset\\s+|versets\\s+|vv\\.?)\\s*(\\d{1,3})(?:\\s*(?:-|a|au)\\s*(\\d{1,3}))?)?(?![a-z0-9])', 'g');
    work = work.replace(re, (all, pre, ch, v1, v2) => {
      const vs = v1 ? Number(v1) : null;
      const ve = v2 ? Number(v2) : vs;
      refs.push({ book: b, chapter: Number(ch), vs: vs && ve && ve < vs ? ve : vs, ve: vs && ve && ve < vs ? vs : ve });
      return pre + ' ';
    });
  }
  return refs.slice(0, 4);
}

const refLabel = (name, ch, v1, v2) => `${name} ${ch}${v1 ? ':' + v1 + (v2 && v2 !== v1 ? '-' + v2 : '') : ''}`;

async function fetchReference(r) {
  const book = r.book;
  const MAXV = r.vs ? 40 : 45;
  const params = r.vs ? [book.id, r.chapter, r.vs, r.ve || r.vs] : [book.id, r.chapter];
  const rows = (await pool.query(
    r.vs
      ? `SELECT verse, text FROM bible_verses WHERE book_id=$1 AND chapter=$2 AND verse BETWEEN $3 AND $4 ORDER BY verse LIMIT ${MAXV + 1}`
      : `SELECT verse, text FROM bible_verses WHERE book_id=$1 AND chapter=$2 ORDER BY verse LIMIT ${MAXV + 1}`, params
  )).rows;
  const truncated = rows.length > MAXV;
  return { ref: r, rows: rows.slice(0, MAXV), truncated };
}

// Notes explicatives qui touchent aux versets donnés : [{ book_id, chapter, from, to }]
async function fetchNotes(targets) {
  if (!targets.length) return [];
  try {
    const out = [];
    for (const t of targets.slice(0, 6)) {
      const rows = (await pool.query(
        `SELECT c.chapter, c.verse_start, c.verse_end, c.title, c.body, c.letter, b.name AS book_name
         FROM bible_comments c JOIN bible_books b ON b.id = c.book_id
         WHERE c.book_id = $1 AND c.chapter = $2 AND b.published
           AND ((c.verse_end >= $3 AND c.verse_start <= $4) OR c.verse_start = 0)
         ORDER BY c.verse_end, c.position LIMIT 8`, [t.book_id, t.chapter, t.from, t.to]
      )).rows;
      rows.forEach((n) => { if (!out.some((o) => o.chapter === n.chapter && o.verse_end === n.verse_end && o.letter === n.letter && o.body === n.body && o.book_name === n.book_name)) out.push(n); });
    }
    return out.slice(0, 8);
  } catch (e) { return []; }
}

// Recherche par thème dans le texte de la Bible : les versets qui contiennent le plus de mots de la question
async function searchVerses(words) {
  if (!words.length) return [];
  const params = words.map(likeParam);
  const score = params.map((_, i) => `(CASE WHEN ${SQL_FOLD('v.text')} LIKE $${i + 1} THEN 1 ELSE 0 END)`).join('+');
  return (await pool.query(
    `SELECT v.chapter, v.verse, v.text, b.id AS book_id, b.name AS book_name, (${score}) AS score
     FROM bible_verses v JOIN bible_books b ON b.id = v.book_id
     WHERE b.published AND (${score}) >= 1
     ORDER BY score DESC, b.book_order, v.chapter, v.verse LIMIT 8`, params
  )).rows;
}

const wantsExplanation = (q) => /explic|expliq|signifi|veut dire|sens\b|comprend|pourquoi|commentaire|\bnotes?\b|eclair|interpret|enseign|qu'est.ce|c'est quoi|que dit|que veut/.test(fold(q));

// ---------- Livres du site : texte extrait automatiquement, remis à jour à chaque ajout/modification ----------
let bookSchemaReady = null;
function ensureBookSchema() {
  if (!bookSchemaReady) {
    bookSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ai_book_text (
        book_id INTEGER PRIMARY KEY,
        title TEXT,
        signature TEXT,
        content TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).catch((err) => { bookSchemaReady = null; throw err; });
  }
  return bookSchemaReady;
}

let syncing = false;
async function syncBooks() {
  if (syncing) return;
  syncing = true;
  try {
    await ensureBookSchema();
    // Les livres à vendre et les livres verrouillés ne sont jamais donnés à l'assistant
    const books = (await pool.query(
      `SELECT id, title, access_type, COALESCE(admin_locked,false) AS locked,
              COALESCE(length(docx_data),0) AS dl, COALESCE(length(pdf_data),0) AS pl,
              COALESCE(docx_filename,'') AS df, COALESCE(pdf_filename,'') AS pf
       FROM books`
    )).rows;
    const known = new Map((await pool.query('SELECT book_id, signature FROM ai_book_text')).rows.map((r) => [r.book_id, r.signature]));
    const alive = new Set();
    for (const b of books) {
      const eligible = b.access_type !== 'a_vendre' && !b.locked && (b.dl > 0 || b.pl > 0);
      if (!eligible) continue;
      alive.add(b.id);
      const sig = [b.dl, b.pl, b.df, b.pf, b.title].join('|');
      if (known.get(b.id) === sig) continue;
      try {
        const src = (await pool.query('SELECT docx_data, pdf_data FROM books WHERE id=$1', [b.id])).rows[0];
        let text = '';
        if (src.docx_data) text = (await mammoth.extractRawText({ buffer: src.docx_data })).value;
        if (!text.trim() && src.pdf_data) text = (await pdfParse(src.pdf_data)).text;
        text = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        await pool.query(
          `INSERT INTO ai_book_text (book_id, title, signature, content, updated_at) VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (book_id) DO UPDATE SET title=EXCLUDED.title, signature=EXCLUDED.signature, content=EXCLUDED.content, updated_at=now()`,
          [b.id, b.title, sig, text]
        );
        console.log(`Assistant IA : texte de « ${b.title} » mis à jour (${text.length} caractères)`);
      } catch (err) {
        console.error(`Assistant IA : lecture impossible pour « ${b.title} » :`, err.message);
      }
    }
    // Livres supprimés, passés « à vendre » ou verrouillés : retirés de l'assistant
    for (const id of known.keys()) if (!alive.has(id)) await pool.query('DELETE FROM ai_book_text WHERE book_id=$1', [id]);
  } catch (err) {
    console.error('Assistant IA : synchronisation des livres :', err.message);
  } finally {
    syncing = false;
  }
}
setTimeout(syncBooks, 30 * 1000);
setInterval(syncBooks, 5 * 60 * 1000);

// Meilleurs passages d'un texte pour les mots donnés
function bestWindows(content, words, count, size) {
  const f = fold(content);
  const pos = [];
  words.forEach((w) => { let i = f.indexOf(w); let n = 0; while (i !== -1 && n++ < 400) { pos.push({ i, w }); i = f.indexOf(w, i + w.length); } });
  if (!pos.length) return [];
  pos.sort((a, b) => a.i - b.i);
  const cands = pos.map((p) => {
    const inWin = pos.filter((q) => q.i >= p.i - 200 && q.i < p.i + size - 200);
    return { start: Math.max(0, p.i - 200), score: new Set(inWin.map((q) => q.w)).size * 1000 + inWin.length };
  }).sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cands) {
    if (out.length >= count) break;
    if (out.some((o) => Math.abs(o.start - c.start) < size)) continue;
    out.push(c);
  }
  return out.map((c) => {
    let s = c.start, e = Math.min(content.length, c.start + size);
    const para = content.lastIndexOf('\n', s); if (para !== -1 && s - para < 250) s = para + 1;
    return (s > 0 ? '… ' : '') + content.slice(s, e).trim() + (e < content.length ? ' …' : '');
  });
}

async function searchBooks(words) {
  if (!words.length) return [];
  try {
    await ensureBookSchema();
    const params = words.map(likeParam);
    const score = params.map((_, i) => `(CASE WHEN ${SQL_FOLD('content')} LIKE $${i + 1} THEN 1 ELSE 0 END)`).join('+');
    const top = (await pool.query(
      `SELECT book_id, title, (${score}) AS score FROM ai_book_text WHERE (${score}) >= 1 ORDER BY score DESC LIMIT 3`, params
    )).rows;
    const out = [];
    for (const t of top) {
      const content = (await pool.query('SELECT content FROM ai_book_text WHERE book_id=$1', [t.book_id])).rows[0].content;
      bestWindows(content, words, 2, 1600).forEach((w) => out.push({ title: t.title, content: w }));
    }
    return out;
  } catch (e) { return []; }
}

// Base de connaissances ajoutée à la main par l'administrateur (résumés, extraits…)
async function retrieveContext(question, previousUserQuestion) {
  const searchText = question.split(/\s+/).length < 8 && previousUserQuestion ? previousUserQuestion + ' ' + question : question;
  const words = searchText.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 3);
  if (!words.length) return [];

  const rows = (await pool.query('SELECT title, content FROM ai_knowledge')).rows;
  const scored = rows.map(row => {
    const normalized = (row.title + ' ' + row.content).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const score = words.reduce((acc, w) => acc + (normalized.includes(w) ? 1 : 0), 0);
    return { ...row, score };
  });
  return scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

// Prépare tout ce que l'assistant doit savoir pour cette question : versets, notes, livres
async function buildContext(question, previousUserQuestion) {
  const short = question.split(/\s+/).length < 8 && previousUserQuestion;
  const searchText = short ? previousUserQuestion + ' ' + question : question;
  const safe = (p) => p.catch((e) => { console.error('Assistant IA :', e.message); return []; });

  // Références : d'abord celles de la question ; sinon, pour une question courte, celles de la précédente
  let refs = await safe(findReferences(question));
  if (!refs.length && short) refs = await safe(findReferences(previousUserQuestion));
  const refData = await Promise.all(refs.map((r) => safe(fetchReference(r)).then((x) => (Array.isArray(x) ? null : x))));
  const words = keywords(searchText);
  const [hits, bookExcerpts, knowledge] = await Promise.all([
    refs.length ? [] : safe(searchVerses(keywords(question).length ? keywords(question) : words)),
    safe(searchBooks(words)),
    safe(retrieveContext(question, previousUserQuestion)),
  ]);

  const parts = [];
  const sources = [];
  const bibleLines = [];
  const noteTargets = [];
  refData.filter(Boolean).forEach((d) => {
    const r = d.ref;
    if (!d.rows.length) {
      bibleLines.push(`(${refLabel(r.book.name, r.chapter, r.vs, r.ve)} : ce passage n'est pas encore en ligne dans la Parole pure.)`);
      return;
    }
    const first = d.rows[0].verse, last = d.rows[d.rows.length - 1].verse;
    d.rows.forEach((v) => bibleLines.push(`${r.book.name} ${r.chapter}:${v.verse} — ${v.text}`));
    if (d.truncated) bibleLines.push(`(La suite du chapitre n'est pas reprise ici.)`);
    sources.push('Bible Parole pure : ' + refLabel(r.book.name, r.chapter, first, last));
    noteTargets.push({ book_id: r.book.id, chapter: r.chapter, from: r.vs ? r.vs : first, to: r.vs ? (r.ve || r.vs) : last });
  });
  if (!refs.length && hits.length) {
    hits.forEach((v) => bibleLines.push(`${v.book_name} ${v.chapter}:${v.verse} — ${v.text}`));
    sources.push('Bible Parole pure : ' + hits.slice(0, 3).map((v) => `${v.book_name} ${v.chapter}:${v.verse}`).join(', '));
    hits.slice(0, 3).forEach((v) => noteTargets.push({ book_id: v.book_id, chapter: v.chapter, from: v.verse, to: v.verse }));
  }
  if (bibleLines.length) {
    parts.push('VERSETS DE LA BIBLE PAROLE PURE (texte exact de la Bible du site, à citer sans rien modifier) :\n' + bibleLines.join('\n'));
    if (wantsExplanation(question)) {
      const notes = await fetchNotes(noteTargets);
      if (notes.length) {
        parts.push('NOTES EXPLICATIVES DE LA PAROLE PURE (à n\'utiliser que parce que la question demande une explication) :\n' + notes.map((n) => {
          const where = n.verse_end ? `${n.book_name} ${n.chapter}, v. ${n.verse_start && n.verse_start !== n.verse_end ? n.verse_start + '-' : ''}${n.verse_end}` : `${n.book_name} ${n.chapter}`;
          return `- ${where}${n.letter ? ' (note ' + n.letter + ')' : ''}${n.title ? ' — ' + n.title : ''} : ${String(n.body).slice(0, 900)}`;
        }).join('\n'));
        sources.push('Notes explicatives de la Parole pure');
      }
    }
  } else if (!refs.length) {
    parts.push('(Aucun verset de la Parole pure ne correspond à cette question parmi ceux déjà en ligne.)');
  }
  const book = [...bookExcerpts, ...knowledge];
  if (book.length) {
    parts.push('EXTRAITS DES LIVRES DU MINISTÈRE :\n' + book.map((c) => `--- ${c.title} ---\n${c.content}`).join('\n\n'));
    [...new Set(book.map((c) => c.title))].forEach((t) => sources.push(t));
  }
  return { text: parts.join('\n\n'), sources };
}

// Demande la réponse à l'IA et la poursuit automatiquement tant qu'elle est coupée par la limite de longueur :
// la réponse arrive toujours jusqu'au bout, quelle que soit sa longueur.
async function callMistral(msgs) {
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: 'mistral-small-latest', max_tokens: 4000, temperature: 0.2, messages: msgs }),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

async function generateFull(messages) {
  let text = '';
  for (let round = 0; round < 6; round++) {
    let r;
    if (round === 0) {
      r = await callMistral(messages);
    } else {
      // Poursuite : l'IA reprend exactement là où elle s'est arrêtée
      r = await callMistral([...messages, { role: 'assistant', content: text, prefix: true }]);
      if (!r.ok) {
        r = await callMistral([...messages, { role: 'assistant', content: text },
          { role: 'user', content: 'Ta réponse a été interrompue. Continue exactement là où tu t\'es arrêté, sans rien répéter ni reformuler de ce qui précède, jusqu\'à la fin de ta réponse.' }]);
        if (r.ok) { const p = r.data.choices?.[0]?.message?.content || ''; text += (/\s$/.test(text) || /^[\s.,;:!?)]/.test(p) ? '' : ' ') + p; if (r.data.choices?.[0]?.finish_reason !== 'length') break; continue; }
      }
    }
    if (!r.ok) {
      if (text) break; // on garde ce qui a déjà été écrit
      throw new Error(r.data.message || r.data.error?.message || 'Erreur de l\'assistant');
    }
    const choice = r.data.choices?.[0];
    text += choice?.message?.content || '';
    if (!choice || choice.finish_reason !== 'length') break;
  }
  return text;
}

// Liste des conversations du lecteur
router.get('/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, updated_at FROM ai_conversations WHERE user_id=$1 ORDER BY updated_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Crée une nouvelle conversation
router.post('/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      "INSERT INTO ai_conversations (user_id, title) VALUES ($1,'Nouvelle discussion') RETURNING id, title, updated_at",
      [req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Détail d'une conversation avec tous ses messages
router.get('/conversations/:id', async (req, res) => {
  try {
    const convo = (await pool.query('SELECT * FROM ai_conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!convo) return res.status(404).json({ message: 'Conversation introuvable' });
    const messages = (await pool.query('SELECT id, role, content, created_at FROM ai_messages WHERE conversation_id=$1 ORDER BY id', [req.params.id])).rows;
    res.json({ conversation: convo, messages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Supprime une conversation
router.delete('/conversations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Pose une question dans une conversation existante (garde le contexte complet de l'échange)
router.post('/conversations/:id/ask', async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ message: 'Question vide' });
  if (!process.env.MISTRAL_API_KEY) {
    return res.status(503).json({ message: 'L\'assistant n\'est pas encore configuré (clé API manquante).' });
  }
  try {
    const convo = (await pool.query('SELECT * FROM ai_conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!convo) return res.status(404).json({ message: 'Conversation introuvable' });

    const priorMessages = (await pool.query(
      'SELECT role, content FROM ai_messages WHERE conversation_id=$1 ORDER BY id', [convo.id]
    )).rows;

    await pool.query('INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,$2,$3)', [convo.id, 'user', question]);

    const lastUser = [...priorMessages].reverse().find(m => m.role === 'user');
    const context = await buildContext(question, lastUser ? lastUser.content : null);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...priorMessages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: `Éléments disponibles pour cette question :\n\n${context.text}\n\nQuestion du lecteur : ${question}` },
    ];

    let generated;
    try {
      generated = await generateFull(messages);
    } catch (e) {
      return res.status(502).json({ message: e.message || 'Erreur de l\'assistant' });
    }
    const answer = cleanAnswer(generated) || 'Désolé, je n\'ai pas pu répondre.';

    await pool.query('INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,$2,$3)', [convo.id, 'assistant', answer]);

    // Titre automatique basé sur la première question, si c'est la première réponse
    if (priorMessages.length === 0) {
      const title = question.length > 60 ? question.slice(0, 57) + '…' : question;
      await pool.query('UPDATE ai_conversations SET title=$1, updated_at=now() WHERE id=$2', [title, convo.id]);
    } else {
      await pool.query('UPDATE ai_conversations SET updated_at=now() WHERE id=$1', [convo.id]);
    }

    res.json({ answer, sources: context.sources });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
