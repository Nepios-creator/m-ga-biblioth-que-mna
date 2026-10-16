// Routes du module « Actualités chrétiennes » — montées sur /api/actualites
//   Public  : liste, filtres, lecture d'une actualité, images
//   Admin   : publication manuelle, import par lien, propositions quotidiennes, sources, traduction
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../lib/auth-middleware');
const { CATEGORIES, REGIONS } = require('./db');
const { sanitizeHtml, escapeHtml, safeUrl } = require('./html-tools');
const { extractFromUrl } = require('./extract-article');
const { fetchImage } = require('./fetch-page');
const { runDailyFetch, getMeta, guessCategory } = require('./feeds');
const { translateToFrench } = require('./translate');

const CAT_KEYS = new Set(CATEGORIES.map((c) => c[0]));
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/;

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (!err.status) console.error('[actualités]', err);
  res.status(err.status || 500).json({ message: err.status ? err.message : 'Erreur du serveur : ' + err.message, ...(err.extra || {}) });
});
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isTrue = (v) => v === true || v === 'true' || v === '1' || v === 'on';
const parseJson = (v, fallback) => { if (typeof v !== 'string') return v == null ? fallback : v; try { return JSON.parse(v); } catch (e) { return fallback; } };

const COVER_SQL = `COALESCE((SELECT '/api/actualites/images/' || i.id FROM actu_images i WHERE i.article_id = a.id AND i.is_cover ORDER BY i.id DESC LIMIT 1), a.cover_url)`;
const LIST_COLS = `a.id, a.title, a.summary, a.category, a.region, a.country, a.language, a.source_name, a.featured, a.status, a.origin, a.views,
  COALESCE(a.published_at, a.created_at) AS date, a.created_at, ${COVER_SQL} AS cover`;

function videoEmbed(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '');
    const ytId = (id) => (id && /^[\w-]{6,20}$/.test(id) ? 'https://www.youtube-nocookie.com/embed/' + id : null);
    if (h === 'youtu.be') return ytId(url.pathname.slice(1).split('/')[0]);
    if (h === 'youtube.com' || h === 'm.youtube.com') return ytId(url.searchParams.get('v') || (/^\/(?:embed|shorts|live)\/([\w-]+)/.exec(url.pathname) || [])[1]);
    if (h === 'vimeo.com') { const m = /^\/(\d+)/.exec(url.pathname); return m ? 'https://player.vimeo.com/video/' + m[1] : null; }
  } catch (e) { /* adresse invalide */ }
  return null;
}

// Vérifie et nettoie les champs envoyés par le formulaire
function cleanFields(b) {
  const title = clip(b.title, 300);
  if (!title) throw httpError(400, 'Le titre est obligatoire.');
  const body = sanitizeHtml(b.body_html || '');
  if (!body) throw httpError(400, 'Le texte de l\'actualité est vide.');
  const contacts = (Array.isArray(parseJson(b.contacts, [])) ? parseJson(b.contacts, []) : []).slice(0, 12)
    .map((c) => ({ label: clip(c && c.label, 60), value: clip(c && c.value, 200) })).filter((c) => c.value);
  const when = b.published_at ? new Date(b.published_at) : null;
  return {
    title,
    summary: clip(b.summary, 600) || null,
    body_html: body,
    category: CAT_KEYS.has(b.category) ? b.category : 'eglise',
    region: clip(b.region, 60) || null,
    country: clip(b.country, 80) || null,
    language: /^[a-z]{2}$/.test(String(b.language || '')) ? b.language : 'fr',
    source_name: clip(b.source_name, 120) || null,
    source_url: /^https?:/i.test(b.source_url || '') ? safeUrl(b.source_url) || null : null,
    author: clip(b.author, 120) || null,
    published_at: when && !isNaN(when.getTime()) ? when.toISOString() : null,
    contacts,
    tags: String(b.tags || '').split(',').map((t) => clip(t, 30)).filter(Boolean).slice(0, 10),
    video_url: b.video_url && videoEmbed(b.video_url) ? clip(b.video_url, 300) : null,
    status: b.status === 'brouillon' ? 'brouillon' : 'publie',
    featured: isTrue(b.featured),
  };
}

