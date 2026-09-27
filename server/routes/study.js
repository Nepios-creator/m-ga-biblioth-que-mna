const express = require('express');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth-middleware');

const router = express.Router();
router.use(requireAuth);

const PASS_THRESHOLD = 0.7; // 70% pour réussir un test

// S'assure qu'un user_progress existe pour ce livre, et le crée déverrouillé si c'est le tout premier livre de l'espace d'étude
async function ensureProgress(userId, bookId) {
  const existing = await pool.query('SELECT * FROM user_progress WHERE user_id=$1 AND book_id=$2', [userId, bookId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const book = (await pool.query('SELECT order_index FROM books WHERE id=$1', [bookId])).rows[0];
  const isFirstBook = await pool.query(
    'SELECT id FROM books WHERE is_study_book=true AND order_index = (SELECT MIN(order_index) FROM books WHERE is_study_book=true)'
  );
  const unlocked = isFirstBook.rows.some(r => r.id === Number(bookId));

  const created = await pool.query(
    'INSERT INTO user_progress (user_id, book_id, unlocked, current_part_index, unlocked_at) VALUES ($1,$2,$3,1,$4) RETURNING *',
    [userId, bookId, unlocked, unlocked ? new Date() : null]
  );
  return created.rows[0];
}

// Liste des livres de l'espace d'étude avec statut de déverrouillage pour le lecteur connecté
router.get('/books', async (req, res) => {
  try {
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
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Détail d'un livre : ses parties avec leur statut verrouillé/déverrouillé
router.get('/books/:id', async (req, res) => {
  try {
    const book = (await pool.query('SELECT * FROM books WHERE id=$1 AND is_study_book=true', [req.params.id])).rows[0];
    if (!book) return res.status(404).json({ message: 'Livre introuvable' });
    const progress = await ensureProgress(req.user.id, book.id);
    if (!progress.unlocked) return res.status(403).json({ message: 'Ce livre n\'est pas encore déverrouillé' });

    const parts = (await pool.query('SELECT id, part_index, title, page_start, page_end FROM book_parts WHERE book_id=$1 ORDER BY part_index', [book.id])).rows;
    const readRows = (await pool.query('SELECT part_id FROM part_reads WHERE user_id=$1', [req.user.id])).rows;
    const readIds = new Set(readRows.map(r => r.part_id));
    const partsWithStatus = parts.map(p => ({ ...p, unlocked: p.part_index <= progress.current_part_index, has_read: readIds.has(p.id) }));
    const allPartsDone = progress.current_part_index > parts.length;

    res.json({
      book: { id: book.id, title: book.title, author: book.author, description: book.description },
      progress: { current_part_index: progress.current_part_index, grand_test_passed: progress.grand_test_passed, certificate_issued: progress.certificate_issued },
      parts: partsWithStatus,
      all_parts_done: allPartsDone,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Contenu (résumé + pages à lire) d'une partie, si déverrouillée
router.get('/parts/:partId', async (req, res) => {
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
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
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

// Questions du petit test d'une partie (sans révéler la bonne réponse)
router.get('/parts/:partId/quiz', async (req, res) => {
  try {
    const part = (await pool.query('SELECT * FROM book_parts WHERE id=$1', [req.params.partId])).rows[0];
    if (!part) return res.status(404).json({ message: 'Partie introuvable' });
    const progress = await ensureProgress(req.user.id, part.book_id);
    if (!progress.unlocked || part.part_index > progress.current_part_index) {
      return res.status(403).json({ message: 'Cette partie n\'est pas encore déverrouillée' });
    }
    const hasRead = (await pool.query('SELECT 1 FROM part_reads WHERE user_id=$1 AND part_id=$2', [req.user.id, part.id])).rows.length > 0;
    if (!hasRead) {
      return res.status(403).json({ message: 'Vous devez d\'abord terminer la lecture de cette partie' });
    }
    const questions = (await pool.query('SELECT id, question_text, choices FROM quiz_questions WHERE part_id=$1 ORDER BY id', [part.id])).rows;
    res.json(questions);
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
    const hasRead = (await pool.query('SELECT 1 FROM part_reads WHERE user_id=$1 AND part_id=$2', [req.user.id, part.id])).rows.length > 0;
    if (!hasRead) {
      return res.status(403).json({ message: 'Vous devez d\'abord terminer la lecture de cette partie' });
    }
    const questions = (await pool.query('SELECT id, correct_choice_index FROM quiz_questions WHERE part_id=$1', [part.id])).rows;
    let correct = 0;
    questions.forEach(q => { if (answers && answers[q.id] === q.correct_choice_index) correct++; });
    const score = questions.length ? correct / questions.length : 1;
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
    res.json({ passed, score: Math.round(score * 100), correct, total: questions.length });
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
    const questions = (await pool.query('SELECT id, question_text, choices FROM quiz_questions WHERE book_id=$1 AND part_id IS NULL ORDER BY id', [req.params.id])).rows;
    res.json(questions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Soumission du grand test final — réussite = brevet + déverrouillage du livre suivant
router.post('/books/:id/grand-quiz', async (req, res) => {
  const { answers } = req.body;
  try {
    const bookId = req.params.id;
    const progress = await ensureProgress(req.user.id, bookId);
    const totalParts = Number((await pool.query('SELECT COUNT(*) FROM book_parts WHERE book_id=$1', [bookId])).rows[0].count);
    if (!progress.unlocked || progress.current_part_index <= totalParts) {
      return res.status(403).json({ message: 'Terminez d\'abord toutes les parties du livre' });
    }
    const questions = (await pool.query('SELECT id, correct_choice_index FROM quiz_questions WHERE book_id=$1 AND part_id IS NULL', [bookId])).rows;
    let correct = 0;
    questions.forEach(q => { if (answers && answers[q.id] === q.correct_choice_index) correct++; });
    const score = questions.length ? correct / questions.length : 1;
    const passed = score >= PASS_THRESHOLD;

    await pool.query(
      'INSERT INTO quiz_attempts (user_id, book_id, part_id, passed, score) VALUES ($1,$2,NULL,$3,$4)',
      [req.user.id, bookId, passed, Math.round(score * 100)]
    );

    if (passed) {
      await pool.query(
        'UPDATE user_progress SET grand_test_passed=true, certificate_issued=true, completed_at=now() WHERE user_id=$1 AND book_id=$2',
        [req.user.id, bookId]
      );
      // Déverrouille le livre suivant de l'espace d'étude, s'il existe
      const currentBook = (await pool.query('SELECT order_index FROM books WHERE id=$1', [bookId])).rows[0];
      const nextBook = (await pool.query(
        'SELECT id FROM books WHERE is_study_book=true AND order_index > $1 ORDER BY order_index ASC LIMIT 1',
        [currentBook.order_index || 0]
      )).rows[0];
      if (nextBook) {
        await pool.query(
          `INSERT INTO user_progress (user_id, book_id, unlocked, current_part_index, unlocked_at)
           VALUES ($1,$2,true,1,now())
           ON CONFLICT (user_id, book_id) DO UPDATE SET unlocked=true, unlocked_at=now()`,
          [req.user.id, nextBook.id]
        );
      }
    }
    res.json({ passed, score: Math.round(score * 100), correct, total: questions.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Génère et sert le brevet PDF si le grand test a été réussi
router.get('/books/:id/certificate', async (req, res) => {
  try {
    const progress = (await pool.query('SELECT * FROM user_progress WHERE user_id=$1 AND book_id=$2', [req.user.id, req.params.id])).rows[0];
    if (!progress || !progress.certificate_issued) {
      return res.status(403).json({ message: 'Le brevet n\'est pas encore disponible pour ce livre' });
    }
    const book = (await pool.query('SELECT title FROM books WHERE id=$1', [req.params.id])).rows[0];

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="brevet.pdf"`);

    const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(2).stroke('#c9a24b');
    doc.moveDown(3);
    doc.fontSize(12).fillColor('#6b5f4d').text('MINISTÈRE DE LA NOUVELLE ALLIANCE', { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(30).fillColor('#241e16').text('BREVET DE RÉUSSITE', { align: 'center' });
    doc.moveDown(1.5);
    doc.fontSize(14).fillColor('#6b5f4d').text('Ce brevet est décerné à', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(24).fillColor('#1f5386').text(req.user.full_name || req.user.email, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(14).fillColor('#6b5f4d').text('pour avoir achevé avec succès l\'étude du livre', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(18).fillColor('#241e16').text(book.title, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(11).fillColor('#6b5f4d').text(
      `Délivré le ${new Date(progress.completed_at || new Date()).toLocaleDateString('fr-FR')} — Espace d'étude du Ministère de la Nouvelle Alliance`,
      { align: 'center' }
    );

    doc.end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
