const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, JWT_SECRET } = require('../lib/auth-middleware');

// Fuseau horaire utilisé pour découper les journées (Kinshasa par défaut)
const TZ = process.env.STATS_TZ || 'Africa/Kinshasa';

// ---------- Préparation automatique : la table est créée au démarrage si elle n'existe pas ----------
const tablesReady = (async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS page_views (
        id BIGSERIAL PRIMARY KEY,
        viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        visitor_id TEXT NOT NULL,
        session_id TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        path TEXT NOT NULL,
        ref_host TEXT,
        device TEXT NOT NULL DEFAULT 'ordinateur',
        installed BOOLEAN NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS page_views_time_idx ON page_views (viewed_at);
      CREATE INDEX IF NOT EXISTS page_views_visitor_idx ON page_views (visitor_id);
      CREATE INDEX IF NOT EXISTS page_views_user_idx ON page_views (user_id) WHERE user_id IS NOT NULL;
    `);
    // On ne garde pas l'historique au-delà de ~2 ans
    await pool.query("DELETE FROM page_views WHERE viewed_at < now() - interval '800 days'");
  } catch (err) {
    console.error('Statistiques : création de la table impossible :', err.message);
  }
})();

// =====================================================================
//  COMPTAGE DES VISITES (public, anonyme)
// =====================================================================
const trackRouter = express.Router();

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|headless|lighthouse|pingdom|uptime/i;

// Limite simple par adresse (en mémoire, rien n'est enregistré) pour éviter qu'on gonfle les chiffres
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.reset < now) { hits.set(ip, { count: 1, reset: now + 60000 }); return false; }
  entry.count += 1;
  return entry.count > 120;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60000).unref();

function deviceOf(ua) {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablette';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'téléphone';
  return 'ordinateur';
}

trackRouter.post('/', async (req, res) => {
  res.status(204).end(); // on répond tout de suite : le comptage ne ralentit jamais la page
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (tooMany(ip)) return;
    const ua = String(req.headers['user-agent'] || '');
    if (BOT_RE.test(ua)) return;

    const b = req.body || {};
    const vid = String(b.vid || '');
    const sid = String(b.sid || '');
    if (!ID_RE.test(vid)) return;

    let path = String(b.path || '/').split('?')[0].split('#')[0];
    if (!path.startsWith('/') || path.length > 200) return;
    if (path === '/index.html') path = '/';
    if (/^\/(admin|api)/i.test(path)) return;

    // Membre connecté ? (le jeton est facultatif). Les visites de l'administrateur ne sont pas comptées.
    let userId = null;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(header.slice(7), JWT_SECRET);
        if (payload.role === 'admin') return;
        userId = payload.id;
      } catch (e) { /* visiteur non connecté */ }
    }

    // D'où vient le visiteur (site ou réseau social), sans compter nos propres pages
    let refHost = null;
    try {
      if (b.ref) {
        const h = new URL(String(b.ref)).hostname.replace(/^www\./, '').toLowerCase();
        const own = String(req.headers.host || '').split(':')[0].replace(/^www\./, '').toLowerCase();
        if (h && h !== own && !h.includes('ministeredelanouvellealliance')) refHost = h.slice(0, 100);
      }
    } catch (e) { /* adresse illisible : on ignore */ }

    await tablesReady;
    await pool.query(
      `INSERT INTO page_views (visitor_id, session_id, user_id, path, ref_host, device, installed)
       VALUES ($1, $2, (SELECT id FROM users WHERE id = $3), $4, $5, $6, $7)`,
      [vid, ID_RE.test(sid) ? sid : null, userId, path, refHost, deviceOf(ua), b.standalone === true]
    );
  } catch (err) {
    console.error('Comptage des visites :', err.message);
  }
});

// =====================================================================
//  STATISTIQUES (réservées à l'administration)
// =====================================================================
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);

// Jour local (Kinshasa) d'une colonne horodatée — $1 = fuseau horaire
const day = (col) => `(${col} AT TIME ZONE $1::text)::date`;
const today = `(now() AT TIME ZONE $1::text)::date`;
const inPeriod = (col) => `${day(col)} > ${today} - $2::int`; // $2 = nombre de jours

adminRouter.get('/', async (req, res) => {
  const days = [7, 30, 90, 180, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  try {
    await tablesReady;
    const [totals, live, series, pages, devices, referrers, hours, visitors, members, active, tracking] = await Promise.all([
      pool.query(
        `WITH pv AS (
           SELECT ${day('viewed_at')} AS d, visitor_id, session_id FROM page_views WHERE viewed_at >= now() - interval '40 days'
         ), t AS (SELECT ${today} AS today)
         SELECT
           count(*) FILTER (WHERE d = t.today)::int AS today_views,
           count(DISTINCT visitor_id) FILTER (WHERE d = t.today)::int AS today_visitors,
           count(DISTINCT session_id) FILTER (WHERE d = t.today)::int AS today_sessions,
           count(*) FILTER (WHERE d = t.today - 1)::int AS yest_views,
           count(DISTINCT visitor_id) FILTER (WHERE d = t.today - 1)::int AS yest_visitors,
           count(DISTINCT session_id) FILTER (WHERE d = t.today - 1)::int AS yest_sessions,
           count(*) FILTER (WHERE d > t.today - 7)::int AS week_views,
           count(DISTINCT visitor_id) FILTER (WHERE d > t.today - 7)::int AS week_visitors,
           count(DISTINCT session_id) FILTER (WHERE d > t.today - 7)::int AS week_sessions,
           count(*) FILTER (WHERE d > t.today - 30)::int AS month_views,
           count(DISTINCT visitor_id) FILTER (WHERE d > t.today - 30)::int AS month_visitors,
           count(DISTINCT session_id) FILTER (WHERE d > t.today - 30)::int AS month_sessions
         FROM pv, t`,
        [TZ]
      ),
      pool.query("SELECT count(DISTINCT visitor_id)::int AS n FROM page_views WHERE viewed_at > now() - interval '30 minutes'"),
      pool.query(
        `SELECT to_char(days.dd, 'YYYY-MM-DD') AS day,
                coalesce(v.views, 0)::int AS views, coalesce(v.visitors, 0)::int AS visitors,
                coalesce(v.sessions, 0)::int AS sessions, coalesce(s.n, 0)::int AS signups
         FROM (SELECT (${today} - i) AS dd FROM generate_series(0, $2::int - 1) AS i) days
         LEFT JOIN (
           SELECT ${day('viewed_at')} AS d, count(*) AS views, count(DISTINCT visitor_id) AS visitors, count(DISTINCT session_id) AS sessions
           FROM page_views WHERE ${inPeriod('viewed_at')} GROUP BY 1
         ) v ON v.d = days.dd
         LEFT JOIN (
           SELECT ${day('created_at')} AS d, count(*) AS n FROM users WHERE ${inPeriod('created_at')} GROUP BY 1
         ) s ON s.d = days.dd
         ORDER BY days.dd`,
        [TZ, days]
      ),
      pool.query(
        `SELECT path, count(*)::int AS views, count(DISTINCT visitor_id)::int AS visitors
         FROM page_views WHERE ${inPeriod('viewed_at')} GROUP BY path ORDER BY views DESC LIMIT 15`,
        [TZ, days]
      ),
      pool.query(
        `SELECT device, count(*)::int AS views, count(DISTINCT visitor_id)::int AS visitors,
                count(DISTINCT visitor_id) FILTER (WHERE installed)::int AS installed_visitors
         FROM page_views WHERE ${inPeriod('viewed_at')} GROUP BY device ORDER BY visitors DESC`,
        [TZ, days]
      ),
      pool.query(
        `SELECT coalesce(ref_host, 'direct') AS source, count(*)::int AS views, count(DISTINCT visitor_id)::int AS visitors
         FROM page_views WHERE ${inPeriod('viewed_at')} GROUP BY 1 ORDER BY visitors DESC, views DESC LIMIT 12`,
        [TZ, days]
      ),
      pool.query(
        `SELECT extract(hour FROM (viewed_at AT TIME ZONE $1::text))::int AS h, count(*)::int AS n
         FROM page_views WHERE ${inPeriod('viewed_at')} GROUP BY 1`,
        [TZ, days]
      ),
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE first_seen > ${today} - $2::int)::int AS new_visitors
         FROM (
           SELECT visitor_id, min(${day('viewed_at')}) AS first_seen, max(${day('viewed_at')}) AS last_seen
           FROM page_views GROUP BY visitor_id
         ) x WHERE last_seen > ${today} - $2::int`,
        [TZ, days]
      ),
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ${day('created_at')} = ${today})::int AS today,
                count(*) FILTER (WHERE ${day('created_at')} > ${today} - 7)::int AS week,
                count(*) FILTER (WHERE ${day('created_at')} > ${today} - 30)::int AS month
         FROM users`,
        [TZ]
      ),
      pool.query(
        `SELECT count(DISTINCT user_id)::int AS n FROM page_views WHERE user_id IS NOT NULL AND ${inPeriod('viewed_at')}`,
        [TZ, days]
      ),
      pool.query('SELECT min(viewed_at) AS since, count(*)::int AS total FROM page_views'),
    ]);

    const t = totals.rows[0];
    const hourMap = new Map(hours.rows.map((r) => [r.h, r.n]));
    res.json({
      tz: TZ,
      days,
      online_30min: live.rows[0].n,
      totals: {
        today: { views: t.today_views, visitors: t.today_visitors, sessions: t.today_sessions },
        yesterday: { views: t.yest_views, visitors: t.yest_visitors, sessions: t.yest_sessions },
        week: { views: t.week_views, visitors: t.week_visitors, sessions: t.week_sessions },
        month: { views: t.month_views, visitors: t.month_visitors, sessions: t.month_sessions },
      },
      series: series.rows,
      pages: pages.rows,
      devices: devices.rows,
      referrers: referrers.rows,
      hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, views: hourMap.get(h) || 0 })),
      visitors: { total: visitors.rows[0].total, new: visitors.rows[0].new_visitors, returning: visitors.rows[0].total - visitors.rows[0].new_visitors },
      members: { ...members.rows[0], active_in_period: active.rows[0].n },
      tracking: { since: tracking.rows[0].since, total_views: tracking.rows[0].total },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = { trackRouter, adminRouter, tablesReady };
