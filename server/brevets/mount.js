// Brevets envoyés à l'administration : un lecteur qui a obtenu son brevet peut l'envoyer d'un seul bouton,
// avec un message automatique ; l'administration les retrouve classés par livre étudié.
// Module AUTONOME, branché par server/actualites/mount.js (même principe que les délais et l'EBK) :
//  - aucune route, aucun fichier et aucune table existante n'est modifié ;
//  - sa propre table : brevet_submissions (créée automatiquement) ;
//  - le brevet PDF reste celui que génère déjà l'espace d'étude : il est regénéré à la demande, à l'identique ;
//  - si ce module échoue, le reste du site continue de fonctionner normalement.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, JWT_SECRET } = require('../lib/auth-middleware');

// ---------- Base de données ----------
// Chaque envoi garde une copie des références du brevet (nom, e-mail, livre, code, résultat) :
// le classeur reste complet même si le livre ou le compte change plus tard.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS brevet_submissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        full_name TEXT,
        email TEXT,
        book_title TEXT,
        certificate_code TEXT,
        final_score INTEGER,
        obtained_at TIMESTAMPTZ,
        message TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_at TIMESTAMPTZ,
        UNIQUE (user_id, book_id)
      );
      CREATE INDEX IF NOT EXISTS idx_brevet_submissions_book ON brevet_submissions (book_id, sent_at DESC);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ---------- Outils ----------
function newCertificateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // même alphabet que l'espace d'étude
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) code += alphabet[bytes[i] % alphabet.length];
  return 'MNA-' + code;
}

function frDate(d) {
  try { return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; }
}

// Message automatique qui accompagne le brevet
function buildMessage(s) {
  const score = s.score !== null && s.score !== undefined ? ', avec un résultat de ' + s.score + ' %' : '';
  const when = s.obtainedAt ? frDate(s.obtainedAt) : '';
  return [
    'Bonjour,',
    '',
    'Je suis ' + s.name + '. Par la grâce de Dieu, j\'ai achevé l\'étude du livre « ' + s.title + ' » dans l\'espace d\'étude du Ministère de la Nouvelle Alliance' + score + '.',
    '',
    'Je vous transmets mon brevet de réussite' + (when ? ', obtenu le ' + when : '') + ', afin qu\'il soit enregistré auprès de l\'administration.',
    'Code de vérification du brevet : ' + s.code,
    '',
    'Que le Seigneur vous bénisse.',
    s.name + (s.email && s.email !== s.name ? ' — ' + s.email : ''),
  ].join('\n');
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[brevets]', err.message);
  if (!res.headersSent) res.status(500).json({ message: err.message });
});

