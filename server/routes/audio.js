const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../lib/auth-middleware');

const router = express.Router();
const BUCKET = 'audiobooks';
const MAX_FILE = 50 * 1024 * 1024; // 50 Mo : limite d'un fichier sur le plan gratuit de Supabase
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.wav', '.webm', '.mp4'];
const uploadCover = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- Stockage des fichiers audio (Supabase Storage) ----------

function storageConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  return url && key ? { url, key } : null;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// ---------- Préparation automatique (aucune action manuelle requise) ----------
// Les tables sont créées au démarrage du serveur si elles n'existent pas encore.
const tablesReady = (async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audiobooks (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        description TEXT,
        access_type TEXT NOT NULL DEFAULT 'gratuit' CHECK (access_type IN ('gratuit', 'a_vendre')),
        price NUMERIC(10,2),
        published BOOLEAN NOT NULL DEFAULT false,
        cover_data BYTEA,
        cover_mime TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS audio_tracks (
        id SERIAL PRIMARY KEY,
        audiobook_id INTEGER NOT NULL REFERENCES audiobooks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        track_order INTEGER NOT NULL DEFAULT 1,
        storage_path TEXT NOT NULL,
        mime TEXT,
        size_bytes BIGINT,
        duration_seconds INTEGER,
        is_preview BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS audio_tracks_book_idx ON audio_tracks (audiobook_id, track_order);
      CREATE TABLE IF NOT EXISTS audiobook_access (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        audiobook_id INTEGER NOT NULL REFERENCES audiobooks(id) ON DELETE CASCADE,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, audiobook_id)
      );
      CREATE TABLE IF NOT EXISTS audio_progress (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id INTEGER NOT NULL REFERENCES audio_tracks(id) ON DELETE CASCADE,
        position_seconds INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, track_id)
      );
    `);
  } catch (err) {
    console.error('Livres audio : création des tables impossible :', err.message);
  }
})();

// Le dossier privé « audiobooks » est créé automatiquement dans Supabase Storage s'il n'existe pas.
let bucketOk = false;
let bucketError = '';
async function ensureBucket() {
  if (bucketOk) return true;
  const cfg = storageConfig();
  if (!cfg) return false;
  try {
    const headers = { apikey: cfg.key, 'Content-Type': 'application/json' };
    if (cfg.key.startsWith('eyJ')) headers.Authorization = `Bearer ${cfg.key}`;
    const response = await fetch(`${cfg.url}/storage/v1/bucket`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: MAX_FILE }),
    });
    const data = await response.json().catch(() => ({}));
    const text = String(data.message || data.error || '').toLowerCase();
    if (response.ok || response.status === 409 || text.includes('already exists') || text.includes('duplicate')) {
      bucketOk = true; bucketError = '';
    } else {
      bucketError = data.message || data.error || `Erreur ${response.status}`;
    }
  } catch (err) {
    bucketError = err.message;
  }
  return bucketOk;
}

async function storageFetch(path, options = {}) {
  const cfg = storageConfig();
  if (!cfg) throw new Error('Le stockage audio n\'est pas encore configuré (clé Supabase manquante sur Render).');
  const headers = { apikey: cfg.key, 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cfg.key.startsWith('eyJ')) headers.Authorization = `Bearer ${cfg.key}`;
  const response = await fetch(`${cfg.url}/storage/v1${path}`, { ...options, headers });
  return { response, base: cfg.url };
}

// Lien d'écoute temporaire (6 h) vers un fichier privé
async function createSignedDownloadUrl(storagePath, seconds) {
  const { response, base } = await storageFetch(`/object/sign/${BUCKET}/${encodePath(storagePath)}`, {
    method: 'POST', body: JSON.stringify({ expiresIn: seconds }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.signedURL) throw new Error(data.message || data.error || 'Impossible de préparer le fichier audio');
  return `${base}/storage/v1${data.signedURL}`;
}

// Lien d'envoi : le navigateur envoie le fichier directement au stockage, sans passer par le serveur
async function createSignedUploadUrl(storagePath) {
  const { response, base } = await storageFetch(`/object/upload/sign/${BUCKET}/${encodePath(storagePath)}`, {
    method: 'POST', headers: { 'x-upsert': 'false' }, body: '{}',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) throw new Error(data.message || data.error || 'Impossible de préparer l\'envoi du fichier');
  return `${base}/storage/v1${data.url}`;
}

async function deleteStoredFiles(paths) {
  for (const p of paths) {
    try { await storageFetch(`/object/${BUCKET}/${encodePath(p)}`, { method: 'DELETE' }); } catch (e) { /* on continue */ }
  }
}

// ---------- Droits d'accès ----------

async function userHasAccess(user, book) {
  if (user.role === 'admin' || book.access_type === 'gratuit') return true;
  const r = await pool.query('SELECT 1 FROM audiobook_access WHERE user_id = $1 AND audiobook_id = $2', [user.id, book.id]);
  return r.rows.length > 0;
}

// Chaque requête attend que les tables soient prêtes (instantané après le premier démarrage)
router.use(async (req, res, next) => { await tablesReady; next(); });

// =====================================================================
//  ADMINISTRATION
// =====================================================================
const admin = express.Router();
admin.use(requireAuth, requireAdmin);

admin.get('/status', async (req, res) => {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  const configured = !!storageConfig();
  const bucket = configured ? await ensureBucket() : false;
  res.json({ storage: configured && bucket, missing, bucketError: configured && !bucket ? bucketError : '', maxFileMb: MAX_FILE / 1024 / 1024 });
});

admin.get('/books', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.title, a.author, a.description, a.access_type, a.price, a.published,
              (a.cover_data IS NOT NULL) AS has_cover,
              count(DISTINCT t.id)::int AS tracks, coalesce(sum(t.size_bytes),0)::bigint AS total_size,
              (SELECT count(*)::int FROM audiobook_access x WHERE x.audiobook_id = a.id) AS buyers
       FROM audiobooks a LEFT JOIN audio_tracks t ON t.audiobook_id = a.id
       GROUP BY a.id ORDER BY a.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

function readBookFields(req) {
  const title = String(req.body.title || '').trim();
  const access_type = req.body.access_type === 'a_vendre' ? 'a_vendre' : 'gratuit';
  const priceNum = parseFloat(req.body.price);
  return {
    title,
    author: String(req.body.author || '').trim() || null,
    description: String(req.body.description || '').trim() || null,
    access_type,
    price: access_type === 'a_vendre' && Number.isFinite(priceNum) ? priceNum : null,
  };
}

admin.post('/books', uploadCover.single('cover'), async (req, res) => {
  const f = readBookFields(req);
  if (!f.title) return res.status(400).json({ message: 'Le titre est requis' });
  if (req.file && !req.file.mimetype.startsWith('image/')) return res.status(400).json({ message: 'La couverture doit être une image' });
  try {
    const result = await pool.query(
      `INSERT INTO audiobooks (title, author, description, access_type, price, cover_data, cover_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, title`,
      [f.title, f.author, f.description, f.access_type, f.price, req.file ? req.file.buffer : null, req.file ? req.file.mimetype : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.put('/books/:id', uploadCover.single('cover'), async (req, res) => {
  const f = readBookFields(req);
  if (!f.title) return res.status(400).json({ message: 'Le titre est requis' });
  if (req.file && !req.file.mimetype.startsWith('image/')) return res.status(400).json({ message: 'La couverture doit être une image' });
  try {
    const result = await pool.query(
      `UPDATE audiobooks SET title=$1, author=$2, description=$3, access_type=$4, price=$5,
         cover_data = COALESCE($6, cover_data), cover_mime = COALESCE($7, cover_mime)
       WHERE id=$8 RETURNING id, title`,
      [f.title, f.author, f.description, f.access_type, f.price, req.file ? req.file.buffer : null, req.file ? req.file.mimetype : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'Livre audio introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.put('/books/:id/publish', async (req, res) => {
  try {
    const result = await pool.query('UPDATE audiobooks SET published = $1 WHERE id = $2 RETURNING id, title, published', [!!req.body.published, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Livre audio introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.delete('/books/:id', async (req, res) => {
  try {
    const paths = (await pool.query('SELECT storage_path FROM audio_tracks WHERE audiobook_id = $1', [req.params.id])).rows.map((r) => r.storage_path);
    await deleteStoredFiles(paths);
    await pool.query('DELETE FROM audiobooks WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.get('/books/:id/tracks', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, track_order, size_bytes, duration_seconds, is_preview FROM audio_tracks WHERE audiobook_id = $1 ORDER BY track_order, id',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Étape 1 de l'envoi d'un fichier : le serveur prépare un lien d'envoi direct
admin.post('/books/:id/tracks/upload-url', async (req, res) => {
  try {
    const filename = String(req.body.filename || '');
    const size = Number(req.body.size || 0);
    const ext = (filename.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
    if (!AUDIO_EXT.includes(ext)) return res.status(400).json({ message: `Format non pris en charge. Utilisez : ${AUDIO_EXT.join(', ')}` });
    if (size > MAX_FILE) return res.status(400).json({ message: `Fichier trop lourd (maximum ${MAX_FILE / 1024 / 1024} Mo). Découpez le livre en chapitres ou compressez-le.` });
    const book = (await pool.query('SELECT id FROM audiobooks WHERE id = $1', [req.params.id])).rows[0];
    if (!book) return res.status(404).json({ message: 'Livre audio introuvable' });
    if (!(await ensureBucket())) throw new Error(bucketError || 'Le stockage audio n\'est pas encore configuré.');
    const storagePath = `${book.id}/${crypto.randomUUID()}${ext}`;
    const uploadUrl = await createSignedUploadUrl(storagePath);
    res.json({ storage_path: storagePath, upload_url: uploadUrl });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Étape 2 : une fois le fichier envoyé, on l'enregistre comme piste du livre
admin.post('/books/:id/tracks', async (req, res) => {
  const { title, storage_path, size_bytes, mime, duration_seconds, is_preview } = req.body;
  const bookId = Number(req.params.id);
  if (!title || !storage_path || !String(storage_path).startsWith(`${bookId}/`)) return res.status(400).json({ message: 'Requête invalide' });
  try {
    const order = (await pool.query('SELECT coalesce(max(track_order),0) + 1 AS n FROM audio_tracks WHERE audiobook_id = $1', [bookId])).rows[0].n;
    const result = await pool.query(
      `INSERT INTO audio_tracks (audiobook_id, title, track_order, storage_path, mime, size_bytes, duration_seconds, is_preview)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, title, track_order`,
      [bookId, String(title).trim(), order, storage_path, mime || null, size_bytes || null,
       Number.isFinite(Number(duration_seconds)) && duration_seconds ? Math.round(Number(duration_seconds)) : null, !!is_preview]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.put('/tracks/:id', async (req, res) => {
  const { title, track_order, is_preview } = req.body;
  try {
    const result = await pool.query(
      `UPDATE audio_tracks SET title = COALESCE($1, title), track_order = COALESCE($2, track_order), is_preview = COALESCE($3, is_preview)
       WHERE id = $4 RETURNING id, title, track_order, is_preview`,
      [title ? String(title).trim() : null, Number.isInteger(track_order) ? track_order : null, typeof is_preview === 'boolean' ? is_preview : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'Piste introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.delete('/tracks/:id', async (req, res) => {
  try {
    const row = (await pool.query('DELETE FROM audio_tracks WHERE id = $1 RETURNING storage_path', [req.params.id])).rows[0];
    if (row) await deleteStoredFiles([row.storage_path]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Accès des acheteurs (le paiement se fait via WhatsApp ; l'administrateur accorde ensuite l'accès)
admin.get('/books/:id/access', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, x.granted_at FROM audiobook_access x JOIN users u ON u.id = x.user_id
       WHERE x.audiobook_id = $1 ORDER BY x.granted_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.post('/books/:id/access', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ message: 'Indiquez l\'e-mail du lecteur' });
  try {
    const user = (await pool.query('SELECT id, email, full_name FROM users WHERE lower(email) = $1', [email])).rows[0];
    if (!user) return res.status(404).json({ message: 'Aucun compte avec cet e-mail : le lecteur doit d\'abord créer son compte.' });
    await pool.query('INSERT INTO audiobook_access (user_id, audiobook_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, req.params.id]);
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.delete('/books/:id/access/:userId', async (req, res) => {
  try {
    await pool.query('DELETE FROM audiobook_access WHERE audiobook_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.use('/admin', admin);

// =====================================================================
//  ÉCOUTE (membres connectés)
// =====================================================================

// Couverture : image publique, comme celle des livres du catalogue
router.get('/books/:id/cover', async (req, res) => {
  try {
    const r = await pool.query('SELECT cover_data, cover_mime FROM audiobooks WHERE id = $1', [req.params.id]);
    const book = r.rows[0];
    if (!book || !book.cover_data) return res.status(404).end();
    res.setHeader('Content-Type', book.cover_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(book.cover_data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/books', requireAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT a.id, a.title, a.author, a.description, a.access_type, a.price,
              (a.cover_data IS NOT NULL) AS has_cover,
              count(t.id)::int AS tracks, coalesce(sum(t.duration_seconds),0)::int AS duration
       FROM audiobooks a JOIN audio_tracks t ON t.audiobook_id = a.id
       WHERE a.published GROUP BY a.id ORDER BY a.created_at DESC`
    )).rows;
    const granted = new Set((await pool.query('SELECT audiobook_id FROM audiobook_access WHERE user_id = $1', [req.user.id])).rows.map((r) => r.audiobook_id));
    res.json(rows.map((b) => ({ ...b, has_access: req.user.role === 'admin' || b.access_type === 'gratuit' || granted.has(b.id) })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/books/:id', requireAuth, async (req, res) => {
  try {
    const book = (await pool.query(
      'SELECT id, title, author, description, access_type, price, published FROM audiobooks WHERE id = $1', [req.params.id]
    )).rows[0];
    if (!book || (!book.published && req.user.role !== 'admin')) return res.status(404).json({ message: 'Livre audio introuvable' });
    const hasAccess = await userHasAccess(req.user, book);
    const tracks = (await pool.query(
      'SELECT id, title, track_order, duration_seconds, is_preview FROM audio_tracks WHERE audiobook_id = $1 ORDER BY track_order, id', [book.id]
    )).rows;
    const progress = new Map();
    if (tracks.length) {
      const rows = (await pool.query(
        'SELECT track_id, position_seconds FROM audio_progress WHERE user_id = $1 AND track_id = ANY($2::int[])',
        [req.user.id, tracks.map((t) => t.id)]
      )).rows;
      rows.forEach((r) => progress.set(r.track_id, r.position_seconds));
    }
    res.json({
      book: { id: book.id, title: book.title, author: book.author, description: book.description, access_type: book.access_type, price: book.price },
      has_access: hasAccess,
      tracks: tracks.map((t) => ({ ...t, playable: hasAccess || t.is_preview, position: progress.get(t.id) || 0 })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Lien d'écoute d'une piste (vérifie les droits)
router.get('/tracks/:id/url', requireAuth, async (req, res) => {
  try {
    const row = (await pool.query(
      `SELECT t.id, t.storage_path, t.is_preview, a.id AS book_id, a.access_type, a.published
       FROM audio_tracks t JOIN audiobooks a ON a.id = t.audiobook_id WHERE t.id = $1`,
      [req.params.id]
    )).rows[0];
    if (!row || (!row.published && req.user.role !== 'admin')) return res.status(404).json({ message: 'Piste introuvable' });
    const allowed = row.is_preview || await userHasAccess(req.user, { id: row.book_id, access_type: row.access_type });
    if (!allowed) return res.status(403).json({ message: 'Ce livre audio est en vente. Contactez-nous pour l\'obtenir.' });
    res.json({ url: await createSignedDownloadUrl(row.storage_path, 6 * 3600) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Reprise de l'écoute
router.put('/tracks/:id/progress', requireAuth, async (req, res) => {
  const position = Math.max(0, Math.round(Number(req.body.position)));
  if (!Number.isFinite(position)) return res.status(400).json({ message: 'Position invalide' });
  try {
    await pool.query(
      `INSERT INTO audio_progress (user_id, track_id, position_seconds, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (user_id, track_id) DO UPDATE SET position_seconds = $3, updated_at = now()`,
      [req.user.id, req.params.id, position]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
