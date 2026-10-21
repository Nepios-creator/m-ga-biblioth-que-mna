'use strict';
// Modification manuelle du texte des livres publiés (phrases, notes) depuis l'administration.
//  - Livres gratuits (Word) : le texte corrigé est gardé en base et remplace celui du fichier Word à l'affichage.
//  - Livres de l'espace d'étude : le texte de chaque partie est corrigé directement.
//  - Bible : versets, intertitres, notes et sous-titre de chapitre.
// Chaque correction est visible tout de suite par les lecteurs et gardée dans un historique (« Restaurer »).
// Monté par reader.js sous /api/reader/admin-edition.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth-middleware');
const { docxToParagraphs } = require('../lib/docx-to-text');

const router = express.Router();
router.use(requireAuth);

// ---------- Base de données (créée automatiquement, une seule fois) ----------
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      ALTER TABLE books ADD COLUMN IF NOT EXISTS reader_paragraphs JSONB;
      ALTER TABLE books ADD COLUMN IF NOT EXISTS reader_paragraphs_src TEXT;
      CREATE TABLE IF NOT EXISTS text_edit_history (
        id SERIAL PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        label TEXT,
        op TEXT NOT NULL,
        idx INTEGER,
        before_data JSONB,
        after_data JSONB,
        user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_text_edit_history_scope ON text_edit_history(scope, id DESC);
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ---------- Droits : administrateur complet, ou administrateur délégué ayant le droit voulu ----------
async function accessOf(req) {
  if (req._access) return req._access;
  const r = await pool.query('SELECT role, admin_permissions FROM users WHERE id = $1', [req.user.id]);
  const u = r.rows[0];
  req._access = u
    ? { full: u.role === 'admin', perms: Array.isArray(u.admin_permissions) ? u.admin_permissions : [] }
    : { full: false, perms: [] };
  return req._access;
}
const allowed = (a, perm) => a.full || a.perms.includes(perm);
const need = (perm) => async (req, res, next) => {
  try {
    if (allowed(await accessOf(req), perm)) return next();
    res.status(403).json({ message: 'Vous n\'avez pas le droit d\'accéder à cette section.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 500).json({ message: e.message }));

// ---------- Historique des corrections ----------
async function logHistory(h) {
  try {
    await ensureSchema();
    await pool.query(
      'INSERT INTO text_edit_history (scope, kind, ref_id, label, op, idx, before_data, after_data, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)',
      [h.scope, h.kind, String(h.ref), h.label || null, h.op, h.idx == null ? null : h.idx, JSON.stringify(h.before || null), JSON.stringify(h.after || null), String(h.user)]
    );
    // On garde les 200 dernières corrections de chaque livre
    await pool.query(
      'DELETE FROM text_edit_history WHERE scope = $1 AND id NOT IN (SELECT id FROM text_edit_history WHERE scope = $1 ORDER BY id DESC LIMIT 200)',
      [h.scope]
    );
  } catch (err) {
    console.error('Historique des corrections :', err.message);
  }
}

// ---------- Documents : un livre gratuit (liste de paragraphes) ou une partie de l'espace d'étude ----------
const splitParas = (content) => String(content || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
const oneLine = (s) => String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ').trim();
const prefixOf = (s) => (String(s).match(/^#{1,3} /) || [''])[0]; // « # », « ## », « ### » = titres du livre
const shortLabel = (s) => String(s).replace(/^#{1,3} /, '').slice(0, 70);

async function loadDoc(kind, id) {
  await ensureSchema();
  if (kind === 'livre') {
    const r = (await pool.query(
      `SELECT id, title, is_study_book, docx_data, reader_paragraphs,
              COALESCE(reader_paragraphs IS NOT NULL AND reader_paragraphs_src = md5(docx_data), false) AS edits_valid
         FROM books WHERE id = $1`, [id]
    )).rows[0];
    if (!r) throw fail(404, 'Livre introuvable');
    if (r.is_study_book) throw fail(400, 'Ce livre fait partie de l\'espace d\'étude : modifiez-le partie par partie.');
    if (!r.docx_data) throw fail(409, 'Ce livre n\'a pas de fichier Word : son texte ne peut pas être modifié ici.');
    const paras = r.edits_valid && Array.isArray(r.reader_paragraphs) ? r.reader_paragraphs : await docxToParagraphs(r.docx_data);
    if (!paras) throw fail(409, 'Le texte de ce livre est illisible.');
    return {
      title: r.title, scope: 'livre:' + r.id, ref: r.id, edited: r.edits_valid, paragraphs: paras.slice(),
      save: (arr) => pool.query(
        'UPDATE books SET reader_paragraphs = $1::jsonb, reader_paragraphs_src = md5(docx_data) WHERE id = $2',
        [JSON.stringify(arr), r.id]
      ),
    };
  }
  if (kind === 'partie') {
    const r = (await pool.query(
      `SELECT bp.id, bp.title, bp.content, bp.content_filled, b.title AS book_title
         FROM book_parts bp JOIN books b ON b.id = bp.book_id WHERE bp.id = $1`, [id]
    )).rows[0];
    if (!r) throw fail(404, 'Partie introuvable');
    if (r.content_filled === false) throw fail(409, 'Le texte de cette partie est en cours de préparation (quelques minutes après le téléversement du Word). Réessayez plus tard.');
    return {
      title: r.title, book_title: r.book_title, scope: 'partie:' + r.id, ref: r.id, edited: false, paragraphs: splitParas(r.content),
      save: (arr) => pool.query('UPDATE book_parts SET content = $1 WHERE id = $2', [arr.join('\n\n'), r.id]),
    };
  }
  throw fail(400, 'Type de document inconnu');
}

// ---------- Livres : liste ----------
router.get('/list', need('livres'), wrap(async (req, res) => {
  await ensureSchema();
  const rows = (await pool.query(
    `SELECT b.id, b.title, b.is_study_book, b.access_type, (b.docx_data IS NOT NULL) AS has_docx,
            COALESCE(b.reader_paragraphs IS NOT NULL AND b.reader_paragraphs_src = md5(b.docx_data), false) AS edited,
            (SELECT COUNT(*) FROM book_parts bp WHERE bp.book_id = b.id) AS parts
       FROM books b ORDER BY b.is_study_book DESC, b.order_index ASC NULLS LAST, b.created_at DESC`
  )).rows;
  res.json(rows.map((r) => ({ ...r, parts: Number(r.parts) })));
}));

router.get('/books/:id/parts', need('livres'), wrap(async (req, res) => {
  const rows = (await pool.query(
    'SELECT id, part_index, title, content_filled FROM book_parts WHERE book_id = $1 ORDER BY part_index', [req.params.id]
  )).rows;
  res.json(rows);
}));

// ---------- Texte d'un livre ou d'une partie ----------
router.get('/doc/:kind/:id', need('livres'), wrap(async (req, res) => {
  const d = await loadDoc(req.params.kind, req.params.id);
  res.json({ title: d.title, book_title: d.book_title || null, paragraphs: d.paragraphs, edited: !!d.edited });
}));

// Corrige UN paragraphe. « old_text » sert de garde-fou : si le texte a changé entre-temps, rien n'est écrasé.
router.post('/doc/:kind/:id/edit', need('livres'), wrap(async (req, res) => {
  const doc = await loadDoc(req.params.kind, req.params.id);
  const arr = doc.paragraphs;
  const i = Number(req.body.index);
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) throw fail(400, 'Paragraphe introuvable.');
  if (arr[i] !== req.body.old_text) throw fail(409, 'Ce passage vient d\'être modifié (sur un autre appareil ou par un autre administrateur). Rouvrez le livre pour voir la version actuelle.');
  const next = oneLine(req.body.text);
  if (prefixOf(next) !== prefixOf(arr[i])) throw fail(400, 'Un paragraphe ne peut pas commencer par « # » : cela changerait son rôle dans le livre.');
  if (!next.replace(/^#{1,3} /, '').trim()) throw fail(400, 'Le texte ne peut pas être vide.');
  if (next === arr[i]) return res.json({ ok: true, unchanged: true });
  const before = arr[i];
  arr[i] = next;
  await doc.save(arr);
  await logHistory({ scope: doc.scope, kind: req.params.kind, ref: req.params.id, label: shortLabel(before), op: 'edit', idx: i, before: { text: before }, after: { text: next }, user: req.user.id });
  res.json({ ok: true });
}));

// Revient au texte d'origine du fichier Word (efface toutes les corrections manuelles de ce livre)
router.post('/doc/livre/:id/reset', need('livres'), wrap(async (req, res) => {
  await ensureSchema();
  const r = await pool.query('UPDATE books SET reader_paragraphs = NULL, reader_paragraphs_src = NULL WHERE id = $1 RETURNING id', [req.params.id]);
  if (!r.rows.length) throw fail(404, 'Livre introuvable');
  await pool.query('DELETE FROM text_edit_history WHERE scope = $1', ['livre:' + req.params.id]);
  res.json({ ok: true });
}));

// Recherche d'un mot ou d'une phrase dans un livre (gratuit ou de l'espace d'étude)
router.get('/search/:bookId', need('livres'), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  const needle = q.toLowerCase();
  const snip = (t) => {
    const k = t.toLowerCase().indexOf(needle);
    const s = Math.max(0, k - 50);
    return (s ? '…' : '') + t.slice(s, s + 170) + (t.length > s + 170 ? '…' : '');
  };
  const book = (await pool.query('SELECT id, is_study_book FROM books WHERE id = $1', [req.params.bookId])).rows[0];
  if (!book) throw fail(404, 'Livre introuvable');
  const out = [];
  if (book.is_study_book) {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const parts = (await pool.query('SELECT id, title, content FROM book_parts WHERE book_id = $1 AND content ILIKE $2 ORDER BY part_index', [book.id, like])).rows;
    for (const p of parts) {
      splitParas(p.content).forEach((t, i) => {
        if (out.length < 40 && t.toLowerCase().includes(needle)) out.push({ kind: 'partie', id: p.id, part_title: p.title, index: i, text: snip(t.replace(/^#{1,3} /, '')) });
      });
    }
  } else {
    const doc = await loadDoc('livre', book.id);
    doc.paragraphs.forEach((t, i) => {
      if (out.length < 40 && t.toLowerCase().includes(needle)) out.push({ kind: 'livre', id: book.id, index: i, text: snip(t.replace(/^#{1,3} /, '')) });
    });
  }
  res.json(out);
}));

// ---------- Bible ----------
// Dans la Bible, les lettres de renvoi (a, b, c…) ne sont pas dans le texte : elles sont rangées à part, avec leur
// position. Pour les modifier sans risque, on les montre dans le texte entre ⟦ ⟧ (ex. « Au commencement⟦a⟧ était… »).
function tokenize(text, notes) {
  const t = String(text || '');
  const ns = (Array.isArray(notes) ? notes : [])
    .map((n, k) => ({ letter: n.letter, offset: n.offset == null ? t.length : Math.max(0, Math.min(Number(n.offset) || 0, t.length)), k }))
    .sort((a, b) => (a.offset - b.offset) || (a.k - b.k));
  let out = '', pos = 0;
  for (const n of ns) { out += t.slice(pos, n.offset) + '⟦' + n.letter + '⟧'; pos = n.offset; }
  return out + t.slice(pos);
}
function detokenize(str, origNotes) {
  const pool_ = (Array.isArray(origNotes) ? origNotes : []).map((n) => ({ ...n }));
  const re = /⟦([a-z]{1,4})⟧/gi;
  let text = '', last = 0, m;
  const notes = [];
  while ((m = re.exec(str))) {
    text += str.slice(last, m.index);
    last = m.index + m[0].length;
    const letter = m[1].toLowerCase();
    const k = pool_.findIndex((n) => n.letter === letter);
    const base = k >= 0 ? pool_.splice(k, 1)[0] : {};
    notes.push({ ...base, letter, offset: text.length });
  }
  text += str.slice(last);
  text = text.replace(/\s+$/, '');
  notes.forEach((n) => { n.offset = Math.min(n.offset, text.length); });
  return { text, notes };
}
const cleanBody = (b) => String(b || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n\n');

router.get('/bible/books', need('bible'), wrap(async (req, res) => {
  const rows = (await pool.query(
    `SELECT b.id, b.name, b.published,
            COALESCE(array_agg(DISTINCT v.chapter ORDER BY v.chapter) FILTER (WHERE v.id IS NOT NULL), '{}') AS chapters
       FROM bible_books b LEFT JOIN bible_verses v ON v.book_id = b.id
      GROUP BY b.id ORDER BY b.book_order, b.id`
  )).rows;
  res.json(rows);
}));

router.get('/bible/:bookId/:chapter', need('bible'), wrap(async (req, res) => {
  const n = parseInt(req.params.chapter, 10);
  const book = (await pool.query('SELECT id, name FROM bible_books WHERE id = $1', [req.params.bookId])).rows[0];
  if (!book || !Number.isInteger(n)) throw fail(404, 'Chapitre introuvable');
  const verses = (await pool.query('SELECT id, verse, text, heading, notes FROM bible_verses WHERE book_id = $1 AND chapter = $2 ORDER BY verse', [book.id, n])).rows;
  if (!verses.length) throw fail(404, 'Chapitre introuvable');
  const comments = (await pool.query('SELECT id, verse_start, verse_end, title, body, letter FROM bible_comments WHERE book_id = $1 AND chapter = $2 ORDER BY verse_end, position', [book.id, n]).catch(() => ({ rows: [] }))).rows;
  const sub = (await pool.query('SELECT subtitle FROM bible_chapters WHERE book_id = $1 AND chapter = $2', [book.id, n]).catch(() => ({ rows: [] }))).rows[0];
  res.json({
    book, chapter: n, subtitle: sub ? sub.subtitle : '',
    verses: verses.map((v) => ({ id: v.id, verse: v.verse, heading: v.heading || '', edit_text: tokenize(v.text, v.notes) })),
    comments,
  });
}));

router.put('/bible/verses/:id', need('bible'), wrap(async (req, res) => {
  const row = (await pool.query(
    `SELECT v.id, v.book_id, v.chapter, v.verse, v.text, v.heading, v.notes, b.name
       FROM bible_verses v JOIN bible_books b ON b.id = v.book_id WHERE v.id = $1`, [req.params.id]
  )).rows[0];
  if (!row) throw fail(404, 'Verset introuvable');
  const { text, notes } = detokenize(oneLine(req.body.text), row.notes);
  if (!text.trim()) throw fail(400, 'Le verset ne peut pas être vide.');
  const heading = oneLine(req.body.heading) || null;
  await pool.query('UPDATE bible_verses SET text = $1, heading = $2, notes = $3::jsonb WHERE id = $4', [text, heading, JSON.stringify(notes), row.id]);
  await logHistory({
    scope: `bible:${row.book_id}:${row.chapter}`, kind: 'verset', ref: row.id, label: `${row.name} ${row.chapter}:${row.verse}`, op: 'edit',
    before: { text: row.text, heading: row.heading, notes: row.notes }, after: { text, heading, notes }, user: req.user.id,
  });
  res.json({ ok: true, edit_text: tokenize(text, notes), heading: heading || '' });
}));

router.put('/bible/comments/:id', need('bible'), wrap(async (req, res) => {
  const row = (await pool.query(
    `SELECT c.id, c.book_id, c.chapter, c.letter, c.title, c.body, b.name
       FROM bible_comments c JOIN bible_books b ON b.id = c.book_id WHERE c.id = $1`, [req.params.id]
  )).rows[0];
  if (!row) throw fail(404, 'Note introuvable');
  const body = cleanBody(req.body.body);
  if (!body) throw fail(400, 'La note ne peut pas être vide.');
  const title = oneLine(req.body.title) || null;
  await pool.query('UPDATE bible_comments SET title = $1, body = $2 WHERE id = $3', [title, body, row.id]);
  await logHistory({
    scope: `bible:${row.book_id}:${row.chapter}`, kind: 'note', ref: row.id, label: `${row.name} ${row.chapter} — note ${row.letter || ''}`.trim(), op: 'edit',
    before: { title: row.title, body: row.body }, after: { title, body }, user: req.user.id,
  });
  res.json({ ok: true, title: title || '', body });
}));

router.put('/bible/chapter', need('bible'), wrap(async (req, res) => {
  const bookId = parseInt(req.body.book_id, 10), chapter = parseInt(req.body.chapter, 10);
  if (!Number.isInteger(bookId) || !Number.isInteger(chapter)) throw fail(400, 'Chapitre invalide');
  const subtitle = oneLine(req.body.subtitle);
  if (subtitle) {
    await pool.query(
      'INSERT INTO bible_chapters (book_id, chapter, subtitle) VALUES ($1,$2,$3) ON CONFLICT (book_id, chapter) DO UPDATE SET subtitle = EXCLUDED.subtitle',
      [bookId, chapter, subtitle]
    );
  } else {
    await pool.query('DELETE FROM bible_chapters WHERE book_id = $1 AND chapter = $2', [bookId, chapter]);
  }
  res.json({ ok: true });
}));

// ---------- Historique et restauration ----------
router.get('/history', wrap(async (req, res) => {
  const scope = String(req.query.scope || '');
  if (!allowed(await accessOf(req), scope.startsWith('bible:') ? 'bible' : 'livres')) throw fail(403, 'Accès refusé');
  await ensureSchema();
  const rows = (await pool.query(
    'SELECT id, kind, label, op, before_data, after_data, created_at FROM text_edit_history WHERE scope = $1 ORDER BY id DESC LIMIT 20', [scope]
  )).rows;
  res.json(rows);
}));

router.post('/history/:id/restore', wrap(async (req, res) => {
  await ensureSchema();
  const h = (await pool.query('SELECT * FROM text_edit_history WHERE id = $1', [req.params.id])).rows[0];
  if (!h || h.op !== 'edit') throw fail(404, 'Correction introuvable');
  const bible = h.kind === 'verset' || h.kind === 'note';
  if (!allowed(await accessOf(req), bible ? 'bible' : 'livres')) throw fail(403, 'Accès refusé');

  if (h.kind === 'livre' || h.kind === 'partie') {
    const doc = await loadDoc(h.kind, h.ref_id);
    const arr = doc.paragraphs;
    const j = arr[h.idx] === h.after_data.text ? h.idx : arr.indexOf(h.after_data.text);
    if (j < 0) throw fail(409, 'Ce passage a été modifié depuis : impossible de le restaurer automatiquement.');
    arr[j] = h.before_data.text;
    await doc.save(arr);
    await logHistory({ scope: doc.scope, kind: h.kind, ref: h.ref_id, label: h.label, op: 'restore', idx: j, before: h.after_data, after: h.before_data, user: req.user.id });
  } else if (h.kind === 'verset') {
    const b = h.before_data;
    await pool.query('UPDATE bible_verses SET text = $1, heading = $2, notes = $3::jsonb WHERE id = $4', [b.text, b.heading || null, JSON.stringify(b.notes || []), h.ref_id]);
    await logHistory({ scope: h.scope, kind: h.kind, ref: h.ref_id, label: h.label, op: 'restore', before: h.after_data, after: b, user: req.user.id });
  } else if (h.kind === 'note') {
    const b = h.before_data;
    await pool.query('UPDATE bible_comments SET title = $1, body = $2 WHERE id = $3', [b.title || null, b.body, h.ref_id]);
    await logHistory({ scope: h.scope, kind: h.kind, ref: h.ref_id, label: h.label, op: 'restore', before: h.after_data, after: b, user: req.user.id });
  } else {
    throw fail(400, 'Type de correction inconnu');
  }
  res.json({ ok: true });
}));

module.exports = router;
module.exports.ensureSchema = ensureSchema;