module.exports = function mountBrevets(app, express) {
  // ----- Lecteur connecté : envoyer son brevet -----
  const pub = express.Router();

  // Les brevets déjà envoyés par cette personne
  pub.get('/mine', wrap(async (req, res) => {
    await ensureSchema();
    const r = await pool.query('SELECT book_id, sent_at FROM brevet_submissions WHERE user_id = $1', [req.user.id]);
    res.set('Cache-Control', 'no-store').json(r.rows);
  }));

  // Un seul bouton : le brevet et son message automatique partent vers le classeur de l'administration
  pub.post('/send/:bookId', wrap(async (req, res) => {
    await ensureSchema();
    const userId = req.user.id;
    const bookId = parseInt(req.params.bookId, 10);
    if (!bookId) return res.status(400).json({ message: 'Livre invalide.' });

    const prog = (await pool.query(
      'SELECT certificate_issued, certificate_code, final_score, completed_at FROM user_progress WHERE user_id = $1 AND book_id = $2', [userId, bookId]
    )).rows[0];
    if (!prog || !prog.certificate_issued) {
      return res.status(403).json({ message: 'Vous n\'avez pas encore de brevet pour ce livre.' });
    }

    // Déjà envoyé : on ne l'envoie pas une deuxième fois
    const already = (await pool.query('SELECT sent_at, message FROM brevet_submissions WHERE user_id = $1 AND book_id = $2', [userId, bookId])).rows[0];
    if (already) return res.json({ already: true, sent_at: already.sent_at, message: already.message });

    const book = (await pool.query('SELECT title FROM books WHERE id = $1', [bookId])).rows[0];
    if (!book) return res.status(404).json({ message: 'Livre introuvable.' });
    const u = (await pool.query('SELECT email, full_name FROM users WHERE id = $1', [userId])).rows[0] || {};

    // Le code de vérification existe déjà dans presque tous les cas ; sinon il est créé une seule fois
    let code = prog.certificate_code;
    if (!code) {
      const up = await pool.query(
        'UPDATE user_progress SET certificate_code = $1 WHERE user_id = $2 AND book_id = $3 AND certificate_code IS NULL RETURNING certificate_code',
        [newCertificateCode(), userId, bookId]
      );
      code = up.rows[0]
        ? up.rows[0].certificate_code
        : (await pool.query('SELECT certificate_code FROM user_progress WHERE user_id = $1 AND book_id = $2', [userId, bookId])).rows[0].certificate_code;
    }

    const name = ((u.full_name || u.email || '') + '').trim();
    const message = buildMessage({
      name, email: u.email, title: book.title, score: prog.final_score, obtainedAt: prog.completed_at, code,
    });
    const ins = await pool.query(
      `INSERT INTO brevet_submissions (user_id, book_id, full_name, email, book_title, certificate_code, final_score, obtained_at, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, book_id) DO NOTHING
       RETURNING sent_at, message`,
      [userId, bookId, u.full_name || null, u.email || null, book.title, code, prog.final_score, prog.completed_at, message]
    );
    if (!ins.rows[0]) {
      const again = (await pool.query('SELECT sent_at, message FROM brevet_submissions WHERE user_id = $1 AND book_id = $2', [userId, bookId])).rows[0];
      return res.json({ already: true, sent_at: again.sent_at, message: again.message });
    }
    res.status(201).json({ ok: true, sent_at: ins.rows[0].sent_at, message: ins.rows[0].message });
  }));

  // ----- Administration : le classeur -----
  const adm = express.Router();

  // Tous les brevets reçus, rangés par livre étudié
  adm.get('/classeur', wrap(async (req, res) => {
    await ensureSchema();
    const rows = (await pool.query(`
      SELECT s.id, s.user_id, s.book_id, s.full_name, s.email, s.book_title, s.certificate_code, s.final_score,
             s.obtained_at, s.message, s.sent_at, s.read_at,
             b.title AS current_title, b.order_index AS book_order,
             (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.user_id = s.user_id AND qa.book_id = s.book_id AND qa.part_id IS NULL) AS grand_attempts
        FROM brevet_submissions s
        LEFT JOIN books b ON b.id = s.book_id
       ORDER BY s.sent_at DESC
    `)).rows;

    const groups = new Map();
    let unread = 0;
    rows.forEach((r) => {
      if (!groups.has(r.book_id)) {
        groups.set(r.book_id, { book_id: r.book_id, title: r.current_title || r.book_title || '(livre supprimé)', order: r.book_order, count: 0, unread: 0, items: [] });
      }
      const g = groups.get(r.book_id);
      g.count++;
      if (!r.read_at) { g.unread++; unread++; }
      g.items.push({
        id: r.id, user_id: r.user_id, full_name: r.full_name, email: r.email, certificate_code: r.certificate_code,
        final_score: r.final_score, obtained_at: r.obtained_at, sent_at: r.sent_at, read_at: r.read_at,
        message: r.message, grand_attempts: Number(r.grand_attempts) || 0,
      });
    });
    const books = [...groups.values()].sort((a, b) =>
      ((a.order == null ? 1e9 : a.order) - (b.order == null ? 1e9 : b.order)) || String(a.title).localeCompare(String(b.title), 'fr'));
    res.set('Cache-Control', 'no-store').json({ total: rows.length, unread, books });
  }));

  // Marquer un brevet comme consulté / non consulté
  adm.put('/:id/read', wrap(async (req, res) => {
    await ensureSchema();
    const read = !(req.body && req.body.read === false);
    const r = await pool.query(
      'UPDATE brevet_submissions SET read_at = CASE WHEN $2::boolean THEN COALESCE(read_at, now()) ELSE NULL END WHERE id = $1 RETURNING read_at',
      [req.params.id, read]
    );
    if (!r.rows[0]) return res.status(404).json({ message: 'Brevet introuvable.' });
    res.json({ read_at: r.rows[0].read_at });
  }));

  // Ouvrir le brevet (PDF) : lien à durée limitée vers le brevet exact du lecteur, généré par l'espace d'étude
  adm.get('/:id/link', wrap(async (req, res) => {
    await ensureSchema();
    const row = (await pool.query('SELECT id, user_id, book_id FROM brevet_submissions WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ message: 'Brevet introuvable.' });
    await pool.query('UPDATE brevet_submissions SET read_at = COALESCE(read_at, now()) WHERE id = $1', [row.id]);
    const token = jwt.sign({ userId: row.user_id, bookId: String(row.book_id), purpose: 'certificate' }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ url: `/api/study/books/${row.book_id}/certificate?token=${token}`, read_at: new Date().toISOString() });
  }));

  // L'administration est sous /api/admin/... (jamais gardée dans le téléphone par le mode hors connexion)
  app.use('/api/admin/brevets', express.json(), requireAuth, requireAdmin, adm);
  app.use('/api/brevets', express.json(), requireAuth, pub);

  ensureSchema().catch((err) => console.error('[brevets] base de données :', err.message));
};
