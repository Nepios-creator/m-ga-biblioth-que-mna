require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('./db/pool');
const { requireAuth, JWT_SECRET } = require('./lib/auth-middleware');
const jwt = require('jsonwebtoken');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const studyRoutes = require('./routes/study');
const messagesRoutes = require('./routes/messages');
const assistantRoutes = require('./routes/assistant');
const readerRoutes = require('./routes/reader');
const bibleRoutes = require('./routes/bible');
const biblePrefaceRoutes = require('./routes/bible-preface');
const audioRoutes = require('./routes/audio');
const statsRoutes = require('./routes/stats');
const membersRoutes = require('./routes/members');
const adminsRoutes = require('./routes/admins');
const { router: quotesRoutes, autoGenerateMissingQuotes } = require('./routes/quotes');
const { fillMissingPartContent, autoSplitStudyBooks } = require('./lib/fill-part-content');
const { autoGenerateQuizzes } = require('./lib/generate-quizzes');
const { docxToHtml } = require('./lib/docx-to-html');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Page d'accueil : « Bibliothèque numérique » est remplacé par la phrase animée « Partout avec vous ».
// Le reste de la page (Ministère de la Nouvelle Alliance, contenu, images) n'est pas modifié.
const HOME_FILE = path.join(__dirname, '..', 'public', 'index.html');
const TAGLINE_STYLE = '<style>' +
  '.hero h1 .mna-tagline{display:block;margin-top:.35em;font-size:.62em;font-weight:600;letter-spacing:.04em;' +
  'background:linear-gradient(100deg,#b8893a 0%,#f6e3a8 30%,#c9a24b 50%,#f6e3a8 70%,#b8893a 100%);background-size:200% 100%;' +
  '-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;' +
  'animation:mnaFadeUp 1.1s ease both,mnaShimmer 3.2s ease-in-out 1.1s infinite alternate;}' +
  '@keyframes mnaFadeUp{from{opacity:0;transform:translateY(14px);letter-spacing:.22em}to{opacity:1;transform:none;letter-spacing:.04em}}' +
  '@keyframes mnaShimmer{from{background-position:0% 50%}to{background-position:100% 50%}}' +
  '@media (prefers-reduced-motion:reduce){.hero h1 .mna-tagline{animation:none;background:none;-webkit-text-fill-color:#c9a24b;color:#c9a24b;}}' +
  '</style>';

function buildHome(html) {
  return html
    .replace('<meta property="og:title" content="Ministère de la Nouvelle Alliance — Bibliothèque numérique">',
             '<meta property="og:title" content="Ministère de la Nouvelle Alliance — Partout avec vous">')
    .replace('<title>Ministère de la Nouvelle Alliance — Bibliothèque numérique</title>',
             '<title>Ministère de la Nouvelle Alliance — Partout avec vous</title>')
    .replace('<h1>La bibliothèque numérique du Ministère de la Nouvelle Alliance</h1>',
             '<h1>Ministère de la Nouvelle Alliance<span class="mna-tagline">Partout avec vous</span></h1>')
    .replace('Cette bibliothèque numérique en est l\'une des expressions.',
             'Cette plateforme numérique en est l\'une des expressions.')
    .replace('<div>Grande Bibliothèque numérique MNA — © 2026</div>',
             '<div>La plateforme numérique MNA — © 2026</div>')
    .replace('</head>', TAGLINE_STYLE + '</head>');
}

let homeCache = { mtime: 0, html: '' };
app.get(['/', '/index.html'], (req, res, next) => {
  fs.stat(HOME_FILE, (err, st) => {
    if (err) return next();
    if (homeCache.mtime === st.mtimeMs && homeCache.html) {
      return res.type('html').send(homeCache.html);
    }
    fs.readFile(HOME_FILE, 'utf8', (err2, html) => {
      if (err2) return next();
      homeCache = { mtime: st.mtimeMs, html: buildHome(html) };
      res.type('html').send(homeCache.html);
    });
  });
});

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

