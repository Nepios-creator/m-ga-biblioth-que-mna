// École Biblique Kainos (EBK) — cours, tests automatiques, grand test, certificat sécurisé et administration.
// Les tables sont créées automatiquement au démarrage : aucune action manuelle sur la base de données.
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, JWT_SECRET } = require('../lib/auth-middleware');

let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { console.warn('[ebk] module "qrcode" absent : certificats sans code QR'); }
let multer = null;
try { multer = require('multer'); } catch (e) { console.warn('[ebk] module "multer" absent : import de syllabus indisponible'); }

const router = express.Router();
router.use(express.json({ limit: '3mb' }));

const PASS_THRESHOLD = 0.7;   // 70 % pour réussir un test (comme l'espace d'étude)
const COURSE_QUIZ_SIZE = 15;  // test de chaque cours
const GRAND_QUIZ_SIZE = 80;   // grand test final
const POOL_TARGET = 45;       // réserve de questions générées par cours

const DEFAULT_SETTINGS = { about: '', contact: '', sig1: 'Signature', sig2: 'Signature' };

// ---------- Base de données ----------
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ebk_sessions (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          period_label TEXT,
          status TEXT NOT NULL DEFAULT 'a_venir',
          description TEXT,
          registration_open BOOLEAN NOT NULL DEFAULT false,
          classroom_open BOOLEAN NOT NULL DEFAULT false,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS ebk_courses (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES ebk_sessions(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL,
          teacher TEXT,
          description TEXT,
          youtube_url TEXT,
          syllabus_text TEXT,
          syllabus_url TEXT,
          syllabus_file BYTEA,
          syllabus_filename TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS ebk_questions (
          id SERIAL PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES ebk_courses(id) ON DELETE CASCADE,
          question_text TEXT NOT NULL,
          choices JSONB NOT NULL,
          correct_choice_index INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'manuel'
        );
        CREATE TABLE IF NOT EXISTS ebk_students (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id INTEGER NOT NULL REFERENCES ebk_sessions(id) ON DELETE CASCADE,
          full_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, session_id)
        );
        CREATE TABLE IF NOT EXISTS ebk_attempts (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id INTEGER NOT NULL REFERENCES ebk_sessions(id) ON DELETE CASCADE,
          course_id INTEGER REFERENCES ebk_courses(id) ON DELETE CASCADE,
          passed BOOLEAN NOT NULL,
          score INTEGER,
          attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS ebk_quiz_sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id INTEGER NOT NULL REFERENCES ebk_sessions(id) ON DELETE CASCADE,
          course_id INTEGER,
          question_ids JSONB NOT NULL,
          used BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS ebk_certificates (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id INTEGER NOT NULL REFERENCES ebk_sessions(id) ON DELETE CASCADE,
          full_name TEXT NOT NULL,
          code TEXT UNIQUE NOT NULL,
          score INTEGER,
          issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, session_id)
        );
        CREATE TABLE IF NOT EXISTS ebk_settings (key TEXT PRIMARY KEY, value TEXT);
      `);
      const n = (await pool.query('SELECT COUNT(*)::int AS n FROM ebk_sessions')).rows[0].n;
      if (!n) {
        await pool.query(
          `INSERT INTO ebk_sessions (title, period_label, status, description, registration_open, classroom_open, position) VALUES
           ('Session 1', 'Juillet 2026', 'terminee', 'Première session de l''École Biblique Kainos. Les cours sont disponibles en ligne.', true, true, 1),
           ('Session 2', 'Juillet 2027', 'a_venir', 'Prochaine session de l''École Biblique Kainos.', false, false, 2)`
        );
      }
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
ensureSchema().catch((err) => console.error('[ebk] base de données :', err.message));

router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (err) { res.status(503).json({ message: 'L\'espace EBK est momentanément indisponible.' }); }
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[ebk]', err.message);
  if (!res.headersSent) res.status(500).json({ message: err.message });
});

// ---------- Outils ----------
async function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  (await pool.query('SELECT key, value FROM ebk_settings')).rows.forEach((r) => { if (r.key in DEFAULT_SETTINGS) s[r.key] = r.value; });
  return s;
}
const openSession = async () => (await pool.query('SELECT * FROM ebk_sessions WHERE classroom_open ORDER BY position, id LIMIT 1')).rows[0] || null;
const coursesOf = async (sid) => (await pool.query('SELECT id, position, title, teacher, description, youtube_url, syllabus_url, (syllabus_file IS NOT NULL) AS has_file, (COALESCE(length(syllabus_text),0) > 0) AS has_text FROM ebk_courses WHERE session_id=$1 ORDER BY position, id', [sid])).rows;
async function passedSet(userId, sid) {
  const r = await pool.query('SELECT DISTINCT course_id FROM ebk_attempts WHERE user_id=$1 AND session_id=$2 AND course_id IS NOT NULL AND passed=true', [userId, sid]);
  return new Set(r.rows.map((x) => x.course_id));
}
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) code += alphabet[bytes[i] % alphabet.length];
  return 'EBK-' + code;
}
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim();

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
  const total = orderedIds.length;
  return { correct, total, score: total ? correct / total : 0, wrong };
}

// ---------- Public ----------
router.get('/info', wrap(async (req, res) => {
  const sessions = (await pool.query('SELECT id, title, period_label, status, description, registration_open, classroom_open FROM ebk_sessions ORDER BY position, id')).rows;
  const courses = (await pool.query('SELECT id, session_id, position, title, teacher, description FROM ebk_courses ORDER BY position, id')).rows;
  res.json({ settings: await getSettings(), sessions: sessions.map((s) => ({ ...s, courses: courses.filter((c) => c.session_id === s.id) })) });
}));

// Vérification d'un certificat (page ouverte par le code QR) — n'expose que le nom, la session, la date et le résultat
router.get('/verify/:code', wrap(async (req, res) => {
  const r = (await pool.query(
    `SELECT c.code, c.full_name, c.score, c.issued_at, s.title, s.period_label
       FROM ebk_certificates c JOIN ebk_sessions s ON s.id = c.session_id
      WHERE upper(c.code) = upper($1)`, [String(req.params.code || '').trim()]
  )).rows[0];
  if (!r) return res.status(404).json({ valid: false, message: 'Aucun certificat ne correspond à ce code.' });
  res.json({ valid: true, certificate: r });
}));

// ---------- Certificat PDF (lien à durée limitée, comme les brevets de l'espace d'étude) ----------
function centered(doc, text, y, size, color, font, extra) {
  doc.font(font || 'Helvetica').fontSize(size).fillColor(color);
  doc.text(text, 0, y, Object.assign({ width: doc.page.width, align: 'center', lineBreak: false }, extra || {}));
}

router.get('/certificate', wrap(async (req, res) => {
  let decoded;
  try { decoded = jwt.verify(String(req.query.token || ''), JWT_SECRET); } catch (e) { return res.status(401).json({ message: 'Lien expiré, rechargez la page.' }); }
  if (decoded.purpose !== 'ebk-certificate') return res.status(401).json({ message: 'Lien invalide' });
  const cert = (await pool.query('SELECT * FROM ebk_certificates WHERE user_id=$1 AND session_id=$2', [decoded.userId, decoded.sessionId])).rows[0];
  if (!cert) return res.status(403).json({ message: 'Le certificat n\'est pas encore disponible.' });
  const session = (await pool.query('SELECT title, period_label FROM ebk_sessions WHERE id=$1', [cert.session_id])).rows[0];
  const nbCourses = (await pool.query('SELECT COUNT(*)::int AS n FROM ebk_courses WHERE session_id=$1', [cert.session_id])).rows[0].n;
  const settings = await getSettings();

  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const verifyUrl = `${proto}://${req.get('host')}/ebk-verification.html?code=${encodeURIComponent(cert.code)}`;
  let qr = null;
  if (QRCode) { try { qr = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' }); } catch (e) { qr = null; } }
  const dateText = new Date(cert.issued_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="certificat-ebk.pdf"');
  const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 0 });
  doc.pipe(res);
  const W = doc.page.width, H = doc.page.height;
  const GOLD = '#c9a24b', NAVY = '#14263f', BLUE = '#1f3a5f', SOFT = '#6b5f4d';

  doc.rect(0, 0, W, H).fill('#faf6ee');
  // Filigrane de sécurité
  doc.save();
  doc.rotate(-30, { origin: [W / 2, H / 2] });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(GOLD).opacity(0.07);
  for (let y = -250; y < H + 350; y += 80) for (let x = -300; x < W + 350; x += 300) doc.text('ÉCOLE BIBLIQUE KAINOS', x, y, { lineBreak: false });
  doc.restore();
  doc.opacity(1);
  // Double bordure
  doc.rect(20, 20, W - 40, H - 40).lineWidth(2).stroke(GOLD);
  doc.rect(27, 27, W - 54, H - 54).lineWidth(0.75).stroke(GOLD);

  centered(doc, 'ÉCOLE BIBLIQUE KAINOS', 56, 24, NAVY, 'Helvetica-Bold', { characterSpacing: 3 });
  centered(doc, 'Former des serviteurs puissants en parole et en œuvre', 88, 11, SOFT, 'Helvetica-Oblique');
  centered(doc, 'CERTIFICAT DE FORMATION', 122, 32, NAVY, 'Helvetica-Bold', { characterSpacing: 1 });
  doc.moveTo(W / 2 - 60, 172).lineTo(W / 2 + 60, 172).lineWidth(1).stroke(GOLD);
  centered(doc, 'Ce certificat est décerné à', 190, 14, SOFT, 'Helvetica');

  const name = cert.full_name;
  let nameSize = 32;
  doc.font('Helvetica-Bold').fontSize(nameSize);
  while (nameSize > 14 && doc.widthOfString(name) > W - 160) { nameSize -= 1; doc.fontSize(nameSize); }
  centered(doc, name, 216, nameSize, BLUE, 'Helvetica-Bold');
  doc.moveTo(W / 2 - 200, 216 + nameSize + 8).lineTo(W / 2 + 200, 216 + nameSize + 8).lineWidth(0.5).stroke(GOLD);

  centered(doc, `pour avoir suivi et réussi les ${nbCourses} cours de la formation`, 278, 14, SOFT, 'Helvetica');
  centered(doc, `${session.title}${session.period_label ? ' — ' + session.period_label : ''}`, 302, 20, NAVY, 'Helvetica-Bold');
  if (cert.score !== null && cert.score !== undefined) centered(doc, `Résultat du grand test final : ${cert.score} %`, 340, 15, BLUE, 'Helvetica-Bold');
  centered(doc, `Délivré le ${dateText}`, 370, 11, SOFT, 'Helvetica');

  // Pied de page : code QR à gauche, deux espaces de signature à droite
  const footY = 430;
  if (qr) {
    doc.image(qr, 62, footY, { width: 92 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(SOFT).text('Vérifier l\'authenticité', 164, footY + 24, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#a89a7e').text('Scannez ce code QR', 164, footY + 38, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#a89a7e').text(`Code : ${cert.code}`, 164, footY + 51, { lineBreak: false });
  } else {
    doc.font('Helvetica').fontSize(8.5).fillColor('#a89a7e').text(`Code de vérification : ${cert.code}`, 62, footY + 50, { lineBreak: false });
  }
  const lineY = footY + 78;
  [[330, settings.sig1], [585, settings.sig2]].forEach(([x, label]) => {
    doc.moveTo(x, lineY).lineTo(x + 190, lineY).lineWidth(0.6).stroke(SOFT);
    doc.font('Helvetica').fontSize(10).fillColor(SOFT).text(label || 'Signature', x, lineY + 7, { width: 190, align: 'center', lineBreak: false });
  });
  doc.end();
}));

// Fichier du syllabus (lien à durée limitée, délivré uniquement aux étudiants ayant accès au cours)
router.get('/syllabus-file/:id', wrap(async (req, res) => {
  let d;
  try { d = jwt.verify(String(req.query.token || ''), JWT_SECRET); } catch (e) { return res.status(401).json({ message: 'Lien expiré' }); }
  if (d.purpose !== 'ebk-syllabus' || String(d.courseId) !== String(req.params.id)) return res.status(401).json({ message: 'Lien invalide' });
  const c = (await pool.query('SELECT syllabus_file, syllabus_filename FROM ebk_courses WHERE id=$1', [req.params.id])).rows[0];
  if (!c || !c.syllabus_file) return res.status(404).json({ message: 'Fichier non disponible' });
  const isPdf = /\.pdf$/i.test(c.syllabus_filename || '');
  res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `${isPdf ? 'inline' : 'attachment'}; filename="${(c.syllabus_filename || 'syllabus').replace(/"/g, '')}"`);
  res.send(c.syllabus_file);
}));

// ---------- Espace étudiant (connexion requise) ----------
router.use(requireAuth);

async function studentState(userId) {
  const session = await openSession();
  if (!session) return { session: null };
  const out = {
    session: { id: session.id, title: session.title, period_label: session.period_label, registration_open: session.registration_open },
    student: null, courses: [], all_passed: false, certificate: null,
  };
  const student = (await pool.query('SELECT full_name FROM ebk_students WHERE user_id=$1 AND session_id=$2', [userId, session.id])).rows[0];
  if (!student) return out;
  out.student = { full_name: student.full_name };
  const courses = await coursesOf(session.id);
  const passed = await passedSet(userId, session.id);
  out.courses = courses.map((c, i) => ({
    id: c.id, position: i + 1, title: c.title, teacher: c.teacher, description: c.description,
    passed: passed.has(c.id), unlocked: i === 0 || passed.has(courses[i - 1].id),
  }));
  out.all_passed = courses.length > 0 && courses.every((c) => passed.has(c.id));
  out.certificate = (await pool.query('SELECT code, score, issued_at FROM ebk_certificates WHERE user_id=$1 AND session_id=$2', [userId, session.id])).rows[0] || null;
  out.grand_quiz_size = GRAND_QUIZ_SIZE;
  out.course_quiz_size = COURSE_QUIZ_SIZE;
  return out;
}

router.get('/me', wrap(async (req, res) => res.json(await studentState(req.user.id))));

// Inscription : le nom complet saisi ici figurera sur le certificat
router.post('/enroll', wrap(async (req, res) => {
  const name = cleanName(req.body.full_name);
  if (name.length < 5 || !name.includes(' ')) return res.status(400).json({ message: 'Écrivez votre nom complet (prénom et nom), tel qu\'il doit figurer sur le certificat.' });
  if (name.length > 120) return res.status(400).json({ message: 'Nom trop long.' });
  const session = await openSession();
  if (!session) return res.status(404).json({ message: 'Aucune session n\'est ouverte pour le moment.' });
  const existing = (await pool.query('SELECT id FROM ebk_students WHERE user_id=$1 AND session_id=$2', [req.user.id, session.id])).rows[0];
  if (existing) return res.status(409).json({ message: 'Vous êtes déjà inscrit.' });
  if (!session.registration_open) return res.status(403).json({ message: 'Les inscriptions sont fermées pour le moment.' });
  await pool.query('INSERT INTO ebk_students (user_id, session_id, full_name) VALUES ($1,$2,$3)', [req.user.id, session.id, name]);
  res.status(201).json(await studentState(req.user.id));
}));

// Correction du nom — impossible une fois le certificat délivré
router.put('/name', wrap(async (req, res) => {
  const name = cleanName(req.body.full_name);
  if (name.length < 5 || !name.includes(' ') || name.length > 120) return res.status(400).json({ message: 'Écrivez votre nom complet (prénom et nom).' });
  const session = await openSession();
  if (!session) return res.status(404).json({ message: 'Aucune session ouverte.' });
  const cert = (await pool.query('SELECT 1 FROM ebk_certificates WHERE user_id=$1 AND session_id=$2', [req.user.id, session.id])).rows[0];
  if (cert) return res.status(403).json({ message: 'Votre certificat est déjà délivré : le nom ne peut plus être modifié.' });
  await pool.query('UPDATE ebk_students SET full_name=$3 WHERE user_id=$1 AND session_id=$2', [req.user.id, session.id, name]);
  res.json(await studentState(req.user.id));
}));

// Charge un cours si l'étudiant y a droit ; répond lui-même en cas de refus
async function accessCourse(req, res) {
  const course = (await pool.query('SELECT * FROM ebk_courses WHERE id=$1', [req.params.id])).rows[0];
  if (!course) { res.status(404).json({ message: 'Cours introuvable' }); return null; }
  const session = await openSession();
  if (!session || session.id !== course.session_id) { res.status(403).json({ message: 'Ce cours n\'est pas ouvert.' }); return null; }
  const student = (await pool.query('SELECT 1 FROM ebk_students WHERE user_id=$1 AND session_id=$2', [req.user.id, session.id])).rows[0];
  if (!student) { res.status(403).json({ message: 'Inscrivez-vous d\'abord à la salle de classe.' }); return null; }
  const courses = await coursesOf(session.id);
  const idx = courses.findIndex((c) => c.id === course.id);
  const passed = await passedSet(req.user.id, session.id);
  if (idx > 0 && !passed.has(courses[idx - 1].id)) { res.status(403).json({ message: 'Réussissez d\'abord le test du cours précédent.' }); return null; }
  return { course, session, courses, idx, passed: passed.has(course.id) };
}

router.get('/courses/:id', wrap(async (req, res) => {
  const a = await accessCourse(req, res);
  if (!a) return;
  const c = a.course;
  const next = a.courses[a.idx + 1];
  res.json({
    id: c.id, position: a.idx + 1, total: a.courses.length, title: c.title, teacher: c.teacher, description: c.description,
    youtube_url: c.youtube_url, syllabus_text: c.syllabus_text, syllabus_url: c.syllabus_url,
    has_file: !!c.syllabus_file, file_name: c.syllabus_filename, passed: a.passed, next_course_id: a.passed && next ? next.id : null,
  });
}));

// Lien à durée limitée pour ouvrir le fichier du syllabus dans un nouvel onglet
router.get('/courses/:id/syllabus-link', wrap(async (req, res) => {
  const a = await accessCourse(req, res);
  if (!a) return;
  const t = jwt.sign({ courseId: a.course.id, userId: req.user.id, purpose: 'ebk-syllabus' }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ url: `/api/ebk/syllabus-file/${a.course.id}?token=${t}` });
}));

router.get('/courses/:id/quiz', wrap(async (req, res) => {
  const a = await accessCourse(req, res);
  if (!a) return;
  if (a.passed) return res.status(403).json({ message: 'Vous avez déjà réussi ce test.' });
  const questions = (await pool.query('SELECT id, question_text, choices FROM ebk_questions WHERE course_id=$1 ORDER BY random() LIMIT $2', [a.course.id, COURSE_QUIZ_SIZE])).rows;
  if (!questions.length) return res.status(503).json({ message: 'Les questions de ce test sont en cours de préparation. Réessayez plus tard.' });
  const s = (await pool.query(
    'INSERT INTO ebk_quiz_sessions (user_id, session_id, course_id, question_ids) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.user.id, a.session.id, a.course.id, JSON.stringify(questions.map((q) => q.id))]
  )).rows[0];
  res.json({ session_id: s.id, questions });
}));

router.post('/courses/:id/quiz', wrap(async (req, res) => {
  const a = await accessCourse(req, res);
  if (!a) return;
  if (a.passed) return res.status(403).json({ message: 'Vous avez déjà réussi ce test.' });
  const s = (await pool.query(
    'UPDATE ebk_quiz_sessions SET used=true WHERE id=$1 AND user_id=$2 AND course_id=$3 AND used=false RETURNING *',
    [req.body.session_id, req.user.id, a.course.id]
  )).rows[0];
  if (!s) return res.status(400).json({ message: 'Ce test a expiré ou a déjà été soumis. Rouvrez le test pour obtenir de nouvelles questions.' });
  const ids = s.question_ids;
  const questions = (await pool.query('SELECT id, question_text, choices, correct_choice_index FROM ebk_questions WHERE id = ANY($1::int[])', [ids])).rows;
  const { correct, total, score, wrong } = gradeQuiz(questions, ids, req.body.answers);
  const passed = score >= PASS_THRESHOLD;
  const percent = Math.round(score * 100);
  await pool.query('INSERT INTO ebk_attempts (user_id, session_id, course_id, passed, score) VALUES ($1,$2,$3,$4,$5)', [req.user.id, a.session.id, a.course.id, passed, percent]);
  const next = a.courses[a.idx + 1];
  res.json({ passed, score: percent, correct, total, wrong, next_course_id: passed && next ? next.id : null });
}));

// Grand test : tirage équilibré entre tous les cours de la session
router.get('/grand-quiz', wrap(async (req, res) => {
  const st = await studentState(req.user.id);
  if (!st.student) return res.status(403).json({ message: 'Inscrivez-vous d\'abord.' });
  if (!st.all_passed) return res.status(403).json({ message: 'Réussissez d\'abord les tests de tous les cours.' });
  if (st.certificate) return res.status(403).json({ message: 'Vous avez déjà réussi le grand test.' });
  const rows = (await pool.query(
    'SELECT q.id, q.course_id, q.question_text, q.choices FROM ebk_questions q JOIN ebk_courses c ON c.id = q.course_id WHERE c.session_id=$1', [st.session.id]
  )).rows;
  const byCourse = {};
  shuffle(rows).forEach((q) => { (byCourse[q.course_id] = byCourse[q.course_id] || []).push(q); });
  const lists = Object.values(byCourse);
  const picked = [];
  while (picked.length < GRAND_QUIZ_SIZE && lists.some((l) => l.length)) {
    for (const l of lists) { if (l.length && picked.length < GRAND_QUIZ_SIZE) picked.push(l.pop()); }
  }
  if (!picked.length) return res.status(503).json({ message: 'Les questions du grand test sont en cours de préparation.' });
  const questions = shuffle(picked).map(({ id, question_text, choices }) => ({ id, question_text, choices }));
  const s = (await pool.query(
    'INSERT INTO ebk_quiz_sessions (user_id, session_id, course_id, question_ids) VALUES ($1,$2,NULL,$3) RETURNING id',
    [req.user.id, st.session.id, JSON.stringify(questions.map((q) => q.id))]
  )).rows[0];
  res.json({ session_id: s.id, questions });
}));

router.post('/grand-quiz', wrap(async (req, res) => {
  const st = await studentState(req.user.id);
  if (!st.student || !st.all_passed) return res.status(403).json({ message: 'Réussissez d\'abord les tests de tous les cours.' });
  if (st.certificate) return res.status(403).json({ message: 'Vous avez déjà réussi le grand test.' });
  const s = (await pool.query(
    'UPDATE ebk_quiz_sessions SET used=true WHERE id=$1 AND user_id=$2 AND course_id IS NULL AND used=false RETURNING *',
    [req.body.session_id, req.user.id]
  )).rows[0];
  if (!s) return res.status(400).json({ message: 'Ce test a expiré ou a déjà été soumis. Rouvrez le test pour obtenir de nouvelles questions.' });
  const ids = s.question_ids;
  const questions = (await pool.query('SELECT id, question_text, choices, correct_choice_index FROM ebk_questions WHERE id = ANY($1::int[])', [ids])).rows;
  const { correct, total, score, wrong } = gradeQuiz(questions, ids, req.body.answers);
  const passed = score >= PASS_THRESHOLD;
  const percent = Math.round(score * 100);
  await pool.query('INSERT INTO ebk_attempts (user_id, session_id, course_id, passed, score) VALUES ($1,$2,NULL,$3,$4)', [req.user.id, st.session.id, passed, percent]);
  if (passed) {
    for (let i = 0; i < 5; i++) {
      try {
        await pool.query(
          'INSERT INTO ebk_certificates (user_id, session_id, full_name, code, score) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, session_id) DO NOTHING',
          [req.user.id, st.session.id, st.student.full_name, newCode(), percent]
        );
        break;
      } catch (e) { if (i === 4) throw e; }
    }
  }
  res.json({ passed, score: percent, correct, total, wrong });
}));

router.get('/certificate-link', wrap(async (req, res) => {
  const session = await openSession();
  const cert = session ? (await pool.query('SELECT 1 FROM ebk_certificates WHERE user_id=$1 AND session_id=$2', [req.user.id, session.id])).rows[0] : null;
  if (!cert) return res.status(403).json({ message: 'Le certificat n\'est pas encore disponible.' });
  const t = jwt.sign({ userId: req.user.id, sessionId: session.id, purpose: 'ebk-certificate' }, JWT_SECRET, { expiresIn: '10m' });
  res.json({ url: `/api/ebk/certificate?token=${t}` });
}));

// ---------- Administration (administrateur complet uniquement) ----------
const admin = express.Router();
router.use('/admin', requireAdmin, admin);

function buildUpdate(table, id, body, fields) {
  const sets = [], vals = [];
  fields.forEach((f) => { if (body[f] !== undefined) { vals.push(body[f]); sets.push(`${f}=$${vals.length}`); } });
  if (!sets.length) return null;
  vals.push(id);
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals };
}
const STATUSES = ['terminee', 'a_venir', 'en_cours'];

