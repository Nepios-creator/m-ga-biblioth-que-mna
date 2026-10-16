const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../lib/auth-middleware');
const { docxToBlocks, parseBibleDocument, parseBibleText, sniffFormat } = require('../lib/bible-parse');

const router = express.Router();

// Commentaires des chapitres (créés automatiquement à la première utilisation)
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS bible_comments (
        id SERIAL PRIMARY KEY,
        book_id INTEGER NOT NULL,
        chapter INTEGER NOT NULL,
        verse_start INTEGER NOT NULL DEFAULT 0,
        verse_end INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        body TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_bible_comments_chapter ON bible_comments(book_id, chapter);
      ALTER TABLE bible_comments ADD COLUMN IF NOT EXISTS letter TEXT;
      ALTER TABLE bible_verses ADD COLUMN IF NOT EXISTS notes JSONB;
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
ensureSchema().catch((err) => console.error('Table des commentaires de la Bible :', err.message));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 Mo max

// Téléversement avec un vrai message d'erreur lisible (au lieu d'une page d'erreur illisible)
function uploadOne(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(400).json({ message: tooBig ? 'Fichier trop volumineux (25 Mo maximum). Publiez la Bible livre par livre.' : 'Téléversement impossible : ' + err.message });
  });
}

// =====================================================================
//  ADMINISTRATION (réservée aux administrateurs)
// =====================================================================
const admin = express.Router();
admin.use(requireAuth, requireAdmin);

