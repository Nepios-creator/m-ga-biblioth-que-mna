const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, JWT_SECRET } = require('../lib/auth-middleware');

// Le code QR est facultatif : si la bibliothèque n'est pas installée, le brevet est quand même généré (sans QR)
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { console.warn('Module "qrcode" absent : les brevets seront générés sans code QR.'); }

const router = express.Router();

const PASS_THRESHOLD = 0.7; // 70% pour réussir un test
const PART_QUIZ_SIZE = 10;  // questions posées à chaque petit test
const GRAND_QUIZ_SIZE = 40; // questions posées au grand test final

// ---------- Colonnes supplémentaires (créées automatiquement, une seule fois) ----------
// certificate_code : code unique du brevet (celui du code QR) — final_score : pourcentage du grand test réussi
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS certificate_code TEXT;
        ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS final_score INTEGER;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_progress_certificate_code ON user_progress(certificate_code) WHERE certificate_code IS NOT NULL;
      `);
      // Brevets déjà délivrés avant cette mise à jour : on leur attribue un code et un pourcentage
      await pool.query(`
        UPDATE user_progress
           SET certificate_code = 'MNA-' || upper(substr(md5(random()::text || user_id::text || book_id::text), 1, 10))
         WHERE certificate_issued = true AND certificate_code IS NULL;
        UPDATE user_progress up
           SET final_score = sub.best
          FROM (SELECT user_id, book_id, MAX(score) AS best FROM quiz_attempts WHERE part_id IS NULL AND passed = true GROUP BY user_id, book_id) sub
         WHERE sub.user_id = up.user_id AND sub.book_id = up.book_id AND up.certificate_issued = true AND up.final_score IS NULL;
      `);
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
ensureSchema().catch((err) => console.error('Mise à jour de la base (brevets) :', err.message));

function newCertificateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères qui se ressemblent (0/O, 1/I)
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) code += alphabet[bytes[i] % alphabet.length];
  return 'MNA-' + code;
}

const idsOf = (session) => (Array.isArray(session.question_ids) ? session.question_ids : JSON.parse(session.question_ids));

// Compare les réponses du lecteur aux bonnes réponses ; renvoie le score et la correction des erreurs
function gradeQuiz(questions, orderedIds, answers) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  let correct = 0;
  const wrong = [];
  orderedIds.forEach((id) => {
    const q = byId.get(id);
    if (!q) return;
    const chosen = answers && answers[q.id] !== undefined ? Number(answers[q.id]) : -1;
    if (chosen === q.correct_choice_index) correct++;
    else wrong.push({ id: q.id, question_text: q.question_text, choices: q.choices, your_answer: chosen, correct_answer: q.correct_choice_index });
  });
  const total = questions.length;
  const score = total ? correct / total : 1;
  return { correct, total, score, wrong };
}

// Génère un lien de lecture à durée limitée (10 min) pour une partie — permet d'ouvrir le PDF
// dans un nouvel onglet (le navigateur mobile gère mal les PDF affichés en iframe avec jeton d'en-tête)
router.get('/parts/:partId/read-link', requireAuth, async (req, res) => {
  try {
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    const readToken = jwt.sign({ userId: req.user.id, partId: part.id, purpose: 'part-read' }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ url: `/api/study/parts/${part.id}/read?token=${readToken}` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// S'assure qu'un user_progress existe pour ce livre, et le crée déverrouillé si c'est le tout premier livre de l'espace d'étude
async function ensureProgress(userId, bookId) {
  const book = (await pool.query('SELECT admin_locked FROM books WHERE id=$1', [bookId])).rows[0];
  const unlocked = !(book && book.admin_locked); // le bouton de l'administrateur est la seule autorité, dans les deux sens

  const existing = await pool.query('SELECT * FROM user_progress WHERE user_id=$1 AND book_id=$2', [userId, bookId]);
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return { ...row, unlocked };
  }

  const created = await pool.query(
    'INSERT INTO user_progress (user_id, book_id, unlocked, current_part_index, unlocked_at) VALUES ($1,$2,$3,1,$4) RETURNING *',
    [userId, bookId, unlocked, unlocked ? new Date() : null]
  );
  return { ...created.rows[0], unlocked };
}

// Liste des livres de l'espace d'étude avec statut de déverrouillage pour le lecteur connecté
router.get('/books', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const books = (await pool.query('SELECT * FROM books WHERE is_study_book=true ORDER BY order_index ASC NULLS LAST, id ASC')).rows;
    const result = [];
    for (const book of books) {
      const progress = await ensureProgress(req.user.id, book.id);
      const totalParts = (await pool.query('SELECT COUNT(*) FROM book_parts WHERE book_id=$1', [book.id])).rows[0].count;
      result.push({
        id: book.id, title: book.title, author: book.author, description: book.description,
        unlocked: progress.unlocked,
        current_part_index: progress.current_part_index,
        total_parts: Number(totalParts),
        grand_test_passed: progress.grand_test_passed,
        certificate_issued: progress.certificate_issued,
        final_score: progress.final_score,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Détail d'un livre : ses parties avec leur statut verrouillé/déverrouillé
router.get('/books/:id', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const book = (await pool.query('SELECT * FROM books WHERE id=$1 AND is_study_book=true', [req.params.id])).rows[0];
    if (!book) return res.status(404).json({ message: 'Livre introuvable' });
    const progress = await ensureProgress(req.user.id, book.id);
    if (!progress.unlocked) return res.status(403).json({ message: 'Ce livre n\'est pas encore déverrouillé' });

    const parts = (await pool.query('SELECT id, part_index, title, page_start, page_end FROM book_parts WHERE book_id=$1 ORDER BY part_index', [book.id])).rows;
    const readRows = (await pool.query('SELECT part_id FROM part_reads WHERE user_id=$1', [req.user.id])).rows;
    const readIds = new Set(readRows.map(r => r.part_id));
    const passedRows = (await pool.query(
      'SELECT DISTINCT part_id FROM quiz_attempts WHERE user_id=$1 AND book_id=$2 AND part_id IS NOT NULL AND passed=true', [req.user.id, book.id]
    )).rows;
    const passedIds = new Set(passedRows.map(r => r.part_id));
    const partsWithStatus = parts.map(p => ({
      ...p,
      unlocked: p.part_index <= progress.current_part_index,
      has_read: readIds.has(p.id),
      // test réussi : soit une tentative réussie est enregistrée, soit la partie suivante est déjà ouverte
      quiz_passed: passedIds.has(p.id) || p.part_index < progress.current_part_index,
    }));
    const allPartsDone = progress.current_part_index > parts.length;

    res.json({
      book: { id: book.id, title: book.title, author: book.author, description: book.description },
      progress: {
        current_part_index: progress.current_part_index,
        grand_test_passed: progress.grand_test_passed,
        certificate_issued: progress.certificate_issued,
        final_score: progress.final_score,
      },
      parts: partsWithStatus,
      all_parts_done: allPartsDone,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Contenu (résumé + pages à lire) d'une partie, si déverrouillée
router.get('/parts/:partId', requireAuth, async (req, res) => {
  try {
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    res.json(part);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Sert UNIQUEMENT les pages de cette partie (extraites du PDF complet) — empêche de lire la suite du livre
router.get('/parts/:partId/read', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(401).json({ message: 'Connexion requise' });
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ message: 'Lien expiré, veuillez recharger la page' });
    }
    if (decoded.purpose !== 'part-read' || String(decoded.partId) !== String(req.params.partId)) {
      return res.status(401).json({ message: 'Lien invalide' });
    }
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(decoded.userId, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    const book = (await pool.query('SELECT pdf_data FROM books WHERE id=$1', [part.book_id])).rows[0];
    if (!book || !book.pdf_data) return res.status(404).json({ message: 'Fichier non disponible' });

    const srcDoc = await PDFLibDocument.load(book.pdf_data);
    const totalPages = srcDoc.getPageCount();
    const startIdx = Math.max(0, (part.page_start || 1) - 1);
    const endIdx = Math.min(totalPages - 1, (part.page_end || totalPages) - 1);
    const indices = [];
    for (let i = startIdx; i <= endIdx; i++) indices.push(i);

    const newDoc = await PDFLibDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, indices);
    copiedPages.forEach(p => newDoc.addPage(p));
    const bytes = await newDoc.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="partie.pdf"');
    res.send(Buffer.from(bytes));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Lien à durée limitée pour télécharger le brevet (nécessaire car un lien ouvert dans un nouvel onglet ne peut pas transmettre le jeton de connexion)
router.get('/books/:id/certificate-link', requireAuth, (req, res) => {
  const token = jwt.sign({ userId: req.user.id, bookId: req.params.id, purpose: 'certificate' }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ url: `/api/study/books/${req.params.id}/certificate?token=${token}` });
});

// Découpe le nom et centre le texte à une position verticale donnée (page sans marge : positions absolues)
function centered(doc, text, y, size, color, font, extra) {
  doc.font(font || 'Helvetica').fontSize(size).fillColor(color);
  doc.text(text, 0, y, Object.assign({ width: doc.page.width, align: 'center', lineBreak: false }, extra || {}));
}

router.get('/books/:id/certificate', async (req, res) => {
  try {
    await ensureSchema();
    let userId = req.user && req.user.id;
    if (!userId && req.query.token) {
      try {
        const decoded = jwt.verify(req.query.token, JWT_SECRET);
        if (decoded.purpose === 'certificate' && String(decoded.bookId) === String(req.params.id)) userId = decoded.userId;
      } catch (e) { /* jeton invalide, userId reste vide */ }
    }
    if (!userId) return res.status(401).json({ message: 'Connexion requise' });
    let progress = (await pool.query('SELECT * FROM user_progress WHERE user_id=$1 AND book_id=$2', [userId, req.params.id])).rows[0];
    if (!progress || !progress.certificate_issued) {
      return res.status(403).json({ message: 'Le brevet n\'est pas encore disponible pour ce livre' });
    }
    // Le code de vérification est créé une seule fois et ne change plus : le code QR reste valable
    if (!progress.certificate_code) {
      const updated = await pool.query(
        'UPDATE user_progress SET certificate_code=$1 WHERE user_id=$2 AND book_id=$3 AND certificate_code IS NULL RETURNING *',
        [newCertificateCode(), userId, req.params.id]
      );
      progress = updated.rows[0] || (await pool.query('SELECT * FROM user_progress WHERE user_id=$1 AND book_id=$2', [userId, req.params.id])).rows[0];
    }
    const book = (await pool.query('SELECT title FROM books WHERE id=$1', [req.params.id])).rows[0];
    const certUser = (await pool.query('SELECT email, full_name FROM users WHERE id=$1', [userId])).rows[0];

    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const verifyUrl = `${proto}://${req.get('host')}/verification.html?code=${encodeURIComponent(progress.certificate_code)}`;
    let qrBuffer = null;
    if (QRCode) {
      try { qrBuffer = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' }); } catch (e) { qrBuffer = null; }
    }

    const name = (certUser.full_name || certUser.email || '').trim();
    const dateText = new Date(progress.completed_at || new Date()).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="brevet.pdf"');

    // margin 0 : tout est placé à des positions précises (le texte ne risque plus d'être repoussé hors de la page)
    const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 0 });
    doc.pipe(res);
    const W = doc.page.width, H = doc.page.height;

    // Fond crème
    doc.rect(0, 0, W, H).fill('#faf6ee');

    // Filigrane discret, en diagonale, sur tout le fond
    doc.save();
    doc.rotate(-30, { origin: [W / 2, H / 2] });
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#c9a24b').opacity(0.07);
    for (let y = -250; y < H + 350; y += 80) {
      for (let x = -300; x < W + 350; x += 330) {
        doc.text('MINISTÈRE DE LA NOUVELLE ALLIANCE', x, y, { lineBreak: false });
      }
    }
    doc.restore();
    doc.opacity(1);

    // Double bordure dorée
    doc.rect(20, 20, W - 40, H - 40).lineWidth(2).stroke('#c9a24b');
    doc.rect(27, 27, W - 54, H - 54).lineWidth(0.75).stroke('#c9a24b');

    // Contenu
    centered(doc, 'MINISTÈRE DE LA NOUVELLE ALLIANCE', 58, 12, '#6b5f4d', 'Helvetica-Bold', { characterSpacing: 2 });
    centered(doc, 'ESPACE D\'ÉTUDE', 76, 9, '#a89a7e', 'Helvetica', { characterSpacing: 3 });
    centered(doc, 'BREVET DE RÉUSSITE', 108, 36, '#241e16', 'Helvetica-Bold', { characterSpacing: 1 });
    doc.moveTo(W / 2 - 60, 160).lineTo(W / 2 + 60, 160).lineWidth(1).stroke('#c9a24b');
    centered(doc, 'Ce brevet est décerné à', 180, 14, '#6b5f4d', 'Helvetica');

    // Nom : la taille diminue si le nom est long, pour qu'il tienne toujours sur une ligne
    let nameSize = 30;
    doc.font('Helvetica-Bold').fontSize(nameSize);
    while (nameSize > 14 && doc.widthOfString(name) > W - 160) { nameSize -= 1; doc.fontSize(nameSize); }
    centered(doc, name, 208, nameSize, '#1f5386', 'Helvetica-Bold');
    doc.moveTo(W / 2 - 190, 208 + nameSize + 8).lineTo(W / 2 + 190, 208 + nameSize + 8).lineWidth(0.5).stroke('#c9a24b');

    centered(doc, 'pour avoir achevé avec succès l\'étude du livre', 270, 14, '#6b5f4d', 'Helvetica');
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#241e16');
    doc.text(book.title, 90, 298, { width: W - 180, align: 'center', height: 56, ellipsis: true });

    if (progress.final_score !== null && progress.final_score !== undefined) {
      centered(doc, `avec un résultat de ${progress.final_score} %`, 366, 17, '#1f5386', 'Helvetica-Bold');
    }
    centered(doc, `Délivré le ${dateText}`, 400, 11, '#6b5f4d', 'Helvetica');

    // Pied de page : code QR de vérification (à gauche) et signature (à droite)
    const footY = 440;
    if (qrBuffer) {
      doc.image(qrBuffer, 62, footY, { width: 92 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#6b5f4d').text('Vérifier l\'authenticité', 164, footY + 14, { lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor('#a89a7e').text('Scannez ce code QR', 164, footY + 28, { lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor('#a89a7e').text(`Code : ${progress.certificate_code}`, 164, footY + 41, { lineBreak: false });
    } else {
      doc.font('Helvetica').fontSize(8.5).fillColor('#a89a7e').text(`Code de vérification : ${progress.certificate_code}`, 62, footY + 40, { lineBreak: false });
    }
    doc.moveTo(W - 290, footY + 52).lineTo(W - 70, footY + 52).lineWidth(0.5).stroke('#6b5f4d');
    doc.font('Helvetica').fontSize(10).fillColor('#6b5f4d').text('Le Ministère de la Nouvelle Alliance', W - 290, footY + 60, { width: 220, align: 'center', lineBreak: false });

    doc.end();
  } catch (err) {
    if (res.headersSent) { res.destroy(); } else { res.status(500).json({ message: err.message }); }
  }
});