admin.get('/overview', wrap(async (req, res) => {
  const sessions = (await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM ebk_courses c WHERE c.session_id = s.id) AS courses_count,
            (SELECT COUNT(*)::int FROM ebk_students st WHERE st.session_id = s.id) AS students_count,
            (SELECT COUNT(*)::int FROM ebk_certificates ce WHERE ce.session_id = s.id) AS certificates_count
       FROM ebk_sessions s ORDER BY position, id`
  )).rows;
  res.json({ sessions, settings: await getSettings(), ia_ready: !!process.env.MISTRAL_API_KEY });
}));

admin.post('/sessions', wrap(async (req, res) => {
  const b = req.body;
  if (!cleanName(b.title)) return res.status(400).json({ message: 'Titre requis' });
  const pos = (await pool.query('SELECT COALESCE(MAX(position),0)+1 AS p FROM ebk_sessions')).rows[0].p;
  const r = await pool.query(
    'INSERT INTO ebk_sessions (title, period_label, status, description, position) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [cleanName(b.title), b.period_label || null, STATUSES.includes(b.status) ? b.status : 'a_venir', b.description || null, pos]
  );
  res.status(201).json(r.rows[0]);
}));

admin.put('/sessions/:id', wrap(async (req, res) => {
  const b = { ...req.body };
  if (b.status !== undefined && !STATUSES.includes(b.status)) return res.status(400).json({ message: 'Statut invalide' });
  ['registration_open', 'classroom_open'].forEach((k) => { if (b[k] !== undefined) b[k] = !!b[k]; });
  if (b.classroom_open === true) await pool.query('UPDATE ebk_sessions SET classroom_open=false WHERE id<>$1', [req.params.id]);
  const u = buildUpdate('ebk_sessions', req.params.id, b, ['title', 'period_label', 'status', 'description', 'registration_open', 'classroom_open', 'position']);
  if (!u) return res.status(400).json({ message: 'Rien à modifier' });
  const r = await pool.query(u.sql, u.vals);
  if (!r.rows[0]) return res.status(404).json({ message: 'Session introuvable' });
  res.json(r.rows[0]);
}));

admin.delete('/sessions/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM ebk_sessions WHERE id=$1', [req.params.id]);
  res.status(204).end();
}));

admin.get('/courses', wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.position, c.title, c.teacher, c.youtube_url, (COALESCE(length(c.syllabus_text),0) > 0) AS has_text, (c.syllabus_file IS NOT NULL) AS has_file,
            (SELECT COUNT(*)::int FROM ebk_questions q WHERE q.course_id = c.id) AS questions_count
       FROM ebk_courses c WHERE c.session_id=$1 ORDER BY c.position, c.id`, [req.query.session_id]
  );
  res.json(r.rows);
}));

