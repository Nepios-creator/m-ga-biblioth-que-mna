const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
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
// Verrouille / déverrouille un livre de l'espace d'étude en un clic, sans le supprimer
router.put('/books/:id/lock', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE books SET admin_locked = NOT admin_locked WHERE id=$1 RETURNING id, title, admin_locked',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Livre introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

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

// Téléverser la couverture d'un livre (image)
router.post('/books/:id/cover', upload.single('cover'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu' });
  if (!req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ message: 'Le fichier doit être une image' });
  }
  try {
    const result = await pool.query(
      'UPDATE books SET cover_data = $1, cover_mime = $2 WHERE id = $3 RETURNING id, title',
      [req.file.buffer, req.file.mimetype, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Livre introuvable' });
    res.json({ message: 'Couverture téléversée avec succès', book: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Téléverser le fichier Word structuré d'un livre (utilisé en priorité sur le PDF pour l'espace d'étude — meilleure structure)
router.post('/books/:id/docx', upload.single('docx'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu' });
  try {
    const result = await pool.query(
      'UPDATE books SET docx_data = $1, docx_filename = $2 WHERE id = $3 RETURNING id, title',
      [req.file.buffer, req.file.originalname, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Livre introuvable' });
    await pool.query('UPDATE book_parts SET content_filled = false WHERE book_id = $1', [req.params.id]);
    res.json({ message: 'Word téléversé — le texte structuré sera généré automatiquement dans les minutes qui suivent', book: result.rows[0] });
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

// Voir tous les messages des lecteurs
router.get('/messages', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.email, u.full_name FROM messages m
       JOIN users u ON u.id = m.user_id ORDER BY m.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Répondre à un message
router.put('/messages/:id', async (req, res) => {
  const { reply_body } = req.body;
  if (!reply_body) return res.status(400).json({ message: 'La réponse ne peut pas être vide' });
  try {
    const result = await pool.query(
      "UPDATE messages SET reply_body=$1, status='repondu', replied_at=now() WHERE id=$2 RETURNING *",
      [reply_body, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Message introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Voir toutes les connaissances de l'assistant IA
router.get('/knowledge', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, title, LEFT(content, 120) AS preview, created_at FROM ai_knowledge ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Ajouter une connaissance (résumé, extrait, ou texte d'un livre) pour l'assistant IA
router.post('/knowledge', async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ message: 'Titre et contenu requis' });
  try {
    const result = await pool.query('INSERT INTO ai_knowledge (title, content) VALUES ($1,$2) RETURNING id, title', [title, content]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Nourrir l'assistant IA directement à partir d'un fichier PDF ou Word — extrait le texte et le découpe en morceaux exploitables
router.post('/knowledge/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu' });
  const baseTitle = req.body.title || req.file.originalname.replace(/\.(pdf|docx?)$/i, '');
  try {
    let fullText = '';
    if (req.file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(req.file.buffer);
      fullText = parsed.text;
    } else if (
      req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      req.file.originalname.toLowerCase().endsWith('.docx')
    ) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      fullText = result.value;
    } else {
      return res.status(400).json({ message: 'Format non supporté — utilisez un PDF ou un fichier Word (.docx)' });
    }

    fullText = fullText.replace(/\n{3,}/g, '\n\n').trim();
    if (!fullText) return res.status(400).json({ message: 'Aucun texte n\'a pu être extrait de ce fichier' });

    // Découpe en morceaux d'environ 4000 caractères pour rester exploitable par l'assistant
    const CHUNK_SIZE = 4000;
    const chunks = [];
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      chunks.push(fullText.slice(i, i + CHUNK_SIZE));
    }

    const inserted = [];
    for (let i = 0; i < chunks.length; i++) {
      const title = chunks.length > 1 ? `${baseTitle} (partie ${i + 1}/${chunks.length})` : baseTitle;
      const result = await pool.query('INSERT INTO ai_knowledge (title, content) VALUES ($1,$2) RETURNING id, title', [title, chunks[i]]);
      inserted.push(result.rows[0]);
    }
    res.status(201).json({ message: `${chunks.length} morceau(x) ajouté(s) à la base de connaissances`, items: inserted });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'extraction du texte : ' + err.message });
  }
});

// Supprimer une connaissance
router.delete('/knowledge/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_knowledge WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Relance manuellement la génération de citations pour un livre (utile après ajout d'un nouveau livre)
router.post('/quotes/generate/:bookId', async (req, res) => {
  try {
    await pool.query('UPDATE books SET quotes_generated_at = NULL WHERE id=$1', [req.params.bookId]);
    res.json({ message: 'Génération relancée — les nouvelles citations apparaîtront automatiquement dans les minutes qui suivent.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