// Lit le texte reçu (fichier ou texte collé) et le découpe en versets et commentaires. Le type du fichier est
// reconnu d'après son contenu, pas d'après son nom : sur téléphone, le nom reçu n'a parfois pas d'extension.
async function analyseRequest(req) {
  let parsed, lines;
  if (req.file) {
    const kind = sniffFormat(req.file.buffer);
    if (kind === 'empty') throw new Error('Le fichier reçu est vide. Choisissez-le de nouveau.');
    if (kind === 'text') {
      let text = req.file.buffer.toString('utf8');
      if (text.includes('\ufffd')) text = req.file.buffer.toString('latin1'); // fichier .txt ancien (Windows-1252)
      lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
      parsed = parseBibleText(lines);
    } else {
      const { blocks, natives, noteDefs } = await docxToBlocks(req.file.buffer); // .docx, ou message clair pour .doc / PDF / autre
      lines = [];
      blocks.forEach((b) => b.text.split('\n').forEach((l) => lines.push(l)));
      parsed = parseBibleDocument(blocks, natives, noteDefs);
    }
  } else {
    const text = String((req.body && req.body.text) || '');
    if (!text.trim()) throw new Error('Aucun texte reçu : choisissez un fichier ou collez le texte.');
    lines = text.split(/\r?\n/);
    parsed = parseBibleText(lines);
  }
  // Un fichier = un chapitre : le numéro indiqué dans le formulaire remplace celui du fichier
  const wanted = parseInt(req.body && req.body.chapter, 10);
  if (wanted > 0 && parsed.chapters.length === 1) {
    const from = parsed.chapters[0].chapter;
    parsed.chapters[0].chapter = wanted;
    parsed.comments.forEach((c) => { if (c.chapter === from) c.chapter = wanted; });
    parsed.chapterAssumed = false;
    parsed.warnings = parsed.warnings.filter((w) => !/chapitre 1 supposé/.test(w));
  }
  const nonEmpty = lines.map((l) => String(l).replace(/⟦#([^⟧]+)⟧/g, '[$1]').replace(/⟦(\d+)⟧/g, '$1 ').trim()).filter(Boolean);
  return { parsed, linesRead: nonEmpty.length, firstLines: nonEmpty.slice(0, 8).map((l) => l.slice(0, 140)) };
}

// Aperçu : analyse le texte sans rien enregistrer
admin.post('/preview', uploadOne, async (req, res) => {
  try {
    const { parsed, linesRead, firstLines } = await analyseRequest(req);
    const chapters = parsed.chapters.map((c) => ({ chapter: c.chapter, count: c.verses.length }));
    const first = parsed.chapters[0];
    const lastCh = parsed.chapters[parsed.chapters.length - 1];
    res.json({
      totalVerses: parsed.totalVerses,
      duplicates: parsed.duplicates,
      warnings: parsed.warnings,
      chapters,
      chapterAssumed: !!parsed.chapterAssumed,
      sampleStart: first ? { chapter: first.chapter, verses: first.verses.slice(0, 3) } : null,
      sampleEnd: lastCh ? { chapter: lastCh.chapter, verses: lastCh.verses.slice(-2) } : null,
      notes: parsed.notes || [],
      comments: parsed.comments.map((c) => ({
        chapter: c.chapter, verse_start: c.verse_start, verse_end: c.verse_end, title: c.title || null, letter: c.letter || null, how: c.how,
        paragraphs: c.paragraphs.length, text: c.paragraphs.join(' ').slice(0, 220),
      })),
      // Début du fichier tel que le site le lit : sert à reconnaître le livre et à comprendre un refus
      linesRead,
      firstLines,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Publier (ou mettre à jour) un livre de la Bible. Les versets existants sont mis à jour sur place,
// pour ne pas perdre les surlignages et favoris des lecteurs.
admin.post('/books', uploadOne, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'Le nom du livre est requis' });
  const testament = req.body.testament === 'nouveau' ? 'nouveau' : 'ancien';
  const abbreviation = String(req.body.abbreviation || '').trim() || null;
  const bookOrder = Number.isFinite(Number(req.body.book_order)) && req.body.book_order !== '' ? Number(req.body.book_order) : 1000;

  let parsed;
  try {
    await ensureSchema();
    parsed = (await analyseRequest(req)).parsed;
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
  if (!parsed.totalVerses) return res.status(400).json({ message: 'Aucun verset détecté : vérifiez le format du texte.' });
  if (parsed.chapterAssumed) return res.status(400).json({ message: 'Le numéro du chapitre n\'a pas été trouvé dans le fichier : indiquez-le dans la case « Numéro du chapitre » avant de publier (sinon le chapitre 1 serait remplacé).' });
  if (parsed.duplicates > 0) return res.status(400).json({ message: 'Des numéros de versets apparaissent en double : corrigez le texte avant de publier.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = (await client.query('SELECT id FROM bible_books WHERE lower(name) = lower($1)', [name])).rows[0];
    let bookId;
    if (existing) {
      bookId = existing.id;
      await client.query(
        'UPDATE bible_books SET name=$1, abbreviation=$2, testament=$3, book_order=$4 WHERE id=$5',
        [name, abbreviation, testament, bookOrder, bookId]
      );
    } else {
      const ins = await client.query(
        'INSERT INTO bible_books (name, abbreviation, testament, book_order, published) VALUES ($1,$2,$3,$4,true) RETURNING id',
        [name, abbreviation, testament, bookOrder]
      );
      bookId = ins.rows[0].id;
    }

    const flat = [];
    for (const c of parsed.chapters) {
      for (const v of c.verses) flat.push({ chapter: c.chapter, verse: v.verse, text: v.text, heading: v.heading || null, notes: JSON.stringify(v.notes || []) });
    }

    // Mise à jour / ajout par lots
    const BATCH = 300;
    for (let i = 0; i < flat.length; i += BATCH) {
      const slice = flat.slice(i, i + BATCH);
      const params = [];
      const values = slice.map((v, k) => {
        params.push(bookId, v.chapter, v.verse, v.text, v.heading, v.notes);
        const b = k * 6;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb)`;
      });
      await client.query(
        `INSERT INTO bible_verses (book_id, chapter, verse, text, heading, notes) VALUES ${values.join(',')}
         ON CONFLICT (book_id, chapter, verse) DO UPDATE SET text = EXCLUDED.text, heading = EXCLUDED.heading, notes = EXCLUDED.notes`,
        params
      );
    }

    // Retire les versets qui ne figurent plus dans le nouveau texte — uniquement dans les chapitres envoyés
    // (les autres chapitres du livre ne sont jamais touchés)
    const chapterNumbers = parsed.chapters.map((c) => c.chapter);
    const keep = new Set(flat.map((v) => `${v.chapter}:${v.verse}`));
    const old = (await client.query('SELECT id, chapter, verse FROM bible_verses WHERE book_id = $1 AND chapter = ANY($2::int[])', [bookId, chapterNumbers])).rows;
    const staleIds = old.filter((r) => !keep.has(`${r.chapter}:${r.verse}`)).map((r) => r.id);
    if (staleIds.length) await client.query('DELETE FROM bible_verses WHERE id = ANY($1::int[])', [staleIds]);

    // Commentaires de ces chapitres : remplacés par ceux du nouveau fichier
    await client.query('DELETE FROM bible_comments WHERE book_id = $1 AND chapter = ANY($2::int[])', [bookId, chapterNumbers]);
    let position = 0;
    for (const c of parsed.comments) {
      await client.query(
        'INSERT INTO bible_comments (book_id, chapter, verse_start, verse_end, title, body, position, letter) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [bookId, c.chapter, c.verse_start, c.verse_end, c.title || null, c.paragraphs.join('\n\n'), position++, c.letter || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: `« ${name} » chapitre ${chapterNumbers.join(', ')} publié : ${parsed.totalVerses} verset(s)` + (parsed.comments.length ? ` et ${parsed.comments.length} commentaire(s).` : '.'),
      id: bookId, chapters: parsed.chapters.length, verses: parsed.totalVerses, comments: parsed.comments.length, removed: staleIds.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

admin.get('/books', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.name, b.abbreviation, b.testament, b.book_order, b.published,
              count(v.id)::int AS verses, count(DISTINCT v.chapter)::int AS chapters
       FROM bible_books b LEFT JOIN bible_verses v ON v.book_id = b.id
       GROUP BY b.id ORDER BY b.book_order, b.id`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.put('/books/:id', async (req, res) => {
  const { published } = req.body;
  try {
    const result = await pool.query(
      'UPDATE bible_books SET published = $1 WHERE id = $2 RETURNING id, name, published',
      [!!published, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'Livre introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

admin.delete('/books/:id', async (req, res) => {
  try {
    await ensureSchema();
    await pool.query('DELETE FROM bible_comments WHERE book_id = $1', [req.params.id]);
    await pool.query('DELETE FROM bible_books WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.use('/admin', admin);

// =====================================================================
//  LECTURE (membres connectés)
// =====================================================================
router.use(requireAuth);

// Livres publiés, avec la liste de leurs chapitres
router.get('/books', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.name, b.abbreviation, b.testament, b.book_order,
              array_agg(DISTINCT v.chapter ORDER BY v.chapter) AS chapters
       FROM bible_books b JOIN bible_verses v ON v.book_id = b.id
       WHERE b.published
       GROUP BY b.id ORDER BY b.book_order, b.id`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

async function neighbours(book, chapter) {
  const chapters = (await pool.query(
    'SELECT DISTINCT chapter FROM bible_verses WHERE book_id = $1 ORDER BY chapter', [book.id]
  )).rows.map((r) => r.chapter);
  const idx = chapters.indexOf(chapter);
  let prev = null, next = null;

  if (idx > 0) prev = { book_id: book.id, chapter: chapters[idx - 1], label: `${book.name} ${chapters[idx - 1]}` };
  else {
    const pb = (await pool.query(
      `SELECT b.id, b.name, max(v.chapter)::int AS ch FROM bible_books b JOIN bible_verses v ON v.book_id = b.id
       WHERE b.published AND (b.book_order, b.id) < ($1, $2)
       GROUP BY b.id ORDER BY b.book_order DESC, b.id DESC LIMIT 1`,
      [book.book_order, book.id]
    )).rows[0];
    if (pb) prev = { book_id: pb.id, chapter: pb.ch, label: `${pb.name} ${pb.ch}` };
  }

  if (idx !== -1 && idx < chapters.length - 1) next = { book_id: book.id, chapter: chapters[idx + 1], label: `${book.name} ${chapters[idx + 1]}` };
  else {
    const nb = (await pool.query(
      `SELECT b.id, b.name, min(v.chapter)::int AS ch FROM bible_books b JOIN bible_verses v ON v.book_id = b.id
       WHERE b.published AND (b.book_order, b.id) > ($1, $2)
       GROUP BY b.id ORDER BY b.book_order, b.id LIMIT 1`,
      [book.book_order, book.id]
    )).rows[0];
    if (nb) next = { book_id: nb.id, chapter: nb.ch, label: `${nb.name} ${nb.ch}` };
  }
  return { prev, next };
}

// Un chapitre : versets + chapitres voisins
router.get('/books/:id/chapters/:n', async (req, res) => {
  try {
    const chapter = parseInt(req.params.n, 10);
    const book = (await pool.query(
      'SELECT id, name, abbreviation, testament, book_order FROM bible_books WHERE id = $1 AND published', [req.params.id]
    )).rows[0];
    if (!book || !Number.isInteger(chapter)) return res.status(404).json({ message: 'Chapitre introuvable' });
    let verses;
    try {
      await ensureSchema();
      verses = (await pool.query(
        'SELECT id, verse, text, heading, notes FROM bible_verses WHERE book_id = $1 AND chapter = $2 ORDER BY verse', [book.id, chapter]
      )).rows;
    } catch (e) {
      verses = (await pool.query(
        'SELECT id, verse, text, heading FROM bible_verses WHERE book_id = $1 AND chapter = $2 ORDER BY verse', [book.id, chapter]
      )).rows;
    }
    if (!verses.length) return res.status(404).json({ message: 'Chapitre introuvable' });
    const { prev, next } = await neighbours(book, chapter);
    let comments = [];
    try {
      await ensureSchema();
      comments = (await pool.query(
        'SELECT id, verse_start, verse_end, title, body, letter FROM bible_comments WHERE book_id = $1 AND chapter = $2 ORDER BY verse_end, position', [book.id, chapter]
      )).rows;
    } catch (e) { comments = []; }
    res.json({ book: { id: book.id, name: book.name, abbreviation: book.abbreviation }, chapter, verses, comments, prev, next });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Recherche dans le texte
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  try {
    const pattern = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const result = await pool.query(
      `SELECT v.id, v.chapter, v.verse, v.text, b.id AS book_id, b.name AS book_name
       FROM bible_verses v JOIN bible_books b ON b.id = v.book_id
       WHERE b.published AND v.text ILIKE $1
       ORDER BY b.book_order, b.id, v.chapter, v.verse LIMIT 60`,
      [pattern]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Marques des lecteurs : surlignages, favoris, notes ----------

router.get('/marks', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.verse_id, m.type, m.color, m.note
       FROM bible_marks m JOIN bible_verses v ON v.id = m.verse_id
       WHERE m.user_id = $1 AND v.book_id = $2 AND v.chapter = $3`,
      [req.user.id, req.query.book_id, req.query.chapter]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/marks/list', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.type, m.color, m.note, m.created_at, v.id AS verse_id, v.chapter, v.verse, v.text,
              b.id AS book_id, b.name AS book_name
       FROM bible_marks m JOIN bible_verses v ON v.id = m.verse_id JOIN bible_books b ON b.id = v.book_id
       WHERE m.user_id = $1 AND b.published
       ORDER BY m.created_at DESC LIMIT 300`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const COLORS = ['yellow', 'green', 'blue', 'pink'];

router.post('/marks', async (req, res) => {
  const { verse_id, type, color, note } = req.body;
  if (!verse_id || !['highlight', 'favorite', 'note'].includes(type)) return res.status(400).json({ message: 'Requête invalide' });
  try {
    const verse = (await pool.query('SELECT id FROM bible_verses WHERE id = $1', [verse_id])).rows[0];
    if (!verse) return res.status(404).json({ message: 'Verset introuvable' });

    if (type === 'favorite') {
      // Un second appui retire le favori
      const del = await pool.query(
        "DELETE FROM bible_marks WHERE user_id=$1 AND verse_id=$2 AND type='favorite' RETURNING id", [req.user.id, verse_id]
      );
      if (del.rows.length) return res.json({ removed: true });
    }
    if (type === 'highlight' && !COLORS.includes(color)) return res.status(400).json({ message: 'Couleur invalide' });
    if (type === 'note') {
      const text = String(note || '').trim();
      if (!text) {
        await pool.query("DELETE FROM bible_marks WHERE user_id=$1 AND verse_id=$2 AND type='note'", [req.user.id, verse_id]);
        return res.json({ removed: true });
      }
    }

    const result = await pool.query(
      `INSERT INTO bible_marks (user_id, verse_id, type, color, note) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, verse_id, type) DO UPDATE SET color = EXCLUDED.color, note = EXCLUDED.note
       RETURNING id, verse_id, type, color, note`,
      [req.user.id, verse_id, type, type === 'highlight' ? color : null, type === 'note' ? String(note).trim() : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/marks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bible_marks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