admin.get('/courses/:id', wrap(async (req, res) => {
  const c = (await pool.query('SELECT id, session_id, position, title, teacher, description, youtube_url, syllabus_text, syllabus_url, syllabus_filename, (syllabus_file IS NOT NULL) AS has_file FROM ebk_courses WHERE id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ message: 'Cours introuvable' });
  const questions = (await pool.query('SELECT id, question_text, choices, correct_choice_index, source FROM ebk_questions WHERE course_id=$1 ORDER BY id', [c.id])).rows;
  res.json({ course: c, questions });
}));

admin.post('/courses', wrap(async (req, res) => {
  const b = req.body;
  if (!cleanName(b.title) || !b.session_id) return res.status(400).json({ message: 'Session et titre requis' });
  const pos = (await pool.query('SELECT COALESCE(MAX(position),0)+1 AS p FROM ebk_courses WHERE session_id=$1', [b.session_id])).rows[0].p;
  const r = await pool.query(
    'INSERT INTO ebk_courses (session_id, position, title, teacher, description, youtube_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title',
    [b.session_id, pos, cleanName(b.title), b.teacher || null, b.description || null, b.youtube_url || null]
  );
  res.status(201).json(r.rows[0]);
}));

admin.put('/courses/:id', wrap(async (req, res) => {
  const u = buildUpdate('ebk_courses', req.params.id, req.body, ['title', 'teacher', 'description', 'youtube_url', 'syllabus_text', 'syllabus_url']);
  if (!u) return res.status(400).json({ message: 'Rien à modifier' });
  const r = await pool.query(u.sql, u.vals);
  if (!r.rows[0]) return res.status(404).json({ message: 'Cours introuvable' });
  res.json({ ok: true });
}));

admin.delete('/courses/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM ebk_courses WHERE id=$1', [req.params.id]);
  res.status(204).end();
}));

