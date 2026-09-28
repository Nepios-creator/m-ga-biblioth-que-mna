const express = require('express');
const pdfParse = require('pdf-parse');
const pool = require('../db/pool');

const router = express.Router();

// Sélection déterministe : une citation différente chaque jour, en boucle,
// dans l'ordre des livres (quote_order), en commençant par "La vraie histoire de Satan"
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

// Extrait le texte d'un livre et en tire de vraies citations via l'IA, fidèlement au texte
async function generateQuotesForBook(book) {
  const parsed = await pdfParse(book.pdf_data);
  let text = parsed.text.replace(/\s+/g, ' ').trim();
  if (text.length > 60000) text = text.slice(0, 60000); // limite raisonnable pour l'appel IA

  const prompt = `Voici le texte intégral (ou un large extrait) d'un livre chrétien intitulé « ${book.title} ».

Ta tâche : relève 12 phrases FIDÈLES au texte ci-dessous — reprises presque mot pour mot, ou très légèrement raccourcies pour être autonomes et compréhensibles hors contexte — qui sont fortes, inspirantes, et représentatives des idées du livre. N'INVENTE RIEN : chaque citation doit correspondre à une idée réellement présente dans le texte fourni.

Réponds UNIQUEMENT avec un tableau JSON de 12 chaînes de caractères, sans aucun autre texte, sans markdown. Exemple de format : ["Première citation.", "Deuxième citation.", ...]

TEXTE DU LIVRE :
${text}`;

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      max_tokens: 1500,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error?.message || 'Erreur Mistral');

  let raw = data.choices?.[0]?.message?.content || '[]';
  raw = raw.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  let quotesArr;
  try {
    quotesArr = JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\[[\s\S]*\]/);
    quotesArr = match ? JSON.parse(match[0]) : [];
  }
  if (!Array.isArray(quotesArr)) return 0;

  let count = 0;
  for (const q of quotesArr) {
    const text = String(q).trim();
    if (text.length > 10 && text.length < 500) {
      await pool.query('INSERT INTO quotes (book_id, quote_text) VALUES ($1,$2)', [book.id, text]);
      count++;
    }
  }
  return count;
}

// Lance la génération pour tous les livres qui n'en ont pas encore (appelé automatiquement au démarrage,
// et disponible pour relance manuelle par l'admin si besoin)
async function autoGenerateMissingQuotes() {
  if (!process.env.MISTRAL_API_KEY) return;
  try {
    const books = (await pool.query(
      "SELECT id, title, pdf_data FROM books WHERE quotes_generated_at IS NULL AND pdf_data IS NOT NULL ORDER BY quote_order ASC"
    )).rows;
    for (const book of books) {
      try {
        const n = await generateQuotesForBook(book);
        await pool.query('UPDATE books SET quotes_generated_at = now() WHERE id=$1', [book.id]);
        console.log(`Citations générées pour "${book.title}" : ${n}`);
      } catch (err) {
        console.error(`Échec génération citations pour "${book.title}" :`, err.message);
      }
    }
  } catch (err) {
    console.error('Erreur autoGenerateMissingQuotes :', err.message);
  }
}

module.exports = { router, autoGenerateMissingQuotes };