// Crée ou met à jour une actualité, avec ses images
async function saveArticle({ id, fields, files = {}, remoteCover, removeImageIds = [], removeCover = false, captions = [], origin = 'manuel', userId, suggestionId }) {
  let cover = null;
  let fallbackCoverUrl = null;
  if (files.cover && files.cover[0]) {
    cover = { buffer: files.cover[0].buffer, mime: files.cover[0].mimetype };
  } else if (remoteCover) {
    try { cover = await fetchImage(remoteCover); } catch (e) { fallbackCoverUrl = safeUrl(remoteCover) || null; }
  }

  const f = fields;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let articleId = id;
    if (id) {
      const r = await client.query(
        `UPDATE actu_articles SET title=$1, summary=$2, body_html=$3, category=$4, region=$5, country=$6, language=$7, source_name=$8,
           source_url=$9, author=$10, published_at=$11, contacts=$12::jsonb, tags=$13, video_url=$14, status=$15, featured=$16, updated_at=now()
         WHERE id=$17 RETURNING id`,
        [f.title, f.summary, f.body_html, f.category, f.region, f.country, f.language, f.source_name, f.source_url, f.author,
          f.published_at, JSON.stringify(f.contacts), f.tags, f.video_url, f.status, f.featured, id]
      );
      if (!r.rows.length) throw httpError(404, 'Actualité introuvable.');
    } else {
      const r = await client.query(
        `INSERT INTO actu_articles (title, summary, body_html, category, region, country, language, source_name, source_url, author,
           published_at, contacts, tags, video_url, status, featured, origin, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [f.title, f.summary, f.body_html, f.category, f.region, f.country, f.language, f.source_name, f.source_url, f.author,
          f.published_at, JSON.stringify(f.contacts), f.tags, f.video_url, f.status, f.featured, origin, userId || null]
      );
      articleId = r.rows[0].id;
    }

    if (removeCover) {
      await client.query('DELETE FROM actu_images WHERE article_id = $1 AND is_cover', [articleId]);
      await client.query('UPDATE actu_articles SET cover_url = NULL WHERE id = $1', [articleId]);
    }
    if (cover) {
      await client.query('DELETE FROM actu_images WHERE article_id = $1 AND is_cover', [articleId]);
      await client.query('INSERT INTO actu_images (article_id, mime, data, is_cover) VALUES ($1,$2,$3,true)', [articleId, cover.mime, cover.buffer]);
      await client.query('UPDATE actu_articles SET cover_url = NULL WHERE id = $1', [articleId]);
    } else if (fallbackCoverUrl) {
      await client.query('UPDATE actu_articles SET cover_url = $2 WHERE id = $1', [articleId, fallbackCoverUrl]);
    }

    const ids = removeImageIds.map(Number).filter(Number.isInteger);
    if (ids.length) await client.query('DELETE FROM actu_images WHERE article_id = $1 AND NOT is_cover AND id = ANY($2::int[])', [articleId, ids]);
    const gallery = files.images || [];
    if (gallery.length) {
      const pos = (await client.query('SELECT COALESCE(max(position), 0)::int AS p FROM actu_images WHERE article_id = $1', [articleId])).rows[0].p;
      for (let i = 0; i < gallery.length; i++) {
        await client.query(
          'INSERT INTO actu_images (article_id, mime, data, caption, position) VALUES ($1,$2,$3,$4,$5)',
          [articleId, gallery[i].mimetype, gallery[i].buffer, clip(captions[i], 200) || null, pos + i + 1]
        );
      }
    }
    if (suggestionId) {
      await client.query("UPDATE actu_suggestions SET status = 'validee', article_id = $1 WHERE id = $2", [articleId, suggestionId]);
    }
    await client.query('COMMIT');
    return articleId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = function buildRouter(express) {
  const router = express.Router();
  router.use(express.json({ limit: '8mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => cb(null, IMAGE_MIME.test(file.mimetype)),
  });
  const uploadFields = (req, res, next) => upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'images', maxCount: 8 }])(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'Une image dépasse 5 Mo.' : 'Envoi des images impossible.' });
    next();
  });

  // =====================================================================
  //  ADMINISTRATION
  // =====================================================================
  const admin = express.Router();
  admin.use(requireAuth, requireAdmin);

  admin.get('/status', wrap(async (req, res) => {
    const pending = (await pool.query("SELECT count(*)::int AS n FROM actu_suggestions WHERE status = 'nouvelle'")).rows[0].n;
    res.json({ last_fetch_at: await getMeta('last_fetch_at'), pending, translation: !!process.env.MISTRAL_API_KEY, categories: CATEGORIES.map(([key, label]) => ({ key, label })), regions: REGIONS });
  }));

  admin.get('/articles', wrap(async (req, res) => {
    const params = [];
    const where = [];
    if (['publie', 'brouillon'].includes(req.query.status)) { params.push(req.query.status); where.push(`a.status = $${params.length}`); }
    const q = String(req.query.q || '').trim();
    if (q.length >= 2) { params.push('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); where.push(`(a.title ILIKE $${params.length} OR a.source_name ILIKE $${params.length})`); }
    const rows = (await pool.query(
      `SELECT ${LIST_COLS} FROM actu_articles a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC LIMIT 200`, params
    )).rows;
    res.json(rows);
  }));

  admin.get('/articles/:id(\\d+)', wrap(async (req, res) => {
    const a = (await pool.query(`SELECT a.*, ${COVER_SQL} AS cover FROM actu_articles a WHERE a.id = $1`, [req.params.id])).rows[0];
    if (!a) throw httpError(404, 'Actualité introuvable.');
    a.images = (await pool.query('SELECT id, caption FROM actu_images WHERE article_id = $1 AND NOT is_cover ORDER BY position, id', [a.id])).rows;
    res.json(a);
  }));

  admin.post('/articles', uploadFields, wrap(async (req, res) => {
    const b = req.body || {};
    const fields = cleanFields(b);
    const origin = ['lien', 'suggestion'].includes(b.origin) ? b.origin : 'manuel';
    const id = await saveArticle({
      fields, files: req.files, remoteCover: /^https?:/i.test(b.cover_remote_url || '') ? b.cover_remote_url : null,
      captions: parseJson(b.captions, []), origin, userId: req.user.id, suggestionId: parseInt(b.suggestion_id, 10) || null,
    });
    res.status(201).json({ id, message: fields.status === 'publie' ? 'Actualité publiée.' : 'Brouillon enregistré.' });
  }));

  admin.put('/articles/:id(\\d+)', uploadFields, wrap(async (req, res) => {
    const b = req.body || {};
    const fields = cleanFields(b);
    await saveArticle({
      id: Number(req.params.id), fields, files: req.files, remoteCover: /^https?:/i.test(b.cover_remote_url || '') ? b.cover_remote_url : null,
      removeImageIds: parseJson(b.remove_image_ids, []), removeCover: isTrue(b.remove_cover), captions: parseJson(b.captions, []),
    });
    res.json({ id: Number(req.params.id), message: 'Actualité mise à jour.' });
  }));

  // Changement rapide : publier / masquer / mettre à la une
  admin.patch('/articles/:id(\\d+)', wrap(async (req, res) => {
    const sets = [];
    const params = [req.params.id];
    if (['publie', 'brouillon'].includes(req.body.status)) { params.push(req.body.status); sets.push(`status = $${params.length}`); }
    if (typeof req.body.featured === 'boolean') { params.push(req.body.featured); sets.push(`featured = $${params.length}`); }
    if (!sets.length) throw httpError(400, 'Rien à modifier.');
    const r = await pool.query(`UPDATE actu_articles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id, status, featured`, params);
    if (!r.rows.length) throw httpError(404, 'Actualité introuvable.');
    res.json(r.rows[0]);
  }));

  admin.delete('/articles/:id(\\d+)', wrap(async (req, res) => {
    await pool.query('DELETE FROM actu_articles WHERE id = $1', [req.params.id]);
    res.status(204).end();
  }));

  // Import à partir d'un lien : lit la publication et prépare l'actualité (ou la publie directement)
  admin.post('/import', wrap(async (req, res) => {
    const url = clip(req.body.url, 1000);
    if (!/^https?:\/\//i.test(url)) throw httpError(400, 'Collez un lien complet, commençant par https://');
    let draft;
    try { draft = await extractFromUrl(url); } catch (e) { throw httpError(422, e.message); }
    const dup = (await pool.query('SELECT id FROM actu_articles WHERE source_url = $1 LIMIT 1', [draft.source_url])).rows[0];
    draft.category = guessCategory(draft.title + ' ' + draft.summary, 'eglise');
    draft.existing_id = dup ? dup.id : null;

    if (isTrue(req.body.publish)) {
      if (dup) throw httpError(409, 'Cette publication est déjà en ligne.', { existing_id: dup.id });
      if (draft.partial || draft.uncertain || draft.not_french) {
        throw httpError(422, draft.not_french ? 'Ce texte ne semble pas rédigé en français : vérifiez-le avant de publier.' : 'Le texte n\'a pas pu être lu entièrement : vérifiez-le avant de publier.', { draft, needs_edit: true });
      }
      const id = await saveArticle({ fields: cleanFields({ ...draft, status: 'publie' }), remoteCover: draft.cover_url, origin: 'lien', userId: req.user.id });
      return res.status(201).json({ id, message: 'Publication importée et mise en ligne.' });
    }
    res.json({ draft });
  }));

  // ----- Propositions quotidiennes -----
  admin.get('/suggestions', wrap(async (req, res) => {
    const status = ['nouvelle', 'validee', 'rejetee'].includes(req.query.status) ? req.query.status : 'nouvelle';
    const rows = (await pool.query(
      'SELECT * FROM actu_suggestions WHERE status = $1 ORDER BY COALESCE(published_at, created_at) DESC LIMIT 150', [status]
    )).rows;
    res.json(rows);
  }));

  async function suggestionDraft(s) {
    let draft;
    try {
      draft = await extractFromUrl(s.link);
    } catch (e) {
      draft = {
        title: s.title, summary: s.summary, body_html: s.summary ? `<p>${escapeHtml(s.summary)}</p>` : '', cover_url: s.image_url,
        source_url: s.link, published_at: s.published_at, language: s.language, partial: true, uncertain: false,
        notes: ['Le texte complet n\'a pas pu être lu : ' + e.message],
      };
    }
    draft.title = draft.title || s.title;
    draft.category = s.category;
    draft.region = s.region;
    draft.source_name = s.source_name || draft.source_name;
    draft.language = draft.language || s.language;
    draft.cover_url = draft.cover_url || s.image_url;
    draft.suggestion_id = s.id;
    return draft;
  }

  // Ouvre la proposition dans l'éditeur (pour la modifier avant publication)
  admin.post('/suggestions/:id(\\d+)/prepare', wrap(async (req, res) => {
    const s = (await pool.query('SELECT * FROM actu_suggestions WHERE id = $1', [req.params.id])).rows[0];
    if (!s) throw httpError(404, 'Proposition introuvable.');
    res.json({ draft: await suggestionDraft(s) });
  }));

  // Valide la proposition telle quelle et la publie
  admin.post('/suggestions/:id(\\d+)/publish', wrap(async (req, res) => {
    const s = (await pool.query('SELECT * FROM actu_suggestions WHERE id = $1', [req.params.id])).rows[0];
    if (!s) throw httpError(404, 'Proposition introuvable.');
    if (s.status === 'validee') throw httpError(409, 'Cette proposition a déjà été publiée.');
    const draft = await suggestionDraft(s);
    if (draft.partial || draft.uncertain || draft.not_french) {
      throw httpError(422, 'Le texte complet n\'est pas disponible automatiquement : ouvrez-la en modification pour le compléter.', { needs_edit: true });
    }
    const id = await saveArticle({ fields: cleanFields({ ...draft, status: 'publie' }), remoteCover: draft.cover_url, origin: 'suggestion', userId: req.user.id, suggestionId: s.id });
    res.status(201).json({ id, message: 'Actualité publiée.' });
  }));

  admin.post('/suggestions/:id(\\d+)/reject', wrap(async (req, res) => {
    await pool.query("UPDATE actu_suggestions SET status = 'rejetee' WHERE id = $1 AND status = 'nouvelle'", [req.params.id]);
    res.json({ ok: true });
  }));

  admin.post('/suggestions/refresh', wrap(async (req, res) => {
    const r = await runDailyFetch();
    if (r.running) throw httpError(409, 'Une recherche est déjà en cours, réessayez dans un instant.');
    res.json(r);
  }));

  // ----- Sources officielles -----
  admin.get('/sources', wrap(async (req, res) => {
    res.json((await pool.query('SELECT * FROM actu_sources ORDER BY id')).rows);
  }));

  admin.post('/sources', wrap(async (req, res) => {
    const b = req.body;
    const name = clip(b.name, 120);
    const site = /^https?:\/\//i.test(b.site_url || '') ? safeUrl(b.site_url) : '';
    if (!name || !site) throw httpError(400, 'Indiquez le nom et l\'adresse du site (https://…).');
    const feed = /^https?:\/\//i.test(b.feed_url || '') ? safeUrl(b.feed_url) : null;
    const r = await pool.query(
      'INSERT INTO actu_sources (name, site_url, feed_url, language, region, category) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, site, feed || null, /^[a-z]{2}$/.test(b.language || '') ? b.language : 'fr', clip(b.region, 60) || 'Monde', CAT_KEYS.has(b.category) ? b.category : 'eglise']
    );
    res.status(201).json(r.rows[0]);
  }));

  admin.put('/sources/:id(\\d+)', wrap(async (req, res) => {
    const sets = [];
    const params = [req.params.id];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (typeof req.body.enabled === 'boolean') set('enabled', req.body.enabled);
    if (req.body.feed_url !== undefined) set('feed_url', /^https?:\/\//i.test(req.body.feed_url) ? safeUrl(req.body.feed_url) || null : null);
    if (req.body.name) set('name', clip(req.body.name, 120));
    if (!sets.length) throw httpError(400, 'Rien à modifier.');
    const r = await pool.query(`UPDATE actu_sources SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!r.rows.length) throw httpError(404, 'Source introuvable.');
    res.json(r.rows[0]);
  }));

  admin.delete('/sources/:id(\\d+)', wrap(async (req, res) => {
    await pool.query('DELETE FROM actu_sources WHERE id = $1', [req.params.id]);
    res.status(204).end();
  }));

  admin.post('/translate', wrap(async (req, res) => {
    try {
      res.json(await translateToFrench({ title: clip(req.body.title, 300), summary: clip(req.body.summary, 600), body_html: sanitizeHtml(req.body.body_html || '') }));
    } catch (e) { throw httpError(422, e.message); }
  }));

  router.use('/admin', admin);

  // =====================================================================
  //  PUBLIC (aucune connexion nécessaire)
  // =====================================================================
  router.get('/meta', wrap(async (req, res) => {
    const cats = (await pool.query("SELECT category, count(*)::int AS n FROM actu_articles WHERE status = 'publie' GROUP BY category")).rows;
    const regions = (await pool.query("SELECT region AS name, count(*)::int AS n FROM actu_articles WHERE status = 'publie' AND region IS NOT NULL GROUP BY region ORDER BY n DESC")).rows;
    const langs = (await pool.query("SELECT language AS code, count(*)::int AS n FROM actu_articles WHERE status = 'publie' GROUP BY language ORDER BY n DESC")).rows;
    const byCat = Object.fromEntries(cats.map((c) => [c.category, c.n]));
    res.header('Cache-Control', 'no-cache');
    res.json({ categories: CATEGORIES.map(([key, label]) => ({ key, label, count: byCat[key] || 0 })), regions, languages: langs });
  }));

  router.get('/', wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const where = ["a.status = 'publie'"];
    const params = [];
    if (CAT_KEYS.has(req.query.category)) { params.push(req.query.category); where.push(`a.category = $${params.length}`); }
    if (req.query.region) { params.push(clip(req.query.region, 60)); where.push(`a.region = $${params.length}`); }
    if (/^[a-z]{2}$/.test(String(req.query.lang || ''))) { params.push(req.query.lang); where.push(`a.language = $${params.length}`); }
    const q = String(req.query.q || '').trim();
    if (q.length >= 2) {
      params.push('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
      const n = params.length;
      where.push(`(a.title ILIKE $${n} OR a.summary ILIKE $${n} OR a.source_name ILIKE $${n} OR a.country ILIKE $${n} OR array_to_string(a.tags, ' ') ILIKE $${n})`);
    }
    const w = where.join(' AND ');
    const total = (await pool.query(`SELECT count(*)::int AS n FROM actu_articles a WHERE ${w}`, params)).rows[0].n;
    params.push(limit, (page - 1) * limit);
    const items = (await pool.query(
      `SELECT ${LIST_COLS} FROM actu_articles a WHERE ${w} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    )).rows;
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  }));

  router.get('/images/:id(\\d+)', wrap(async (req, res) => {
    const img = (await pool.query('SELECT mime, data FROM actu_images WHERE id = $1', [req.params.id])).rows[0];
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(img.data);
  }));

  router.get('/:id(\\d+)', wrap(async (req, res) => {
    const a = (await pool.query(
      `SELECT a.id, a.title, a.summary, a.body_html, a.category, a.region, a.country, a.language, a.source_name, a.source_url, a.author,
              a.contacts, a.tags, a.video_url, a.featured, a.views, COALESCE(a.published_at, a.created_at) AS date, ${COVER_SQL} AS cover
       FROM actu_articles a WHERE a.id = $1 AND a.status = 'publie'`, [req.params.id]
    )).rows[0];
    if (!a) throw httpError(404, 'Cette actualité n\'existe pas ou n\'est plus en ligne.');
    a.body_html = sanitizeHtml(a.body_html);
    a.images = (await pool.query('SELECT id, caption FROM actu_images WHERE article_id = $1 AND NOT is_cover ORDER BY position, id', [a.id])).rows;
    a.video_embed = a.video_url ? videoEmbed(a.video_url) : null;
    a.related = (await pool.query(
      `SELECT ${LIST_COLS} FROM actu_articles a WHERE a.status = 'publie' AND a.id <> $1 AND (a.category = $2 OR (a.region IS NOT NULL AND a.region = $3))
       ORDER BY a.created_at DESC LIMIT 3`, [a.id, a.category, a.region]
    )).rows;
    pool.query('UPDATE actu_articles SET views = views + 1 WHERE id = $1', [a.id]).catch(() => {});
    res.json(a);
  }));

  return router;
};