admin.post('/courses/:id/move', wrap(async (req, res) => {
  const c = (await pool.query('SELECT session_id FROM ebk_courses WHERE id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ message: 'Cours introuvable' });
  const ids = (await pool.query('SELECT id FROM ebk_courses WHERE session_id=$1 ORDER BY position, id', [c.session_id])).rows.map((r) => r.id);
  const i = ids.indexOf(Number(req.params.id));
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return res.json({ ok: true });
  [ids[i], ids[j]] = [ids[j], ids[i]];
  for (let k = 0; k < ids.length; k++) await pool.query('UPDATE ebk_courses SET position=$1 WHERE id=$2', [k + 1, ids[k]]);
  res.json({ ok: true });
}));

// Import du syllabus depuis un fichier (PDF, Word ou texte) : le texte est extrait et le fichier d'origine est conservé
async function extractText(file) {
  const name = (file.originalname || '').toLowerCase();
  let text;
  if (name.endsWith('.pdf')) text = (await require('pdf-parse')(file.buffer)).text;
  else if (name.endsWith('.docx')) text = (await require('mammoth').extractRawText({ buffer: file.buffer })).value;
  else text = file.buffer.toString('utf8');
  return String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
if (multer) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
  admin.post('/courses/:id/syllabus-file', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu' });
    const name = (req.file.originalname || '').toLowerCase();
    const keep = name.endsWith('.pdf') || name.endsWith('.docx');
    let text;
    try { text = await extractText(req.file); }
    catch (e) { return res.status(400).json({ message: 'Impossible de lire ce fichier : ' + e.message }); }
    await pool.query(
      'UPDATE ebk_courses SET syllabus_text=$1, syllabus_file=$2, syllabus_filename=$3 WHERE id=$4',
      [text, keep ? req.file.buffer : null, keep ? req.file.originalname : null, req.params.id]
    );
    res.json({ ok: true, characters: text.length });
  }));
}

