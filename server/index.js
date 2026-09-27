require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const studyRoutes = require('./routes/study');
const messagesRoutes = require('./routes/messages');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Vérifie que le serveur et la base de données répondent
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connectee' });
  } catch (err) {
    res.status(500).json({ status: 'erreur', database: 'non connectee', message: err.message });
  }
});

// Liste publique des livres du catalogue (hors espace d'étude)
app.get('/api/books', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, author, description, cover_url, access_type, price, has_audio FROM books WHERE is_study_book = false ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Sert l'image de couverture d'un livre
app.get('/api/books/:id/cover', async (req, res) => {
  try {
    const result = await pool.query('SELECT cover_data, cover_mime FROM books WHERE id = $1', [req.params.id]);
    const book = result.rows[0];
    if (!book || !book.cover_data) return res.status(404).end();
    res.setHeader('Content-Type', book.cover_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(book.cover_data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Sert le PDF d'un livre pour lecture en ligne (dans le navigateur, sans téléchargement forcé)
app.get('/api/books/:id/read', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT title, pdf_data, pdf_filename, access_type FROM books WHERE id = $1 AND access_type != 'a_vendre'",
      [req.params.id]
    );
    const book = result.rows[0];
    if (!book || !book.pdf_data) {
      return res.status(404).json({ message: 'Fichier non disponible' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${book.pdf_filename || 'livre.pdf'}"`);
    res.send(book.pdf_data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Télécharge le PDF d'un livre (uniquement si autorisé par l'administrateur)
app.get('/api/books/:id/download', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT title, pdf_data, pdf_filename FROM books WHERE id = $1 AND access_type = 'telechargeable'",
      [req.params.id]
    );
    const book = result.rows[0];
    if (!book || !book.pdf_data) {
      return res.status(404).json({ message: 'Téléchargement non disponible pour ce livre' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${book.pdf_filename || 'livre.pdf'}"`);
    res.send(book.pdf_data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/study', studyRoutes);
app.use('/api/messages', messagesRoutes);

app.listen(PORT, () => {
  console.log(`Grande Bibliothèque numérique MNA — serveur démarré sur le port ${PORT}`);
});
