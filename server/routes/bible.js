const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../lib/auth-middleware');
const { docxToRawLines, parseBible } = require('../lib/bible-parse');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10 Mo max

// =====================================================================
//  ADMINISTRATION (réservée aux administrateurs)
// =====================================================================
const admin = express.Router();
admin.use(requireAuth, requireAdmin);

async function linesFromRequest(req) {
  if (req.file) {
    const name = (req.file.originalname || '').toLowerCase();
    if (name.endsWith('.docx')) return docxToRawLines(req.file.buffer);
    if (name.endsWith('.txt')) return req.file.buffer.toString('utf8').split(/\r?\n/);
    throw new Error('Format non supporté : utilisez un fichier Word (.docx) ou texte (.txt), ou collez le texte.');
  }
  const text = String((req.body && req.body.text) || '');
  if (!text.trim()) throw new Error('Aucun texte reçu : choisissez un fichier ou collez le texte.');
  return text.split(/\r?\n/);
}

// Aperçu : analyse le texte sans rien enregistrer
admin.post('/preview', upload.single('file'), async (req, res) => {
  try {
    const parsed = parseBible(await linesFromRequest(req));
    const chapters = parsed.chapters.map((c) => ({ chapter: c.chapter, count: c.verses.length }));
    const first = parsed.chapters[0];
    const lastCh = parsed.chapters[parsed.chapters.length - 1];
    res.json({
      totalVerses: parsed.totalVerses,
      duplicates: parsed.duplicates,
      warnings: parsed.warnings,
      chapters,
      sampleStart: first ? { chapter: first.chapter, verses: first.verses.slice(0, 3) } : null,
      sampleEnd: lastCh ? { chapter: lastCh.chapter, verses: lastCh.verses.slice(-2) } : null,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Publier (ou mettre à jour) un livre de la Bible. Les versets existants sont mis à jour sur place,
// pour ne pas perdre les surlignages et favoris des lecteurs.
admin.post('/books', upload.single('file'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'Le nom du livre est requis' });
  const testament = req.body.testament === 'nouveau' ? 'nouveau' : 'ancien';
  const abbreviation = String(req.body.abbreviation || '').trim() || null;
  const bookOrder = Number.isFinite(Number(req.body.book_order)) && req.body.book_order !== '' ? Number(req.body.book_order) : 1000;

  let parsed;
  try {
    parsed = parseBible(await linesFromRequest(req));
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
  if (!parsed.totalVerses) return res.status(400).json({ message: 'Aucun verset détecté : vérifiez le format du texte.' });
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
        'INSERT INTO bible_books (name, abbreviation, testament, book_order) VALUES ($1,$2,$3,$4) RETURNING id',
        [name, abbreviation, testament, bookOrder]
      );
      bookId = ins.rows[0].id;
    }

    const flat = [];
    for (const c of parsed.chapters) {
      for (const v of c.verses) flat.push({ chapter: c.chapter, verse: v.verse, text: v.text, heading: v.heading || null });
    }

    // Mise à jour / ajout par lots
    const BATCH = 300;
    for (let i = 0; i < flat.length; i += BATCH) {
      const slice = flat.slice(i, i + BATCH);
      const params = [];
      const values = slice.map((v, k) => {
        params.push(bookId, v.chapter, v.verse, v.text, v.heading);
        const b = k * 5;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      await client.query(
        `INSERT INTO bible_verses (book_id, chapter, verse, text, heading) VALUES ${values.join(',')}
         ON CONFLICT (book_id, chapter, verse) DO UPDATE SET text = EXCLUDED.text, heading = EXCLUDED.heading`,
        params
      );
    }

    // Retire les versets qui ne figurent plus dans le nouveau texte
    const keep = new Set(flat.map((v) => `${v.chapter}:${v.verse}`));
    const old = (await client.query('SELECT id, chapter, verse FROM bible_verses WHERE book_id = $1', [bookId])).rows;
    const staleIds = old.filter((r) => !keep.has(`${r.chapter}:${r.verse}`)).map((r) => r.id);
    if (staleIds.length) await client.query('DELETE FROM bible_verses WHERE id = ANY($1::int[])', [staleIds]);

    await client.query('COMMIT');
    res.status(201).json({
      message: `« ${name} » publié : ${parsed.chapters.length} chapitre(s), ${parsed.totalVerses} verset(s).`,
      id: bookId, chapters: parsed.chapters.length, verses: parsed.totalVerses, removed: staleIds.length,
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
    const verses = (await pool.query(
      'SELECT id, verse, text, heading FROM bible_verses WHERE book_id = $1 AND chapter = $2 ORDER BY verse', [book.id, chapter]
    )).rows;
    if (!verses.length) return res.status(404).json({ message: 'Chapitre introuvable' });
    const { prev, next } = await neighbours(book, chapter);
    res.json({ book: { id: book.id, name: book.name, abbreviation: book.abbreviation }, chapter, verses, prev, next });
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