// Questions : ajout manuel, suppression, génération automatique à partir du syllabus
admin.post('/courses/:id/questions', wrap(async (req, res) => {
  const { question_text, choices, correct_choice_index } = req.body;
  const ch = Array.isArray(choices) ? choices.map((c) => String(c || '').trim()).filter(Boolean) : [];
  if (!cleanName(question_text) || ch.length < 2 || !Number.isInteger(correct_choice_index) || correct_choice_index < 0 || correct_choice_index >= ch.length) {
    return res.status(400).json({ message: 'Question, au moins 2 propositions et la bonne réponse sont requises.' });
  }
  await pool.query('INSERT INTO ebk_questions (course_id, question_text, choices, correct_choice_index, source) VALUES ($1,$2,$3,$4,\'manuel\')', [req.params.id, cleanName(question_text), JSON.stringify(ch), correct_choice_index]);
  res.status(201).json({ ok: true });
}));

admin.delete('/questions/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM ebk_questions WHERE id=$1', [req.params.id]);
  res.status(204).end();
}));

async function callMistral(prompt) {
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: 'mistral-small-latest', max_tokens: 7000, temperature: 0.5, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || (data.error && data.error.message) || 'Erreur du service IA');
  let raw = ((data.choices && data.choices[0] && data.choices[0].message.content) || '{}').trim();
  raw = raw.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); }
  catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Réponse IA non exploitable'); }
}
const callWithRetry = async (p) => { try { return await callMistral(p); } catch (e) { return await callMistral(p); } };
const normText = (t) => String(t).toLowerCase().replace(/[^a-zà-ÿ0-9]+/g, ' ').trim();
function validQuestion(q) {
  return q && typeof q.question_text === 'string' && q.question_text.length > 8 && Array.isArray(q.choices) && q.choices.length >= 3
    && q.choices.every((c) => typeof c === 'string' && c.trim()) && Number.isInteger(q.correct_choice_index) && q.correct_choice_index >= 0 && q.correct_choice_index < q.choices.length;
}
function shuffleChoices(q) {
  const choices = shuffle(q.choices);
  const idx = choices.indexOf(q.choices[q.correct_choice_index]);
  return { question_text: q.question_text.trim(), choices, correct_choice_index: idx >= 0 ? idx : 0 };
}

