// Délais : livres d'étude à durée limitée et sessions EBK à fermeture automatique, avec compte à rebours.
// Module AUTONOME, branché par server/actualites/mount.js (même principe que l'EBK) :
//  - aucune route ni table existante n'est modifiée ;
//  - ses propres tables : access_deadlines et access_deadline_users (créées automatiquement) ;
//  - si ce module échoue, le reste du site continue de fonctionner normalement.
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, JWT_SECRET } = require('../lib/auth-middleware');

const KINDS = ['study_book', 'ebk_session'];

// ---------- Base de données ----------
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS access_deadlines (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        audience TEXT NOT NULL DEFAULT 'all',
        open_registration BOOLEAN NOT NULL DEFAULT false,
        starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ends_at TIMESTAMPTZ NOT NULL,
        applied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_access_deadlines_target ON access_deadlines (kind, target_id);
      ALTER TABLE access_deadlines ADD COLUMN IF NOT EXISTS prev_locked BOOLEAN;
      CREATE TABLE IF NOT EXISTS access_deadline_users (
        deadline_id INTEGER NOT NULL REFERENCES access_deadlines(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (deadline_id, user_id)
      );
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ---------- Outils ----------
function userIdFromReq(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : ((req.query && req.query.token) || null);
  if (!t) return null;
  try {
    const d = jwt.verify(t, JWT_SECRET);
    return Number(d.id || d.userId) || null;
  } catch (e) { return null; }
}

// Délais qui concernent une personne : ceux destinés à tous + ceux où elle a été choisie
async function userWindows(userId, kind) {
  const r = await pool.query(
    `SELECT d.id, d.kind, d.target_id, d.audience, d.starts_at, d.ends_at
       FROM access_deadlines d
      WHERE d.kind = $1
        AND (d.audience = 'all' OR EXISTS (SELECT 1 FROM access_deadline_users u WHERE u.deadline_id = d.id AND u.user_id = $2))`,
    [kind, userId || 0]
  );
  return r.rows;
}

// État d'un livre / d'une session pour une personne : en cours, terminé, ou sans effet (pas encore commencé)
function stateOf(windows, now) {
  let active = null, expired = null;
  (windows || []).forEach((w) => {
    const s = new Date(w.starts_at).getTime(), e = new Date(w.ends_at).getTime();
    if (s <= now && e > now) { if (!active || e > new Date(active.ends_at).getTime()) active = w; }
    else if (e <= now) { if (!expired || e > new Date(expired.ends_at).getTime()) expired = w; }
  });
  if (active) return { state: 'active', w: active };
  if (expired) return { state: 'expired', w: expired };
  return null;
}

function groupByTarget(wins) {
  const by = {};
  wins.forEach((w) => { (by[w.target_id] = by[w.target_id] || []).push(w); });
  return by;
}

async function titlesOf(kind, ids) {
  if (!ids.length) return {};
  try {
    const sql = kind === 'study_book' ? 'SELECT id, title FROM books WHERE id = ANY($1::int[])' : 'SELECT id, title FROM ebk_sessions WHERE id = ANY($1::int[])';
    const r = await pool.query(sql, [ids]);
    const m = {};
    r.rows.forEach((x) => { m[x.id] = x.title; });
    return m;
  } catch (e) { return {}; }
}

function addDuration(base, value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const d = new Date(base);
  if (unit === 'mois') { d.setMonth(d.getMonth() + Math.floor(v)); return d; }
  const ms = { heures: 3600000, jours: 86400000, semaines: 7 * 86400000 }[unit] || 86400000;
  return new Date(d.getTime() + v * ms);
}

async function openEbkSession(id, openRegistration) {
  await pool.query('UPDATE ebk_sessions SET classroom_open = false WHERE id <> $1', [id]);
  await pool.query("UPDATE ebk_sessions SET classroom_open = true, registration_open = $2, status = 'en_cours' WHERE id = $1", [id, !!openRegistration]);
}

// ---------- Fermeture automatique des sessions EBK ----------
async function sweep() {
  try {
    await ensureSchema();
    const due = (await pool.query("SELECT id, target_id FROM access_deadlines WHERE kind = 'ebk_session' AND applied_at IS NULL AND ends_at <= now()")).rows;
    for (const row of due) {
      await pool.query("UPDATE ebk_sessions SET classroom_open = false, registration_open = false, status = 'terminee' WHERE id = $1", [row.target_id]);
      await pool.query('UPDATE access_deadlines SET applied_at = now() WHERE id = $1', [row.id]);
      console.log('[délais] session EBK', row.target_id, 'fermée automatiquement');
    }
  } catch (err) {
    console.error('[délais] fermeture automatique :', err.message);
  }
}
// Réveil du serveur (hébergement qui s'endort) : la vérification se fait aussi à la première demande EBK
let lastSweep = 0;
function lazySweep(req, res, next) {
  if (Date.now() - lastSweep < 15000) return next();
  lastSweep = Date.now();
  sweep().then(() => next(), () => next());
}

// ---------- Blocage automatique des livres d'étude (par personne) ----------
async function studyGuard(req, res, next) {
  try {
    const p = req.path;
    // Le brevet déjà obtenu reste toujours téléchargeable
    if (p.startsWith('/admin') || /\/certificate(-link)?$/.test(p)) return next();
    const isList = req.method === 'GET' && (p === '/books' || p === '/books/');
    let bookId = null, m;
    if ((m = p.match(/^\/books\/(\d+)(\/|$)/))) bookId = Number(m[1]);
    else if ((m = p.match(/^\/parts\/(\d+)(\/|$)/))) {
      const r = await pool.query('SELECT book_id FROM book_parts WHERE id = $1', [m[1]]);
      bookId = r.rows[0] ? r.rows[0].book_id : null;
    }
    if (!isList && !bookId) return next();
    const userId = userIdFromReq(req);
    if (!userId) return next();
    await ensureSchema();
    const wins = await userWindows(userId, 'study_book');
    // Livres réservés : un délai « certaines personnes » existe sur ce livre
    const restricted = new Set((await pool.query("SELECT DISTINCT target_id FROM access_deadlines WHERE kind = 'study_book' AND audience = 'selected'")).rows.map((r) => r.target_id));
    if (!wins.length && !restricted.size) return next();
    const role = (await pool.query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
    if (role && role.role === 'admin') return next(); // l'administrateur garde toujours la main
    const now = Date.now();
    const by = groupByTarget(wins);
    if (isList) {
      const orig = res.json.bind(res);
      res.json = (body) => {
        try {
          if (Array.isArray(body)) {
            // Un livre réservé à certaines personnes est invisible pour les autres membres
            body = body.filter((b) => !(restricted.has(b.id) && !stateOf(by[b.id], now))).map((b) => {
              const st = stateOf(by[b.id], now);
              if (!st) return b;
              if (st.state === 'expired') return { ...b, unlocked: false, deadline_expired: true, deadline_ends_at: st.w.ends_at };
              return { ...b, deadline_ends_at: st.w.ends_at };
            });
          }
        } catch (e) { /* la liste reste celle d'origine */ }
        return orig(body);
      };
      return next();
    }
    const st = stateOf(by[bookId], now);
    if (st && st.state === 'expired') {
      return res.status(403).json({ expired: true, message: 'Le délai d\'étude de ce livre est terminé : il est maintenant bloqué.' });
    }
    if (!st && restricted.has(bookId)) {
      return res.status(403).json({ restricted: true, message: 'Ce livre n\'est pas accessible.' });
    }
    next();
  } catch (err) {
    console.error('[délais] contrôle d\'accès :', err.message);
    next(); // en cas de problème, le système existant continue de fonctionner comme avant
  }
}

module.exports = function mountDelais(app, express) {
  // ----- Public / membres : compte à rebours -----
  const pub = express.Router();
  pub.get('/mine', async (req, res) => {
    try {
      await ensureSchema();
      const now = Date.now();
      const userId = userIdFromReq(req);
      const items = [];
      const add = async (kind, wins) => {
        const by = groupByTarget(wins);
        const ids = Object.keys(by).map(Number);
        const titles = await titlesOf(kind, ids);
        ids.forEach((id) => {
          const st = stateOf(by[id], now);
          if (!st) return;
          items.push({ id: st.w.id, kind, target_id: id, title: titles[id] || '', state: st.state, starts_at: st.w.starts_at, ends_at: st.w.ends_at, audience: st.w.audience });
        });
      };
      await add('ebk_session', (await pool.query("SELECT id, kind, target_id, audience, starts_at, ends_at FROM access_deadlines WHERE kind = 'ebk_session'")).rows);
      if (userId) await add('study_book', await userWindows(userId, 'study_book'));
      res.set('Cache-Control', 'no-store').json({ now: new Date().toISOString(), items });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ----- Administration -----
  const adm = express.Router();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[délais]', err.message);
    if (!res.headersSent) res.status(500).json({ message: err.message });
  });

  adm.get('/options', wrap(async (req, res) => {
    await ensureSchema();
    const books = (await pool.query('SELECT id, title FROM books WHERE is_study_book = true ORDER BY order_index ASC NULLS LAST, id ASC')).rows;
    let sessions = [];
    try { sessions = (await pool.query('SELECT id, title, period_label, status, classroom_open, registration_open FROM ebk_sessions ORDER BY position, id')).rows; } catch (e) { /* module EBK absent */ }
    res.json({ books, sessions });
  }));

  adm.get('/users', wrap(async (req, res) => {
    const q = '%' + String(req.query.q || '').trim() + '%';
    const r = await pool.query(
      "SELECT id, full_name, email FROM users WHERE COALESCE(full_name,'') ILIKE $1 OR email ILIKE $1 ORDER BY full_name NULLS LAST, email LIMIT 40", [q]
    );
    res.json(r.rows);
  }));

  adm.get('/', wrap(async (req, res) => {
    await ensureSchema();
    const rows = (await pool.query(
      `SELECT d.*, (SELECT COALESCE(json_agg(json_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) ORDER BY u.full_name), '[]'::json)
                      FROM access_deadline_users du JOIN users u ON u.id = du.user_id WHERE du.deadline_id = d.id) AS users
         FROM access_deadlines d ORDER BY d.ends_at DESC`
    )).rows;
    const titles = {};
    for (const kind of KINDS) {
      titles[kind] = await titlesOf(kind, rows.filter((r) => r.kind === kind).map((r) => r.target_id));
    }
    const now = Date.now();
    res.json({
      now: new Date().toISOString(),
      items: rows.map((r) => ({
        ...r,
        title: titles[r.kind][r.target_id] || '(supprimé)',
        state: new Date(r.ends_at).getTime() <= now ? 'expired' : (new Date(r.starts_at).getTime() > now ? 'scheduled' : 'active'),
      })),
    });
  }));

  adm.post('/', wrap(async (req, res) => {
    await ensureSchema();
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) return res.status(400).json({ message: 'Type invalide.' });
    const targetId = parseInt(b.target_id, 10);
    if (!targetId) return res.status(400).json({ message: 'Choisissez un livre ou une session.' });
    const exists = b.kind === 'study_book'
      ? (await pool.query('SELECT id FROM books WHERE id = $1 AND is_study_book = true', [targetId])).rows[0]
      : (await pool.query('SELECT id FROM ebk_sessions WHERE id = $1', [targetId])).rows[0];
    if (!exists) return res.status(404).json({ message: 'Livre ou session introuvable.' });

    // Une session EBK s'ouvre toujours tout de suite ; un livre d'étude peut avoir un début différé
    const starts = b.kind === 'study_book' && b.starts_at ? new Date(b.starts_at) : new Date();
    if (isNaN(starts.getTime())) return res.status(400).json({ message: 'Date de début invalide.' });
    const ends = b.ends_at ? new Date(b.ends_at) : addDuration(starts, b.duration_value, b.duration_unit);
    if (!ends || isNaN(ends.getTime()) || ends.getTime() <= Date.now() || ends.getTime() <= starts.getTime()) {
      return res.status(400).json({ message: 'La durée ou la date de fin doit se situer dans le futur.' });
    }
    const audience = b.kind === 'study_book' && b.audience === 'selected' ? 'selected' : 'all';
    const userIds = audience === 'selected' ? [...new Set((b.user_ids || []).map(Number).filter(Boolean))] : [];
    if (audience === 'selected' && !userIds.length) return res.status(400).json({ message: 'Choisissez au moins une personne.' });

    if (b.kind === 'ebk_session') {
      // Un nouveau délai remplace les anciens de la même session
      await pool.query("UPDATE access_deadlines SET applied_at = COALESCE(applied_at, now()) WHERE kind = 'ebk_session' AND target_id = $1", [targetId]);
    }
    let prevLocked = null;
    if (b.kind === 'study_book' && audience === 'selected') {
      prevLocked = !!(await pool.query('SELECT admin_locked FROM books WHERE id = $1', [targetId])).rows[0].admin_locked;
    }
    const r = await pool.query(
      'INSERT INTO access_deadlines (kind, target_id, audience, open_registration, starts_at, ends_at, prev_locked) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.kind, targetId, audience, !!b.open_registration, starts, ends, prevLocked]
    );
    const id = r.rows[0].id;
    if (userIds.length) {
      await pool.query('INSERT INTO access_deadline_users (deadline_id, user_id) SELECT $1, id FROM users WHERE id = ANY($2::int[]) ON CONFLICT DO NOTHING', [id, userIds]);
    }
    if (b.open_now !== false && starts.getTime() <= Date.now()) {
      if (b.kind === 'study_book') await pool.query('UPDATE books SET admin_locked = false WHERE id = $1', [targetId]);
      else await openEbkSession(targetId, b.open_registration);
    }
    res.status(201).json({ id });
  }));

  adm.put('/:id', wrap(async (req, res) => {
    await ensureSchema();
    const d = (await pool.query('SELECT * FROM access_deadlines WHERE id = $1', [req.params.id])).rows[0];
    if (!d) return res.status(404).json({ message: 'Délai introuvable.' });
    const b = req.body || {};
    if (b.ends_at !== undefined) {
      const ends = new Date(b.ends_at);
      if (isNaN(ends.getTime()) || ends.getTime() <= new Date(d.starts_at).getTime()) return res.status(400).json({ message: 'Date de fin invalide.' });
      // Prolongé : la fermeture automatique est de nouveau programmée et la session est rouverte
      const reopen = d.kind === 'ebk_session' && ends.getTime() > Date.now();
      await pool.query('UPDATE access_deadlines SET ends_at = $1, applied_at = CASE WHEN $3::boolean THEN NULL ELSE applied_at END WHERE id = $2', [ends, d.id, reopen]);
      if (reopen) await openEbkSession(d.target_id, d.open_registration);
    }
    if (d.kind === 'study_book' && b.audience !== undefined) {
      const audience = b.audience === 'selected' ? 'selected' : 'all';
      const userIds = [...new Set((b.user_ids || []).map(Number).filter(Boolean))];
      if (audience === 'selected' && !userIds.length) return res.status(400).json({ message: 'Choisissez au moins une personne.' });
      await pool.query('UPDATE access_deadlines SET audience = $1 WHERE id = $2', [audience, d.id]);
      await pool.query('DELETE FROM access_deadline_users WHERE deadline_id = $1', [d.id]);
      if (audience === 'selected') await pool.query('INSERT INTO access_deadline_users (deadline_id, user_id) SELECT $1, id FROM users WHERE id = ANY($2::int[]) ON CONFLICT DO NOTHING', [d.id, userIds]);
    }
    await sweep(); // si la date de fin est maintenant passée, la session se ferme tout de suite
    res.json({ ok: true });
  }));

  adm.delete('/:id', wrap(async (req, res) => {
    await ensureSchema();
    const d = (await pool.query('SELECT * FROM access_deadlines WHERE id = $1', [req.params.id])).rows[0];
    await pool.query('DELETE FROM access_deadlines WHERE id = $1', [req.params.id]);
    // Livre réservé qui avait été ouvert pour ce délai : il retrouve son état d'avant (verrouillé) si plus aucun délai réservé ne le concerne
    if (d && d.kind === 'study_book' && d.audience === 'selected' && d.prev_locked === true) {
      const left = (await pool.query("SELECT 1 FROM access_deadlines WHERE kind = 'study_book' AND target_id = $1 AND audience = 'selected' LIMIT 1", [d.target_id])).rows[0];
      if (!left) await pool.query('UPDATE books SET admin_locked = true WHERE id = $1', [d.target_id]);
    }
    res.status(204).end();
  }));

  // Ordre important : ces lignes passent AVANT l'EBK et l'espace d'étude
  app.use('/api/ebk', lazySweep);
  app.use('/api/study', studyGuard);
  app.use('/api/delais', express.json(), pub);
  app.use('/api/admin/delais', express.json(), requireAuth, requireAdmin, adm);

  ensureSchema().then(sweep).catch((err) => console.error('[délais] base de données :', err.message));
  setInterval(sweep, 60 * 1000);
};
