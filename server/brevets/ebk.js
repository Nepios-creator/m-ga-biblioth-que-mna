// Brevets EBK envoyés à l'administration : même principe que les brevets des livres d'étude.
// Module AUTONOME, branché par server/brevets/mount.js :
//  - aucune route, aucun fichier et aucune table de l'EBK n'est modifié ;
//  - sa propre table : brevet_ebk_submissions (créée automatiquement) ;
//  - le brevet PDF reste celui que génère déjà l'EBK : il est regénéré à la demande, à l'identique ;
//  - si ce module échoue, le reste du site continue de fonctionner normalement.
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, JWT_SECRET } = require('../lib/auth-middleware');

// ---------- Base de données ----------
// Chaque envoi garde une copie des références du brevet : le classeur reste complet même si la session ou le compte change.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS brevet_ebk_submissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        full_name TEXT,
        email TEXT,
        session_title TEXT,
        certificate_code TEXT,
        final_score INTEGER,
        started_at TIMESTAMPTZ,
        obtained_at TIMESTAMPTZ,
        message TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_at TIMESTAMPTZ,
        UNIQUE (user_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_brevet_ebk_session ON brevet_ebk_submissions (session_id, sent_at DESC);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ---------- Outils ----------
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// Date à l'heure de Kinshasa (UTC+1), comme sur le brevet de l'EBK
function frDate(d) {
  const k = new Date(new Date(d).getTime() + 3600 * 1000);
  return `${k.getUTCDate()} ${MONTHS[k.getUTCMonth()]} ${k.getUTCFullYear()}`;
}

// Message automatique qui accompagne le brevet
function buildMessage(s) {
  const end = s.issuedAt ? frDate(s.issuedAt) : '';
  const start = s.startedAt ? frDate(s.startedAt) : '';
  const period = start && end && start !== end ? ' (du ' + start + ' au ' + end + ')' : '';
  const score = s.score !== null && s.score !== undefined ? ', avec un résultat de ' + s.score + ' % au grand test' : '';
  return [
    'Bonjour,',
    '',
    'Je suis ' + s.name + '. Par la grâce de Dieu, j\'ai achevé la « ' + s.sessionTitle + ' » de l\'École Biblique Kainos (EBK)' + period + score + '.',
    '',
    'Je vous transmets mon brevet de participation' + (end ? ', délivré le ' + end : '') + ', afin qu\'il soit enregistré auprès de l\'administration.',
    'Code de vérification du brevet : ' + s.code,
    '',
    'Que le Seigneur vous bénisse.',
    s.name + (s.email && s.email !== s.name ? ' — ' + s.email : ''),
  ].join('\n');
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[brevets-ebk]', err.message);
  if (!res.headersSent) res.status(500).json({ message: err.message });
});

// Session ouverte (celle de la salle de classe), comme le fait déjà l'EBK
const openSession = async () => (await pool.query('SELECT id, title, period_label FROM ebk_sessions WHERE classroom_open ORDER BY position, id LIMIT 1')).rows[0] || null;