// Liste des livres du catalogue (hors espace d'étude) — réservé aux membres connectés
app.get('/api/books', requireAuth, async (req, res) => {
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

// Accepte l'authentification soit par en-tête Authorization (appels JS), soit par ?token= (liens/onglets ouverts directement)
function flexAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ message: 'Connexion requise' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ message: 'Session invalide ou expirée' });
  }
}

// Génère un lien de lecture/téléchargement à durée limitée (pour ouvrir dans un nouvel onglet)
app.get('/api/books/:id/read-link', requireAuth, (req, res) => {
  const token = jwt.sign({ id: req.user.id, purpose: 'book-file' }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ readUrl: `/api/books/${req.params.id}/read?token=${token}`, downloadUrl: `/api/books/${req.params.id}/download?token=${token}` });
});

// Sert un livre pour lecture en ligne — réservé aux membres connectés (PDF, ou page de lecture générée depuis le Word si le livre n'a pas de PDF)
app.get('/api/books/:id/read', flexAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT title, pdf_data, pdf_filename, docx_data, access_type, is_study_book FROM books WHERE id = $1 AND access_type != 'a_vendre'",
      [req.params.id]
    );
    const book = result.rows[0];
    if (!book || (!book.pdf_data && !book.docx_data)) {
      return res.status(404).json({ message: 'Fichier non disponible' });
    }
    if (book.is_study_book) {
      return res.status(403).json({ message: 'Ce livre fait partie de l\'espace d\'étude : lisez-le partie par partie depuis /espace-etude.html' });
    }
    if (!book.pdf_data) {
      const html = await docxToHtml(book.docx_data, book.title);
      if (!html) return res.status(404).json({ message: 'Fichier non disponible' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${book.pdf_filename || 'livre.pdf'}"`);
    res.send(book.pdf_data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Télécharge le PDF d'un livre — réservé aux membres connectés
app.get('/api/books/:id/download', flexAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT title, pdf_data, pdf_filename, is_study_book FROM books WHERE id = $1 AND access_type = 'telechargeable'",
      [req.params.id]
    );
    const book = result.rows[0];
    if (!book || !book.pdf_data) {
      return res.status(404).json({ message: 'Téléchargement non disponible pour ce livre' });
    }
    if (book.is_study_book) {
      return res.status(403).json({ message: 'Ce livre fait partie de l\'espace d\'étude et ne peut pas être téléchargé directement' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${book.pdf_filename || 'livre.pdf'}"`);
    res.send(book.pdf_data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.use('/api/auth', authRoutes);
// Comptage anonyme des visites (public) — doit rester avant les routes d'administration
app.use('/api/track', statsRoutes.trackRouter);
// Administration : liste des membres + messages, et statistiques (réservées aux administrateurs)
// — placées avant /api/admin pour être prises en compte en premier
app.use('/api/admin/admins', adminsRoutes);
app.use('/api/admin/members', membersRoutes);
app.use('/api/admin/stats', statsRoutes.adminRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/study', studyRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/reader', readerRoutes);
app.use('/api/bible', bibleRoutes);
app.use('/api/bible-preface', biblePrefaceRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api/quotes', quotesRoutes);

app.listen(PORT, () => {
  console.log(`Grande Bibliothèque numérique MNA — serveur démarré sur le port ${PORT}`);
  // Génère automatiquement les citations manquantes, sans aucune action requise de l'administrateur
  let pipelineRunning = false;
  async function runAutoPipeline() {
    if (pipelineRunning) return; // évite deux exécutions simultanées (la génération des tests peut durer plusieurs minutes)
    pipelineRunning = true;
    try {
      autoGenerateMissingQuotes();
      await autoSplitStudyBooks();
      await fillMissingPartContent();
      await autoGenerateQuizzes();
    } catch (err) {
      console.error('Erreur pipeline automatique :', err.message);
    } finally {
      pipelineRunning = false;
    }
  }
  runAutoPipeline();
  setInterval(runAutoPipeline, 15 * 60 * 1000);
});