admin.post('/courses/:id/generate', wrap(async (req, res) => {
  if (!process.env.MISTRAL_API_KEY) return res.status(400).json({ message: 'La génération automatique n\'est pas activée (clé MISTRAL_API_KEY absente sur Render). Vous pouvez ajouter les questions à la main.' });
  const course = (await pool.query('SELECT id, title, syllabus_text FROM ebk_courses WHERE id=$1', [req.params.id])).rows[0];
  if (!course) return res.status(404).json({ message: 'Cours introuvable' });
  const text = String(course.syllabus_text || '').trim();
  if (text.length < 500) return res.status(400).json({ message: 'Le syllabus est vide ou trop court : ajoutez d\'abord son texte ou son fichier.' });
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 3; i += 12000) chunks.push(text.slice(i, i + 12000));
  const perChunk = Math.ceil(POOL_TARGET / chunks.length);
  const list = [], seen = new Set();
  for (const chunk of chunks) {
    const prompt = `Voici un extrait du syllabus d'un cours d'école biblique intitulé « ${course.title} ».

TEXTE :
${chunk}

Tâche : génère exactement ${perChunk} questions à choix multiples (4 propositions chacune) qui testent la compréhension de ce texte, en couvrant tous ses passages. Elles doivent être STRICTEMENT et ENTIÈREMENT fondées sur ce texte : rien d'extérieur au syllabus.

Règles impératives :
- Chaque question porte sur un point DIFFÉRENT (aucun doublon).
- Les 3 mauvaises réponses sont des affirmations plausibles inspirées du texte, jamais absurdes.
- Une seule bonne réponse, sans ambiguïté.
- Réponds UNIQUEMENT avec un objet JSON de cette forme exacte, sans aucun texte autour :
{"questions":[{"question_text":"...","choices":["...","...","...","..."],"correct_choice_index":0}]}`;
    const out = await callWithRetry(prompt);
    for (const q of (out.questions || [])) {
      if (!validQuestion(q) || seen.has(normText(q.question_text))) continue;
      seen.add(normText(q.question_text));
      list.push(shuffleChoices(q));
    }
  }
  if (list.length < COURSE_QUIZ_SIZE) return res.status(502).json({ message: `Seulement ${list.length} questions valides ont été produites. Réessayez, ou complétez à la main.` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM ebk_questions WHERE course_id=$1 AND source='ia'", [course.id]);
    for (const q of list) {
      await client.query("INSERT INTO ebk_questions (course_id, question_text, choices, correct_choice_index, source) VALUES ($1,$2,$3,$4,'ia')", [course.id, q.question_text, JSON.stringify(q.choices), q.correct_choice_index]);
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  res.json({ generated: list.length });
}));

admin.get('/students', wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT st.id, st.full_name, st.created_at, u.email, s.title AS session_title,
            (SELECT COUNT(DISTINCT a.course_id)::int FROM ebk_attempts a WHERE a.user_id = st.user_id AND a.session_id = st.session_id AND a.course_id IS NOT NULL AND a.passed) AS courses_passed,
            (SELECT COUNT(*)::int FROM ebk_courses c WHERE c.session_id = st.session_id) AS courses_total,
            (SELECT ce.code FROM ebk_certificates ce WHERE ce.user_id = st.user_id AND ce.session_id = st.session_id) AS certificate_code
       FROM ebk_students st JOIN users u ON u.id = st.user_id JOIN ebk_sessions s ON s.id = st.session_id
      ORDER BY st.created_at DESC`
  );
  res.json(r.rows);
}));

admin.get('/certificates', wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT ce.code, ce.full_name, ce.score, ce.issued_at, u.email, s.title AS session_title
       FROM ebk_certificates ce JOIN users u ON u.id = ce.user_id JOIN ebk_sessions s ON s.id = ce.session_id
      ORDER BY ce.issued_at DESC`
  );
  res.json(r.rows);
}));

admin.put('/settings', wrap(async (req, res) => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (req.body[key] === undefined) continue;
    await pool.query('INSERT INTO ebk_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, String(req.body[key]).slice(0, 4000)]);
  }
  res.json(await getSettings());
}));

module.exports = router;
