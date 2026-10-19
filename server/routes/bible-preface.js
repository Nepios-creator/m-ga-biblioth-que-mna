'use strict';
// Préface de la Bible « Parole pure » : une seule préface, affichée à la première visite puis consultable à tout moment.
// - GET    /api/bible-preface                 : lecture (membres connectés)
// - POST   /api/bible-preface/admin/extract   : lit un fichier Word (.docx) ou texte (.txt) et renvoie son texte (rien n'est enregistré)
// - PUT    /api/bible-preface/admin           : enregistre la préface (administrateurs)
// - DELETE /api/bible-preface/admin           : retire la préface (administrateurs)
// Le texte est enregistré tel quel : les paragraphes sont séparés par une ligne vide, un titre commence par « # ».
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../lib/auth-middleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, fieldSize: 5 * 1024 * 1024 } });

function uploadOne(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(400).json({ message: tooBig ? 'Fichier trop volumineux (25 Mo maximum).' : 'Téléversement impossible : ' + err.message });
  });
}

// Table créée automatiquement à la première utilisation
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS bible_preface (
        id INTEGER PRIMARY KEY,
        title TEXT,
        body TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}
ensureSchema().catch((err) => console.error('Table de la préface de la Bible :', err.message));

const unesc = (s) => String(s == null ? '' : s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

const WORD_HELP = 'Ouvrez-le dans Word puis faites « Enregistrer sous » au format Word (.docx), ou collez le texte directement.';

// Lit un .docx : un paragraphe Word = un paragraphe ; titres (style Titre/Heading, ou ligne courte tout en gras) marqués « # »
async function docxToText(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new Error('Fichier Word endommagé ou illisible. ' + WORD_HELP); }
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Fichier Word illisible (document.xml absent). ' + WORD_HELP);
  const xml = await file.async('string');
  const out = [];
  for (const pm of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = pm[0];
    let text = '', allBold = true, any = false;
    for (const rm of p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
      const r = rm[0];
      const rPr = (r.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
      let t = '';
      for (const tm of r.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br[^>]*\/>/g)) {
        if (tm[1] !== undefined) t += unesc(tm[1]);
        else if (tm[0].startsWith('<w:br')) t += '\n';
        else t += ' ';
      }
      if (!t) continue;
      text += t;
      if (t.trim()) {
        any = true;
        if (!/<w:b(?:\s*\/>|\s+w:val="(?:1|true|on)"\s*\/>)/.test(rPr)) allBold = false;
      }
    }
    const clean = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    if (!clean) continue;
    const style = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    const isHeading = /^(?:Heading|Titre|Title)\d*$/i.test(style) || (any && allBold && clean.length < 80 && !/[.!?;,]$/.test(clean) && !clean.includes('\n'));
    out.push(isHeading ? '# ' + clean : clean);
  }
  return out.join('\n\n');
}

async function extractText(file) {
  const b = file.buffer;
  if (!b || !b.length) throw new Error('Le fichier reçu est vide. Choisissez-le de nouveau.');
  if (b[0] === 0x50 && b[1] === 0x4b) return docxToText(b);
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) throw new Error('Ce fichier est un ancien document Word (.doc), que le site ne sait pas lire. ' + WORD_HELP);
  if (b.slice(0, 5).toString('latin1') === '%PDF-') throw new Error('Ce fichier est un PDF : utilisez le fichier Word (.docx) ou collez le texte.');
  if (b.slice(0, 5).toString('latin1') === '{\\rtf') throw new Error('Ce fichier est au format RTF. ' + WORD_HELP);
  if (b.slice(0, 4000).includes(0)) throw new Error('Fichier illisible. ' + WORD_HELP);
  let text = b.toString('utf8');
  if (text.includes('\ufffd')) text = b.toString('latin1'); // ancien .txt (Windows-1252)
  return text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).join('\n\n');
}

// Lecture : la préface (ou { exists: false } tant qu'elle n'est pas publiée)
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const row = (await pool.query('SELECT title, body, updated_at FROM bible_preface WHERE id = 1')).rows[0];
    if (!row || !String(row.body || '').trim()) return res.json({ exists: false });
    res.json({ exists: true, title: row.title || 'Préface', body: row.body, updated_at: row.updated_at });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Administration
router.post('/admin/extract', requireAuth, requireAdmin, uploadOne, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choisissez un fichier (Word .docx ou .txt).' });
    const text = await extractText(req.file);
    if (!text.trim()) return res.status(400).json({ message: 'Aucun texte trouvé dans ce fichier.' });
    res.json({ text });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.put('/admin', requireAuth, requireAdmin, uploadOne, async (req, res) => {
  try {
    await ensureSchema();
    const title = String((req.body && req.body.title) || '').trim() || 'Préface';
    const body = String((req.body && req.body.body) || '').replace(/\r\n?/g, '\n').trim();
    if (!body) return res.status(400).json({ message: 'Le texte de la préface est vide.' });
    await pool.query(
      `INSERT INTO bible_preface (id, title, body, updated_at) VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = now()`,
      [title, body]
    );
    res.json({ message: 'Préface enregistrée : elle s\'affiche dès maintenant dans la Bible.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/admin', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    await pool.query('DELETE FROM bible_preface WHERE id = 1');
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