// ---------- Annotations (surlignages, commentaires, favoris) ----------


router.use(requireAuth);

// ---------- Administration : base des participants et vérification des brevets ----------
// Réservé aux administrateurs. La page /verification.html (ouverte par le code QR) utilise ces deux routes.

router.get('/admin/participants', requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    const participants = (await pool.query(`
      SELECT u.id, u.full_name, u.email,
             (SELECT COUNT(*) FROM part_reads pr WHERE pr.user_id = u.id) AS parts_read,
             (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.user_id = u.id) AS attempts,
             (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.user_id = u.id AND qa.passed = true) AS passed_attempts,
             (SELECT COUNT(*) FROM user_progress up WHERE up.user_id = u.id AND up.certificate_issued = true) AS certificates
        FROM users u
       WHERE u.id IN (
         SELECT user_id FROM part_reads
         UNION SELECT user_id FROM quiz_attempts
         UNION SELECT user_id FROM user_progress WHERE certificate_issued = true
       )
       ORDER BY certificates DESC, parts_read DESC, u.full_name ASC
    `)).rows.map((r) => ({
      id: r.id, full_name: r.full_name, email: r.email,
      parts_read: Number(r.parts_read), attempts: Number(r.attempts), passed_attempts: Number(r.passed_attempts), certificates: Number(r.certificates),
    }));

    const certificates = (await pool.query(`
      SELECT up.certificate_code AS code, up.final_score, up.completed_at, u.full_name, u.email, b.title AS book_title
        FROM user_progress up
        JOIN users u ON u.id = up.user_id
        JOIN books b ON b.id = up.book_id
       WHERE up.certificate_issued = true
       ORDER BY up.completed_at DESC NULLS LAST
    `)).rows;

    res.json({ participants, certificates });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/admin/certificates/:code', requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    const row = (await pool.query(`
      SELECT up.certificate_code AS code, up.final_score, up.completed_at, u.full_name, u.email, b.title AS book_title
        FROM user_progress up
        JOIN users u ON u.id = up.user_id
        JOIN books b ON b.id = up.book_id
       WHERE up.certificate_issued = true AND upper(up.certificate_code) = upper($1)
    `, [req.params.code])).rows[0];
    if (!row) return res.status(404).json({ valid: false, message: 'Aucun brevet ne correspond à ce code' });
    res.json({ valid: true, certificate: row });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Marque une partie comme lue — condition requise avant de pouvoir passer son test
router.post('/parts/:partId/mark-read', async (req, res) => {
  try {
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    await pool.query(
      'INSERT INTO part_reads (user_id, part_id) VALUES ($1,$2) ON CONFLICT (user_id, part_id) DO NOTHING',
      [req.user.id, part.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Un test déjà réussi n'est plus accessible
async function partQuizAlreadyPassed(userId, part, progress) {
  if (part.part_index < progress.current_part_index) return true;
  const r = await pool.query('SELECT 1 FROM quiz_attempts WHERE user_id=$1 AND part_id=$2 AND passed=true LIMIT 1', [userId, part.id]);
  return r.rows.length > 0;
}

// Questions du petit test d'une partie (sans révéler la bonne réponse)
router.get('/parts/:partId/quiz', async (req, res) => {
  try {
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    if (await partQuizAlreadyPassed(req.user.id, part, progress)) {
      return res.status(403).json({ message: 'Vous avez déjà réussi le test de cette partie : il n\'est plus accessible.' });
    }
    const hasRead = (await pool.query('SELECT 1 FROM part_reads WHERE user_id=$1 AND part_id=$2', [req.user.id, part.id])).rows.length > 0;
    if (!hasRead) {
      return res.status(403).json({ message: 'Vous devez d\'abord terminer la lecture de cette partie' });
    }
    // Tirage au sort de 10 questions dans la réserve de la partie — différent à chaque tentative et pour chaque lecteur
    const questions = (await pool.query(
      'SELECT id, question_text, choices FROM quiz_questions WHERE part_id=$1 ORDER BY random() LIMIT $2', [part.id, PART_QUIZ_SIZE]
    )).rows;
    if (!questions.length) return res.status(503).json({ message: 'Les questions de ce test sont en cours de préparation. Réessayez dans quelques minutes.' });
    const session = (await pool.query(
      'INSERT INTO quiz_sessions (user_id, book_id, part_id, question_ids) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.user.id, part.book_id, part.id, JSON.stringify(questions.map(q => q.id))]
    )).rows[0];
    res.json({ session_id: session.id, questions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Soumission du petit test d'une partie
router.post('/parts/:partId/quiz', async (req, res) => {
  const { answers } = req.body; // { questionId: choiceIndex, ... }
  try {
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    if (await partQuizAlreadyPassed(req.user.id, part, progress)) {
      return res.status(403).json({ message: 'Vous avez déjà réussi le test de cette partie : il n\'est plus accessible.' });
    }
    const hasRead = (await pool.query('SELECT 1 FROM part_reads WHERE user_id=$1 AND part_id=$2', [req.user.id, part.id])).rows.length > 0;
    if (!hasRead) {
      return res.status(403).json({ message: 'Vous devez d\'abord terminer la lecture de cette partie' });
    }
    const session = (await pool.query(
      'SELECT * FROM quiz_sessions WHERE id=$1 AND user_id=$2 AND part_id=$3 AND used=false', [req.body.session_id, req.user.id, part.id]
    )).rows[0];
    if (!session) return res.status(400).json({ message: 'Ce test a expiré ou a déjà été soumis. Rouvrez le test pour obtenir de nouvelles questions.' });
    await pool.query('UPDATE quiz_sessions SET used=true WHERE id=$1', [session.id]);
    const ids = idsOf(session);
    const questions = (await pool.query('SELECT id, question_text, choices, correct_choice_index FROM quiz_questions WHERE id = ANY($1::int[])', [ids])).rows;
    if (!questions.length) return res.status(400).json({ message: 'Ce test n\'est plus valide. Rouvrez le test pour obtenir de nouvelles questions.' });
    const { correct, total, score, wrong } = gradeQuiz(questions, ids, answers);
    const passed = score >= PASS_THRESHOLD;

    await pool.query(
      'INSERT INTO quiz_attempts (user_id, book_id, part_id, passed, score) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, part.book_id, part.id, passed, Math.round(score * 100)]
    );

    if (passed) {
      await pool.query(
        'UPDATE user_progress SET current_part_index = GREATEST(current_part_index, $1) WHERE user_id=$2 AND book_id=$3',
        [part.part_index + 1, req.user.id, part.book_id]
      );
    }
    res.json({ passed, score: Math.round(score * 100), correct, total, wrong });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Questions du grand test final (sur tout le livre)
router.get('/books/:id/grand-quiz', async (req, res) => {
  try {
    const progress = await ensureProgress(req.user.id, req.params.id);
    const totalParts = Number((await pool.query('SELECT COUNT(*) FROM book_parts WHERE book_id=$1', [req.params.id])).rows[0].count);
    if (!progress.unlocked || progress.current_part_index <= totalParts) {
      return res.status(403).json({ message: 'Terminez d\'abord toutes les parties du livre' });
    }
    if (progress.grand_test_passed) {
      return res.status(403).json({ message: 'Vous avez déjà réussi le grand test de ce livre : il n\'est plus accessible.' });
    }
    // Tirage au sort de 40 questions dans la grande réserve du livre
    const questions = (await pool.query(
      'SELECT id, question_text, choices FROM quiz_questions WHERE book_id=$1 AND part_id IS NULL ORDER BY random() LIMIT $2', [req.params.id, GRAND_QUIZ_SIZE]
    )).rows;
    if (!questions.length) return res.status(503).json({ message: 'Les questions de ce test sont en cours de préparation. Réessayez dans quelques minutes.' });
    const session = (await pool.query(
      'INSERT INTO quiz_sessions (user_id, book_id, part_id, question_ids) VALUES ($1,$2,NULL,$3) RETURNING id',
      [req.user.id, req.params.id, JSON.stringify(questions.map(q => q.id))]
    )).rows[0];
    res.json({ session_id: session.id, questions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Soumission du grand test final — réussite = brevet + déverrouillage du livre suivant
router.post('/books/:id/grand-quiz', async (req, res) => {
  const { answers } = req.body;
  try {
    await ensureSchema();
    const bookId = req.params.id;
    const progress = await ensureProgress(req.user.id, bookId);
    const totalParts = Number((await pool.query('SELECT COUNT(*) FROM book_parts WHERE book_id=$1', [bookId])).rows[0].count);
    if (!progress.unlocked || progress.current_part_index <= totalParts) {
      return res.status(403).json({ message: 'Terminez d\'abord toutes les parties du livre' });
    }
    if (progress.grand_test_passed) {
      return res.status(403).json({ message: 'Vous avez déjà réussi le grand test de ce livre : il n\'est plus accessible.' });
    }
    const session = (await pool.query(
      'SELECT * FROM quiz_sessions WHERE id=$1 AND user_id=$2 AND book_id=$3 AND part_id IS NULL AND used=false', [req.body.session_id, req.user.id, bookId]
    )).rows[0];
    if (!session) return res.status(400).json({ message: 'Ce test a expiré ou a déjà été soumis. Rouvrez le test pour obtenir de nouvelles questions.' });
    await pool.query('UPDATE quiz_sessions SET used=true WHERE id=$1', [session.id]);
    const ids = idsOf(session);
    const questions = (await pool.query('SELECT id, question_text, choices, correct_choice_index FROM quiz_questions WHERE id = ANY($1::int[])', [ids])).rows;
    if (!questions.length) return res.status(400).json({ message: 'Ce test n\'est plus valide. Rouvrez le test pour obtenir de nouvelles questions.' });
    const { correct, total, score, wrong } = gradeQuiz(questions, ids, answers);
    const passed = score >= PASS_THRESHOLD;
    const percent = Math.round(score * 100);

    await pool.query(
      'INSERT INTO quiz_attempts (user_id, book_id, part_id, passed, score) VALUES ($1,$2,NULL,$3,$4)',
      [req.user.id, bookId, passed, percent]
    );

    if (passed) {
      // Brevet : pourcentage obtenu + code unique de vérification (celui du code QR)
      await pool.query(
        `UPDATE user_progress
            SET grand_test_passed=true, certificate_issued=true, completed_at=now(), final_score=$3,
                certificate_code=COALESCE(certificate_code, $4)
          WHERE user_id=$1 AND book_id=$2`,
        [req.user.id, bookId, percent, newCertificateCode()]
      );
      // Déverrouille automatiquement le livre suivant de l'espace d'étude, s'il existe
      // (l'administrateur garde la main : il peut le reverrouiller à tout moment avec son bouton)
      const currentBook = (await pool.query('SELECT order_index FROM books WHERE id=$1', [bookId])).rows[0];
      await pool.query(
        `UPDATE books SET admin_locked = false WHERE id = (
           SELECT id FROM books WHERE is_study_book = true AND order_index > $1 ORDER BY order_index ASC LIMIT 1
         )`,
        [currentBook.order_index || 0]
      );
    }
    res.json({ passed, score: percent, correct, total, wrong });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/parts/:partId/annotations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, page_number, quote_text, note, type, created_at FROM study_annotations WHERE user_id=$1 AND part_id=$2 ORDER BY page_number, id',
      [req.user.id, req.params.partId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/parts/:partId/annotations', async (req, res) => {
  const { page_number, quote_text, note, type } = req.body;
  const allowed = ['highlight', 'note', 'favorite'];
  if (!allowed.includes(type)) return res.status(400).json({ message: 'Type invalide' });
  try {
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    const result = await pool.query(
      'INSERT INTO study_annotations (user_id, part_id, page_number, quote_text, note, type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, part.id, page_number || null, quote_text || null, note || null, type]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/annotations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM study_annotations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Position de lecture (reprise) ----------

router.get('/parts/:partId/position', async (req, res) => {
  try {
    const row = (await pool.query(
      'SELECT page_number, updated_at FROM reading_positions WHERE user_id=$1 AND part_id=$2',
      [req.user.id, req.params.partId]
    )).rows[0];
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/parts/:partId/position', async (req, res) => {
  const { page_number } = req.body;
  if (!page_number) return res.status(400).json({ message: 'Page requise' });
  try {
    await pool.query(
      `INSERT INTO reading_positions (user_id, part_id, page_number, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (user_id, part_id) DO UPDATE SET page_number=$3, updated_at=now()`,
      [req.user.id, req.params.partId, page_number]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
