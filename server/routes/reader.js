const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth-middleware');
const { docxToParagraphs } = require('../lib/docx-to-text');

const router = express.Router();
router.use(requireAuth);

// Petite mémoire pour ne pas relire le fichier Word à chaque ouverture
const paragraphsCache = new Map();

async function getReadableBook(id) {
  const result = await pool.query(
    "SELECT id, title, author, docx_data, is_study_book FROM books WHERE id = $1 AND access_type != 'a_vendre'",
    [id]
  );
  return result.rows[0] || null;
}

// Texte du livre, découpé en paragraphes, pour le lecteur intégré
router.get('/books/:id', async (req, res) => {
  try {
    const book = await getReadableBook(req.params.id);
    if (!book) return res.status(404).json({ message: 'Livre introuvable' });
    if (book.is_study_book) {
      return res.status(403).json({ message: 'Ce livre fait partie de l\'espace d\'étude : lisez-le depuis l\'espace d\'étude.' });
    }
    if (!book.docx_data) {
      return res.status(409).json({ message: 'Ce livre est disponible uniquement en PDF', fallback: 'pdf' });
    }
    const key = `${book.id}:${book.docx_data.length}`;
    let paragraphs = paragraphsCache.get(key);
    if (!paragraphs) {
      paragraphs = await docxToParagraphs(book.docx_data);
      if (!paragraphs) {
        return res.status(409).json({ message: 'Le texte de ce livre est illisible', fallback: 'pdf' });
      }
      if (paragraphsCache.size >= 20) paragraphsCache.delete(paragraphsCache.keys().next().value);
      paragraphsCache.set(key, paragraphs);
    }
    res.json({ book: { id: book.id, title: book.title, author: book.author }, paragraphs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Annotations (surlignages, commentaires, favoris) ----------

router.get('/books/:id/annotations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, page_number, quote_text, note, type, created_at FROM book_annotations WHERE user_id=$1 AND book_id=$2 ORDER BY page_number, id',
      [req.user.id, req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/books/:id/annotations', async (req, res) => {
  const { page_number, quote_text, note, type } = req.body;
  const allowed = ['highlight', 'note', 'favorite'];
  if (!allowed.includes(type)) return res.status(400).json({ message: 'Type invalide' });
  try {
    const book = await getReadableBook(req.params.id);
    if (!book) return res.status(404).json({ message: 'Livre introuvable' });
    const result = await pool.query(
      'INSERT INTO book_annotations (user_id, book_id, page_number, quote_text, note, type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, page_number, quote_text, note, type, created_at',
      [req.user.id, book.id, page_number || null, quote_text || null, note || null, type]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/annotations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM book_annotations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Position de lecture (reprise) ----------

router.get('/books/:id/position', async (req, res) => {
  try {
    const row = (await pool.query(
      'SELECT page_number, updated_at FROM book_reading_positions WHERE user_id=$1 AND book_id=$2',
      [req.user.id, req.params.id]
    )).rows[0];
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/books/:id/position', async (req, res) => {
  const { page_number } = req.body;
  if (!page_number) return res.status(400).json({ message: 'Page requise' });
  try {
    await pool.query(
      `INSERT INTO book_reading_positions (user_id, book_id, page_number, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (user_id, book_id) DO UPDATE SET page_number=$3, updated_at=now()`,
      [req.user.id, req.params.id, page_number]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
