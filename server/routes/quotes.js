const express = require('express');
const pdfParse = require('pdf-parse');
const pool = require('../db/pool');
const { docxToParagraphs } = require('../lib/docx-to-text');

const router = express.Router();

// Version du format des citations : 2 = réflexions pratiques, fidèles au livre, tournées vers la vie
const QUOTES_VERSION = 2;

// Sélection déterministe : une réflexion différente chaque jour, en boucle,
// dans l'ordre des livres (quote_order)
router.get('/today', async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT q.id, q.quote_text, b.title AS book_title
       FROM quotes q JOIN books b ON b.id = q.book_id
       WHERE q.hidden = false
       ORDER BY b.quote_order ASC, q.book_id ASC, q.id ASC`
    )).rows;
    if (!rows.length) return res.json(null);

    const epoch = new Date('2026-01-01T00:00:00Z');
    const daysSinceEpoch = Math.floor((Date.now() - epoch.getTime()) / 86400000);
    const index = ((daysSinceEpoch % rows.length) + rows.length) % rows.length;
    res.json(rows[index]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Génération des réflexions ----------

const CHUNK_SIZE = 9000;   // caractères envoyés à l'IA à chaque appel
const MAX_CHUNKS = 8;      // extraits répartis sur tout le livre
const PER_CHUNK = 3;       // réflexions demandées par extrait
const MIN_REFLECTIONS = 5; // en dessous, on garde les anciennes citations

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Texte brut du livre : le Word est préféré (plus propre), sinon le PDF
async function getBookText(book) {
  if (book.docx_data) {
    try {
      const paragraphs = await docxToParagraphs(book.docx_data);
      if (paragraphs && paragraphs.length) {
        return paragraphs.map((p) => p.replace(/^#{1,2}\s+/, '')).join('\n').replace(/[ \t]+/g, ' ').trim();
      }
    } catch (e) { /* on essaie le PDF */ }
  }
  if (book.pdf_data) {
    const parsed = await pdfParse(book.pdf_data);
    return parsed.text.replace(/\s+/g, ' ').trim();
  }
  return '';
}

// Choisit des extraits répartis sur l'ensemble du livre
function pickChunks(text) {
  if (text.length <= CHUNK_SIZE) return [text];
  const count = Math.min(MAX_CHUNKS, Math.ceil(text.length / CHUNK_SIZE));
  const step = text.length / count;
  const chunks = [];
  for (let i = 0; i < count; i++) {
    let start = Math.floor(i * step);
    if (start > 0) {
      const sp = text.indexOf(' ', start);
      if (sp !== -1 && sp - start < 100) start = sp + 1;
    }
    chunks.push(text.slice(start, start + CHUNK_SIZE));
  }
  return chunks;
}

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Vérifie que le passage d'appui cité par l'IA se trouve bien dans l'extrait (garantit la fidélité au livre)
function isGrounded(appui, normalizedChunk) {
  const a = normalize(appui);
  if (a.split(' ').length < 4) return false;
  if (normalizedChunk.includes(a)) return true;
  const words = a.split(' ');
  let found = 0, total = 0;
  for (let i = 0; i + 4 <= words.length; i++) {
    total++;
    if (normalizedChunk.includes(words.slice(i, i + 4).join(' '))) found++;
  }
  return total > 0 && found / total >= 0.6;
}

async function askMistral(prompt) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        max_tokens: 1800,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    if (response.status === 429 && attempt < 2) { await sleep(6000); continue; }
    if (!response.ok) throw new Error(data.message || data.error?.message || 'Erreur Mistral');
    return data.choices?.[0]?.message?.content || '[]';
  }
  return '[]';
}

function parseJsonArray(raw) {
  raw = raw.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { const parsed = JSON.parse(match[0]); return Array.isArray(parsed) ? parsed : []; } catch (e2) { return []; }
  }
}

function buildPrompt(title, chunk) {
  return `Voici un extrait du livre chrétien « ${title} ».

Ta tâche : rédige ${PER_CHUNK} RÉFLEXIONS pratiques, fidèles à cet extrait, pour aider un lecteur à vivre ce que le livre enseigne.

Chaque réflexion doit :
1. partir d'une vérité RÉELLEMENT exprimée dans l'extrait (fidélité stricte : n'invente aucune doctrine, n'attribue au livre rien qui n'y figure pas) ;
2. montrer comment cette vérité touche concrètement notre vie (relations, décisions, épreuves, famille, travail, vie de foi) ;
3. se terminer par ce que nous pouvons faire, ou par la manière dont nous devons vivre.

Style : 3 à 5 phrases (entre 250 et 500 caractères), ton pastoral, simple et sobre, à la première personne du pluriel (« nous »), compréhensible sans avoir lu le livre. Reformule avec tes propres mots : ne recopie pas les phrases du livre. Ne cite un verset biblique que s'il figure dans l'extrait.

Pour chaque réflexion, ajoute le champ "appui" : un court passage de l'extrait (6 à 25 mots), recopié EXACTEMENT, sur lequel la réflexion s'appuie.

Réponds UNIQUEMENT par un tableau JSON, sans aucun autre texte ni markdown, de la forme :
[{"appui": "passage recopié de l'extrait", "reflexion": "La réflexion pratique."}, ...]

EXTRAIT DU LIVRE :
${chunk}`;
}

async function generateReflectionsForBook(book) {
  const text = await getBookText(book);
  if (!text || text.length < 500) throw new Error('Texte du livre insuffisant');

  const chunks = pickChunks(text);
  const reflections = [];
  const seen = new Set();

  for (const chunk of chunks) {
    try {
      const raw = await askMistral(buildPrompt(book.title, chunk));
      const normalizedChunk = normalize(chunk);
      for (const item of parseJsonArray(raw)) {
        if (!item || typeof item !== 'object') continue;
        const reflexion = String(item.reflexion || '').trim();
        if (reflexion.length < 150 || reflexion.length > 650) continue;
        if (!isGrounded(item.appui || '', normalizedChunk)) continue;
        const key = normalize(reflexion).slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        reflections.push(reflexion);
      }
    } catch (err) {
      console.error(`Extrait ignoré pour "${book.title}" :`, err.message);
    }
    await sleep(1200);
  }

  if (reflections.length < MIN_REFLECTIONS) {
    throw new Error(`Seulement ${reflections.length} réflexion(s) valide(s)`);
  }

  // Remplace d'un coup les anciennes citations par les nouvelles réflexions
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM quotes WHERE book_id = $1', [book.id]);
    for (const r of reflections) {
      await client.query('INSERT INTO quotes (book_id, quote_text) VALUES ($1,$2)', [book.id, r]);
    }
    await client.query('UPDATE books SET quotes_generated_at = now(), quotes_version = $2 WHERE id = $1', [book.id, QUOTES_VERSION]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return reflections.length;
}

// Lance la génération pour tous les livres qui n'ont pas encore leurs réflexions (appelé automatiquement au démarrage
// puis toutes les 15 minutes). Un livre qui échoue 3 fois est laissé de côté jusqu'au prochain redémarrage.
let quotesRunning = false;
const failedAttempts = new Map();

async function autoGenerateMissingQuotes() {
  if (!process.env.MISTRAL_API_KEY || quotesRunning) return;
  quotesRunning = true;
  try {
    const books = (await pool.query(
      `SELECT id, title, pdf_data, docx_data FROM books
       WHERE quotes_version < $1 AND (pdf_data IS NOT NULL OR docx_data IS NOT NULL)
       ORDER BY quote_order ASC, id ASC`,
      [QUOTES_VERSION]
    )).rows;
    for (const book of books) {
      if ((failedAttempts.get(book.id) || 0) >= 3) continue;
      try {
        const n = await generateReflectionsForBook(book);
        console.log(`Réflexions générées pour "${book.title}" : ${n}`);
      } catch (err) {
        failedAttempts.set(book.id, (failedAttempts.get(book.id) || 0) + 1);
        console.error(`Échec génération des réflexions pour "${book.title}" :`, err.message);
      }
    }
  } catch (err) {
    console.error('Erreur autoGenerateMissingQuotes :', err.message);
  } finally {
    quotesRunning = false;
  }
}

module.exports = { router, autoGenerateMissingQuotes };
