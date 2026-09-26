const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../lib/auth-middleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 Mo max

// Toutes les routes ci-dessous exigent d'être connecté ET admin
router.use(requireAuth, requireAdmin);

// Liste de tous les livres (y compris ceux de l'espace d'étude)
router.get('/books', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM books ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Ajouter un livre
router.post('/books', async (req, res) => {
  const {
    title, author, description, cover_url, source_format,
    access_type, price, has_audio, audio_url, is_study_book, order_index,
  } = req.body;
  if (!title) return res.status(400).json({ message: 'Le titre est requis' });
  try {
    const result = await pool.query(
      `INSERT INTO books
        (title, author, description, cover_url, source_format, access_type, price, has_audio, audio_url, is_study_book, order_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        title, author || null, description || null, cover_url || null,
        source_format || null, access_type || 'lecture_en_ligne', price || null,
        !!has_audio, audio_url || null, !!is_study_book, order_index || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Modifier un livre
router.put('/books/:id', async (req, res) => {
  const { id } = req.params;
  const {
    title, author, description, cover_url, source_format,
    access_type, price, has_audio, audio_url, is_study_book, order_index,
  } = req.body;
  try {
    const result = await pool.query(
      `UPDATE books SET
        title=$1, author=$2, description=$3, cover_url=$4, source_format=$5,
        access_type=$6, price=$7, has_audio=$8, audio_url=$9, is_study_book=$10, order_index=$11
       WHERE id=$12 RETURNING *`,
      [
        title, author || null, description || null, cover_url || null,
        source_format || null, access_type || 'lecture_en_ligne', price || null,
        !!has_audio, audio_url || null, !!is_study_book, order_index || null, id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Livre introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Téléverser le fichier PDF d'un livre (remplace le fichier existant s'il y en avait un)
router.post('/books/:id/pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu' });
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ message: 'Le fichier doit être un PDF' });
  }
  try {
    const result = await pool.query(
      'UPDATE books SET pdf_data = $1, pdf_filename = $2 WHERE id = $3 RETURNING id, title',
      [req.file.buffer, req.file.originalname, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Livre introuvable' });
    res.json({ message: 'PDF téléversé avec succès', book: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Supprimer un livre
router.delete('/books/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM books WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