module.exports = function mountBrevetsEbk(app, express) {
  // ----- Étudiant connecté : envoyer son brevet -----
  const pub = express.Router();

  // Le brevet de la session ouverte a-t-il déjà été envoyé ?
  pub.get('/mine', wrap(async (req, res) => {
    await ensureSchema();
    const session = await openSession();
    if (!session) return res.set('Cache-Control', 'no-store').json({ sent: false });
    const r = (await pool.query('SELECT sent_at, message FROM brevet_ebk_submissions WHERE user_id = $1 AND session_id = $2', [req.user.id, session.id])).rows[0];
    res.set('Cache-Control', 'no-store').json(r ? { sent: true, sent_at: r.sent_at, message: r.message } : { sent: false });
  }));

  // Un seul bouton : le brevet et son message automatique partent vers le classeur de l'administration
  pub.post('/send', wrap(async (req, res) => {
    await ensureSchema();
    const userId = req.user.id;
    const session = await openSession();
    if (!session) return res.status(404).json({ message: 'Aucune session n\'est ouverte pour le moment.' });

    const cert = (await pool.query(
      'SELECT full_name, code, score, issued_at, started_at FROM ebk_certificates WHERE user_id = $1 AND session_id = $2', [userId, session.id]
    )).rows[0];
    if (!cert) return res.status(403).json({ message: 'Vous n\'avez pas encore de brevet.' });

    // Déjà envoyé : on ne l'envoie pas une deuxième fois
    const already = (await pool.query('SELECT sent_at, message FROM brevet_ebk_submissions WHERE user_id = $1 AND session_id = $2', [userId, session.id])).rows[0];
    if (already) return res.json({ already: true, sent_at: already.sent_at, message: already.message });

    const st = (await pool.query('SELECT started_at, confirmed_at, created_at FROM ebk_students WHERE user_id = $1 AND session_id = $2', [userId, session.id])).rows[0] || {};
    const started = cert.started_at || st.started_at || st.confirmed_at || st.created_at || null;
    const u = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0] || {};
    const name = String(cert.full_name || u.email || '').trim();
    const message = buildMessage({
      name, email: u.email, sessionTitle: session.title, score: cert.score, startedAt: started, issuedAt: cert.issued_at, code: cert.code,
    });
    const ins = await pool.query(
      `INSERT INTO brevet_ebk_submissions (user_id, session_id, full_name, email, session_title, certificate_code, final_score, started_at, obtained_at, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, session_id) DO NOTHING
       RETURNING sent_at, message`,
      [userId, session.id, name, u.email || null, session.title, cert.code, cert.score, started, cert.issued_at, message]
    );
    if (!ins.rows[0]) {
      const again = (await pool.query('SELECT sent_at, message FROM brevet_ebk_submissions WHERE user_id = $1 AND session_id = $2', [userId, session.id])).rows[0];
      return res.json({ already: true, sent_at: again.sent_at, message: again.message });
    }
    res.status(201).json({ ok: true, sent_at: ins.rows[0].sent_at, message: ins.rows[0].message });
  }));

  // ----- Administration : le classeur EBK -----
  const adm = express.Router();

  // Tous les brevets EBK reçus, rangés par session (même forme de réponse que le classeur des livres)
  adm.get('/classeur', wrap(async (req, res) => {
    await ensureSchema();
    const rows = (await pool.query(`
      SELECT s.id, s.user_id, s.session_id, s.full_name, s.email, s.session_title, s.certificate_code, s.final_score,
             s.started_at, s.obtained_at, s.message, s.sent_at, s.read_at,
             es.title AS current_title, es.period_label AS current_period, es.position AS session_pos,
             (SELECT COUNT(*) FROM ebk_attempts a WHERE a.user_id = s.user_id AND a.session_id = s.session_id AND a.course_id IS NULL) AS grand_attempts
        FROM brevet_ebk_submissions s
        LEFT JOIN ebk_sessions es ON es.id = s.session_id
       ORDER BY s.sent_at DESC
    `)).rows;

    const groups = new Map();
    let unread = 0;
    rows.forEach((r) => {
      if (!groups.has(r.session_id)) {
        const base = r.current_title || r.session_title || '(session supprimée)';
        groups.set(r.session_id, { book_id: r.session_id, title: base + (r.current_period ? ' — ' + r.current_period : ''), order: r.session_pos, count: 0, unread: 0, items: [] });
      }
      const g = groups.get(r.session_id);
      g.count++;
      if (!r.read_at) { g.unread++; unread++; }
      g.items.push({
        id: r.id, user_id: r.user_id, full_name: r.full_name, email: r.email, certificate_code: r.certificate_code,
        final_score: r.final_score, started_at: r.started_at, obtained_at: r.obtained_at, sent_at: r.sent_at, read_at: r.read_at,
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
      'UPDATE brevet_ebk_submissions SET read_at = CASE WHEN $2::boolean THEN COALESCE(read_at, now()) ELSE NULL END WHERE id = $1 RETURNING read_at',
      [req.params.id, read]
    );
    if (!r.rows[0]) return res.status(404).json({ message: 'Brevet introuvable.' });
    res.json({ read_at: r.rows[0].read_at });
  }));

  // Ouvrir le brevet (PDF) : lien à durée limitée vers le brevet exact de l'étudiant, généré par l'EBK
  adm.get('/:id/link', wrap(async (req, res) => {
    await ensureSchema();
    const row = (await pool.query('SELECT id, user_id, session_id FROM brevet_ebk_submissions WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ message: 'Brevet introuvable.' });
    await pool.query('UPDATE brevet_ebk_submissions SET read_at = COALESCE(read_at, now()) WHERE id = $1', [row.id]);
    const token = jwt.sign({ userId: row.user_id, sessionId: row.session_id, purpose: 'ebk-certificate' }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ url: `/api/ebk/certificate?token=${token}`, read_at: new Date().toISOString() });
  }));

  // L'administration est sous /api/admin/... (jamais gardée dans le téléphone par le mode hors connexion)
  app.use('/api/admin/brevets-ebk', express.json(), requireAuth, requireAdmin, adm);
  app.use('/api/brevets-ebk', express.json(), requireAuth, pub);

  ensureSchema().catch((err) => console.error('[brevets-ebk] base de données :', err.message));
};
