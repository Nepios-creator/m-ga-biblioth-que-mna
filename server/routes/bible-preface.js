'use strict';
// Préface de la Bible « Parole pure » : une seule préface, affichée à la première visite puis consultable à tout moment.
// - GET    /api/bible-preface                 : lecture (membres connectés)
// - POST   /api/bible-preface/admin/extract   : lit un fichier Word (.docx) ou texte (.txt) et renvoie son contenu mis en forme (rien n'est enregistré)
// - PUT    /api/bible-preface/admin           : enregistre la préface (administrateurs)
// - DELETE /api/bible-preface/admin           : retire la préface (administrateurs)
// Un fichier Word est converti fidèlement (alignement, tailles, couleurs, gras, italique, espacements…) en document JSON v2 ;
// un texte simple (.txt ou collé) est enregistré tel quel : paragraphes séparés par une ligne vide, titre précédé de « # ».
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

const at = (s, n) => { const m = String(s || '').match(new RegExp('(?:^|\\s)' + n + '="([^"]*)"')); return m ? m[1] : null; };
const flag = (x, tag) => {
  const m = x.match(new RegExp('<w:' + tag + '\\b([^>]*?)/?>'));
  if (!m) return undefined;
  const v = at(m[1], 'w:val');
  return !(v === '0' || v === 'false' || v === 'off');
};
const roman = (n) => { let s = ''; for (const [v, t] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (n >= v) { s += t; n -= v; } return s; };
const letters = (n) => { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
const fmtNum = (fmt, n) => (fmt === 'lowerLetter' ? letters(n) : fmt === 'upperLetter' ? letters(n).toUpperCase() : fmt === 'lowerRoman' ? roman(n) : fmt === 'upperRoman' ? roman(n).toUpperCase() : String(n));

function parseRPr(x) {
  const o = {};
  let v;
  if ((v = flag(x, 'b')) !== undefined) o.b = v;
  if ((v = flag(x, 'i')) !== undefined) o.i = v;
  if ((v = flag(x, 'caps')) !== undefined) o.k = v;
  if ((v = flag(x, 'smallCaps')) !== undefined) o.sc = v;
  let m = x.match(/<w:u\b([^>]*?)\/?>/); if (m) o.u = at(m[1], 'w:val') !== 'none';
  m = x.match(/<w:color\b([^>]*?)\/?>/);
  if (m) { const c = at(m[1], 'w:val'); o.c = c && /^[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : null; }
  m = x.match(/<w:sz\b([^>]*?)\/?>/); if (m) { const n = Number(at(m[1], 'w:val')); if (n > 0) o.sz = n; }
  m = x.match(/<w:vertAlign\b([^>]*?)\/?>/); if (m) { const a = at(m[1], 'w:val'); o.va = a === 'superscript' ? 'sup' : a === 'subscript' ? 'sub' : null; }
  m = x.match(/<w:spacing\b([^>]*?)\/?>/); if (m) { const n = Number(at(m[1], 'w:val')); if (!isNaN(n)) o.ls = n; }
  m = x.match(/<w:rFonts\b([^>]*?)\/?>/); if (m) o.f = at(m[1], 'w:ascii') || at(m[1], 'w:hAnsi') || null;
  m = x.match(/<w:rStyle\b([^>]*?)\/?>/); if (m) o.rs = at(m[1], 'w:val');
  return o;
}
function parsePPr(raw) {
  const x = String(raw || '').replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '');
  const o = {};
  let m = x.match(/<w:jc\b([^>]*?)\/?>/);
  if (m) o.a = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', left: 'left', start: 'left' }[at(m[1], 'w:val')] || null;
  m = x.match(/<w:spacing\b([^>]*?)\/?>/);
  if (m) {
    const bf = at(m[1], 'w:before'), af = at(m[1], 'w:after'), ln = at(m[1], 'w:line'), lr = at(m[1], 'w:lineRule');
    if (bf !== null) o.bf = Number(bf);
    if (af !== null) o.af = Number(af);
    if (ln !== null && (!lr || lr === 'auto')) o.ln = Number(ln) / 240;
  }
  m = x.match(/<w:ind\b([^>]*?)\/?>/);
  if (m) {
    const l = at(m[1], 'w:left') !== null ? at(m[1], 'w:left') : at(m[1], 'w:start');
    const fl = at(m[1], 'w:firstLine'), h = at(m[1], 'w:hanging');
    if (l !== null) o.il = Number(l);
    if (fl !== null) o.fi = Number(fl);
    if (h !== null) o.fi = -Number(h);
  }
  const num = x.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
  if (num) {
    const id = at((num[1].match(/<w:numId\b([^>]*?)\/?>/) || [])[1], 'w:val');
    const lv = at((num[1].match(/<w:ilvl\b([^>]*?)\/?>/) || [])[1], 'w:val');
    o.numId = id; o.ilvl = Number(lv || 0);
  }
  const st = x.match(/<w:pStyle\b([^>]*?)\/?>/); if (st) o.ps = at(st[1], 'w:val');
  o.pbb = /<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")/.test(x);
  return o;
}
const overlay = (base, over) => { for (const k of Object.keys(over)) if (over[k] !== undefined) base[k] = over[k]; return base; };

async function docxToDoc(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new Error('Fichier Word endommagé ou illisible.'); }
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Fichier Word illisible (document.xml absent).');
  const xml = await file.async('string');
  const stylesXml = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : '';
  const numXml = zip.file('word/numbering.xml') ? await zip.file('word/numbering.xml').async('string') : '';

  // ----- Styles -----
  const styles = {};
  let defaultPara = null;
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = at(m[1], 'w:styleId');
    const body = m[2];
    const pPrRaw = (body.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
    const rest = body.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');
    const rPrRaw = (rest.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
    styles[id] = { type: at(m[1], 'w:type'), basedOn: at((body.match(/<w:basedOn\b([^>]*?)\/?>/) || [])[1], 'w:val'), p: parsePPr(pPrRaw), r: parseRPr(rPrRaw) };
    if (at(m[1], 'w:type') === 'paragraph' && at(m[1], 'w:default') === '1') defaultPara = id;
  }
  const dd = (stylesXml.match(/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/) || [])[1] || '';
  const ddR = parseRPr((dd.match(/<w:rPrDefault>[\s\S]*?<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '');
  const ddP = parsePPr((dd.match(/<w:pPrDefault>[\s\S]*?<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '');
  const chain = (id) => { const out = []; let g = 0; while (id && styles[id] && g++ < 12) { out.unshift(styles[id]); id = styles[id].basedOn; } return out; };
  const styleR = (id) => chain(id).reduce((a, s) => overlay(a, s.r), {});
  const styleP = (id) => chain(id).reduce((a, s) => overlay(a, s.p), {});

  // ----- Numérotation -----
  const absLvls = {}, numToAbs = {};
  for (const m of numXml.matchAll(/<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g)) {
    const id = at(m[1], 'w:abstractNumId'); absLvls[id] = {};
    for (const l of m[2].matchAll(/<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g)) {
      const il = at(l[1], 'w:ilvl');
      absLvls[id][il] = {
        fmt: at((l[2].match(/<w:numFmt\b([^>]*?)\/?>/) || [])[1], 'w:val') || 'decimal',
        txt: at((l[2].match(/<w:lvlText\b([^>]*?)\/?>/) || [])[1], 'w:val') || '%1.',
        start: Number(at((l[2].match(/<w:start\b([^>]*?)\/?>/) || [])[1], 'w:val') || 1),
        p: parsePPr((l[2].match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || ''),
      };
    }
  }
  for (const m of numXml.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g)) numToAbs[at(m[1], 'w:numId')] = at((m[2].match(/<w:abstractNumId\b([^>]*?)\/?>/) || [])[1], 'w:val');
  const counters = {};

  // ----- Paragraphes (1re passe) -----
  const raw = [];
  const sizeVotes = {}, fontVotes = {};
  let images = (xml.match(/<w:drawing\b|<w:pict\b/g) || []).length;
  const defStyleR = overlay({}, ddR);
  for (const pm of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = pm[0];
    const pPrRaw = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
    const markR = parseRPr((pPrRaw.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '');
    const direct = parsePPr(pPrRaw);
    const sid = direct.ps || defaultPara;
    const P = overlay(overlay(overlay({}, ddP), styleP(sid)), direct);
    const paraR = overlay(overlay({}, defStyleR), styleR(sid));
    const toks = [];
    for (const rm of p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
      const r = rm[0];
      const rPr = parseRPr((r.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '');
      const eff = overlay(overlay(overlay({}, paraR), rPr.rs ? styleR(rPr.rs) : {}), rPr);
      let t = '';
      for (const tm of r.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b([^>]*?)\/?>|<w:cr\s*\/>|<w:noBreakHyphen\s*\/>/g)) {
        if (tm[1] !== undefined) t += unesc(tm[1]);
        else if (tm[0].startsWith('<w:tab')) t += '    ';
        else if (tm[0].startsWith('<w:noBreakHyphen')) t += '\u2011';
        else if (tm[0].startsWith('<w:br') && at(tm[2], 'w:type') === 'page') t += '\f';
        else t += '\n';
      }
      if (!t) continue;
      toks.push({ t, eff });
    }
    // Marque de liste
    let marker = null, listInd = {};
    if (P.numId && P.numId !== '0' && numToAbs[P.numId] !== undefined) {
      const lv = (absLvls[numToAbs[P.numId]] || {})[String(P.ilvl || 0)];
      if (lv) {
        const c = counters[P.numId] = counters[P.numId] || {};
        const il = P.ilvl || 0;
        c[il] = c[il] === undefined ? lv.start : c[il] + 1;
        Object.keys(c).forEach((k) => { if (Number(k) > il) delete c[k]; });
        marker = lv.fmt === 'bullet' ? '•' : lv.txt.replace(/%(\d)/g, (mm, d) => { const lvl2 = (absLvls[numToAbs[P.numId]] || {})[String(Number(d) - 1)]; return fmtNum(lvl2 ? lvl2.fmt : 'decimal', c[Number(d) - 1] === undefined ? 1 : c[Number(d) - 1]); });
        listInd = lv.p;
      }
    }
    // Découpe aux sauts de page
    const segs = [[]];
    toks.forEach((k) => {
      const parts = k.t.split('\f');
      parts.forEach((part, idx) => { if (idx > 0) segs.push([]); if (part) segs[segs.length - 1].push({ t: part, eff: k.eff }); });
    });
    if (P.pbb) raw.push({ pb: 1 });
    segs.forEach((runs, si) => {
      if (si > 0) raw.push({ pb: 1 });
      const text = runs.map((x) => x.t).join('');
      runs.forEach((x) => {
        const n = x.t.replace(/\s/g, '').length; if (!n) return;
        const sz = x.eff.sz || defStyleR.sz || 20; sizeVotes[sz] = (sizeVotes[sz] || 0) + n;
        const f = fontKey(x.eff.f); fontVotes[f || ''] = (fontVotes[f || ''] || 0) + n;
      });
      if (!text.trim() && si === 0 && segs.length > 1) return; // paragraphe réduit à un saut de page
      if (!text.trim() && si > 0 && si === segs.length - 1) return; // rien après le saut de page dans ce paragraphe
      raw.push({ P, runs, marker: si === 0 ? marker : null, listInd, markSz: overlay(overlay({}, paraR), markR).sz });
    });
  }
  function fontKey(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    if (n.includes('garamond') || n.includes('cormorant')) return 'g';
    if (n.includes('times') || n.includes('georgia') || n.includes('cambria') || n.includes('palatino') || n.includes('book antiqua')) return 't';
    if (/arial|calibri|helvetica|segoe|verdana|tahoma|aptos|open sans|roboto/.test(n)) return 's';
    if (/courier|consolas|mono/.test(n)) return 'm';
    return null;
  }
  const top = (votes, def) => { let best = def, b = -1; for (const [k, v] of Object.entries(votes)) if (v > b) { best = k; b = v; } return best; };
  const bodySz = Number(top(sizeVotes, defStyleR.sz || 22)) || 22;
  const bf = top(fontVotes, '') || null;
  const bodyPt = bodySz / 2;
  const em = (tw) => Math.round((tw / 20 / bodyPt) * 100) / 100;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ----- 2e passe : paragraphes finaux -----
  const paras = [];
  let emptyRun = 0;
  for (const r of raw) {
    if (r.pb) { if (paras.length && !paras[paras.length - 1].pb) paras.push({ pb: 1 }); emptyRun = 0; continue; }
    const P = r.P;
    const o = {};
    if (P.a && P.a !== 'left') o.a = P.a;
    if (P.bf) o.b = clamp(em(P.bf), 0, 6);
    if (P.af) o.f = clamp(em(P.af), 0, 6);
    if (P.ln) o.l = clamp(Math.round(P.ln * 100) / 100, 1, 3);
    const il = r.marker ? (r.listInd.il !== undefined && P.il === undefined ? r.listInd.il : P.il) : P.il;
    let fi = P.fi;
    if (r.marker && fi === undefined && r.listInd.fi !== undefined) fi = r.listInd.fi;
    if (il) o.il = clamp(em(il), 0, 8);
    if (fi) o.fi = clamp(em(fi), -4, 4);
    // Fusion des morceaux de même mise en forme
    const runs = [];
    r.runs.forEach((x) => {
      const e = x.eff, q = { t: x.t };
      if (e.b) q.b = 1;
      if (e.i) q.i = 1;
      if (e.u) q.u = 1;
      if (e.k) q.k = 1;
      if (e.sc) q.sc = 1;
      if (e.va) q.va = e.va;
      if (e.c && e.c !== '000000') q.c = e.c;
      if (e.sz && Math.abs(e.sz / bodySz - 1) > 0.02) q.s = clamp(Math.round((e.sz / bodySz) * 100) / 100, 0.5, 3.5);
      if (e.ls) q.ls = clamp(Math.round((e.ls / 20 / bodyPt) * 100) / 100, -0.2, 1);
      const f = fontKey(e.f); if (f && f !== bf) q.f = f;
      const last = runs[runs.length - 1];
      const same = last && ['b', 'i', 'u', 'k', 'sc', 'va', 'c', 's', 'ls', 'f'].every((k) => last[k] === q[k]);
      if (same) last.t += q.t; else runs.push(q);
    });
    const text = runs.map((x) => x.t).join('').trim();
    if (!text) {
      if (r.marker) continue;
      if (++emptyRun > 3) continue;
      o.e = 1;
      const s = r.markSz ? clamp(Math.round((r.markSz / bodySz) * 100) / 100, 0.5, 3.5) : 1;
      if (Math.abs(s - 1) > 0.02) o.s = s;
      paras.push(o);
      continue;
    }
    emptyRun = 0;
    if (r.marker) o.m = r.marker;
    // Les espaces en début/fin de paragraphe ne comptent pas
    runs[0].t = runs[0].t.replace(/^\s+/, '');
    runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, '');
    o.r = runs.filter((x) => x.t);
    paras.push(o);
  }
  while (paras.length && (paras[paras.length - 1].e || paras[paras.length - 1].pb)) paras.pop();
  while (paras.length && paras[0].pb) paras.shift();
  if (!paras.some((x) => x.r)) throw new Error('Aucun texte trouvé dans ce fichier.');
  return { doc: { v: 2, bf, paras: paras.slice(0, 4000) }, info: { paragraphs: paras.length, images } };
}

// Reconstruit un document reçu du navigateur en ne gardant que des champs connus (jamais de HTML)
function sanitizeDoc(d) {
  const num = (v, a, b) => { v = Number(v); return isNaN(v) ? undefined : Math.max(a, Math.min(b, Math.round(v * 100) / 100)); };
  const out = { v: 2, bf: ['g', 't', 's', 'm'].includes(d.bf) ? d.bf : null, paras: [] };
  for (const p of (Array.isArray(d.paras) ? d.paras : []).slice(0, 4000)) {
    if (!p || typeof p !== 'object') continue;
    if (p.pb) { out.paras.push({ pb: 1 }); continue; }
    const o = {};
    if (['center', 'right', 'justify'].includes(p.a)) o.a = p.a;
    [['b', 0, 6], ['f', 0, 6], ['l', 1, 3], ['il', 0, 8], ['fi', -4, 4], ['s', 0.5, 3.5]].forEach(([k, a, b]) => { const v = num(p[k], a, b); if (v) o[k] = v; });
    if (p.e) o.e = 1;
    if (typeof p.m === 'string' && p.m) o.m = p.m.slice(0, 12);
    if (Array.isArray(p.r)) {
      o.r = [];
      for (const q of p.r.slice(0, 300)) {
        if (!q || typeof q.t !== 'string' || !q.t) continue;
        const x = { t: q.t.slice(0, 20000) };
        ['b', 'i', 'u', 'k', 'sc'].forEach((k) => { if (q[k]) x[k] = 1; });
        if (q.va === 'sup' || q.va === 'sub') x.va = q.va;
        if (typeof q.c === 'string' && /^[0-9A-Fa-f]{6}$/.test(q.c)) x.c = q.c.toUpperCase();
        const s = num(q.s, 0.5, 3.5); if (s) x.s = s;
        const ls = num(q.ls, -0.2, 1); if (ls) x.ls = ls;
        if (['g', 't', 's', 'm'].includes(q.f)) x.f = q.f;
        o.r.push(x);
      }
      if (!o.r.length) { if (!o.e) o.e = 1; delete o.r; }
    } else if (!o.e) continue;
    out.paras.push(o);
  }
  return out;
}


const WORD_HELP = 'Ouvrez-le dans Word puis faites « Enregistrer sous » au format Word (.docx), ou collez le texte directement.';

async function extractText(file) {
  const b = file.buffer;
  if (!b || !b.length) throw new Error('Le fichier reçu est vide. Choisissez-le de nouveau.');
  if (b[0] === 0x50 && b[1] === 0x4b) return { kind: 'doc', ...(await docxToDoc(b)) };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) throw new Error('Ce fichier est un ancien document Word (.doc), que le site ne sait pas lire. ' + WORD_HELP);
  if (b.slice(0, 5).toString('latin1') === '%PDF-') throw new Error('Ce fichier est un PDF : utilisez le fichier Word (.docx) ou collez le texte.');
  if (b.slice(0, 5).toString('latin1') === '{\\rtf') throw new Error('Ce fichier est au format RTF. ' + WORD_HELP);
  if (b.slice(0, 4000).includes(0)) throw new Error('Fichier illisible. ' + WORD_HELP);
  let text = b.toString('utf8');
  if (text.includes('\ufffd')) text = b.toString('latin1'); // ancien .txt (Windows-1252)
  return { kind: 'text', text: text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).join('\n\n') };
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
    const r = await extractText(req.file);
    if (r.kind === 'text' && !r.text.trim()) return res.status(400).json({ message: 'Aucun texte trouvé dans ce fichier.' });
    res.json(r);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.put('/admin', requireAuth, requireAdmin, uploadOne, async (req, res) => {
  try {
    await ensureSchema();
    const title = String((req.body && req.body.title) || '').trim() || 'Préface';
    let body = String((req.body && req.body.body) || '').replace(/\r\n?/g, '\n').trim();
    if (!body) return res.status(400).json({ message: 'Le texte de la préface est vide.' });
    if (body.startsWith('{')) { // document mis en forme : on le reconstruit champ par champ (jamais de HTML brut)
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { return res.status(400).json({ message: 'Document de préface invalide : choisissez de nouveau le fichier.' }); }
      const clean = sanitizeDoc(parsed);
      if (!clean.paras.some((p) => p.r && p.r.length)) return res.status(400).json({ message: 'Le texte de la préface est vide.' });
      body = JSON.stringify(clean);
    }
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
