'use strict';
// Lecture d'un chapitre au format « Les Saintes Écritures — Parole pure » (fichier Word, un chapitre par fichier).
// Ce lecteur comprend : la numérotation AUTOMATIQUE de Word (listes qui repartent d'une valeur de départ : 7, 11, 19…),
// les numéros de versets glissés au milieu d'un paragraphe, les lettres de renvoi en exposant (a, b, … aa, ab),
// les intertitres ❧ … ❧, le titre « CHAPITRE I » (chiffres romains) avec son sous-titre, et les notes « · v.N … » à lettres.
// Il renvoie null si le fichier n'est pas de ce format : l'ancien lecteur (bible-parse.js) prend alors le relais.
const JSZip = require('jszip');

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
function toNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const u = s.toUpperCase(); let n = 0;
  for (let i = 0; i < u.length; i++) { const v = ROMAN[u[i]], w = ROMAN[u[i + 1]] || 0; n += v < w ? -v : v; }
  return n;
}
// Lettre automatique de Word pour le n-ième élément : a…z, puis aa, bb, cc…
const letterFor = (n) => String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
// Écriture usuelle après « z » dans les versets : aa, ab, ac…
const altLetterFor = (n) => (n > 26 ? 'a' + String.fromCharCode(97 + ((n - 27) % 26)) : null);

function readNumbering(xml) {
  const abs = {};
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const lvl = (m[0].match(/<w:lvl w:ilvl="0"[\s\S]*?<\/w:lvl>/) || [''])[0];
    abs[m[1]] = { start: Number((lvl.match(/<w:start w:val="(\d+)"/) || [])[1] || 1), fmt: (lvl.match(/<w:numFmt w:val="(\w+)"/) || [])[1] || 'decimal' };
  }
  const nums = {};
  for (const m of xml.matchAll(/<w:num w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const a = abs[(m[2].match(/<w:abstractNumId w:val="(\d+)"/) || [])[1]] || { start: 1, fmt: 'decimal' };
    const ov = (m[2].match(/<w:startOverride w:val="(\d+)"/) || [])[1];
    nums[m[1]] = { start: ov ? Number(ov) : a.start, fmt: a.fmt };
  }
  return nums;
}

function readParagraphs(xml, nums) {
  const counters = {}, out = [];
  for (const pm of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = pm[0];
    const pPr = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
    const numPr = pPr.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
    const numId = numPr && (numPr[1].match(/<w:numId w:val="(\d+)"/) || [])[1];
    const lvl = numPr ? Number((numPr[1].match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0) : 0;
    let list = null;
    if (numId && numId !== '0' && nums[numId] && lvl === 0) {
      counters[numId] = counters[numId] === undefined ? nums[numId].start : counters[numId] + 1;
      list = { fmt: nums[numId].fmt, n: counters[numId] };
    }
    const runs = [];
    for (const rm of p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
      const r = rm[0];
      const rPr = (r.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
      let text = '';
      for (const t of r.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br[^>]*\/>/g)) text += t[1] !== undefined ? unesc(t[1]) : ' ';
      if (!text) continue;
      runs.push({
        text,
        sup: /<w:vertAlign w:val="superscript"\s*\/>/.test(rPr) || /<w:position w:val="[1-9]\d*"\s*\/>/.test(rPr),
        bold: /<w:b(?:\s*\/>|\s+w:val="(?:1|true)"\s*\/>)/.test(rPr),
        italic: /<w:i(?:\s*\/>|\s+w:val="(?:1|true)"\s*\/>)/.test(rPr),
        size: Number((rPr.match(/<w:sz w:val="(\d+)"/) || [])[1] || 0),
      });
    }
    const text = runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
    out.push({ runs, text, list, style: (pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '' });
  }
  return out.filter((p) => p.text);
}

const CHAPTER = /^(?:chapitre|chap\.?|psaumes?|ps\.?)\s*([IVXLCDM]+|\d{1,3})\b\s*[:.\-–—]?\s*(.*)$/i;
const NOTES_HEAD = /^(?:notes?|commentaires?|remarques?)\b/i;
const NOTE = /^(?:([a-z]{1,2})\s*)?[·•]?\s*v(?:ers(?:et)?s?)?\.?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*([\s\S]*)$/i;
const BOOK_TITLE = /^(?:évangile|evangile|livre|épître|epitre|lettre|actes|apocalypse|premier|second)\b/i;
// Texte d'un paragraphe de note, avec les mots en italique entourés de *…* (le lecteur du site les met en italique)
const marked = (runs) => runs.map((r) => (r.italic && r.text.trim() ? r.text.replace(/^(\s*)([\s\S]*?)(\s*)$/, '$1*$2*$3') : r.text)).join('').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

async function parseBibleDocx(buffer) {
  let doc = '', numbering = '';
  try {
    const zip = await JSZip.loadAsync(buffer);
    const get = async (n) => { const f = zip.file(n); return f ? f.async('string') : ''; };
    doc = await get('word/document.xml'); numbering = await get('word/numbering.xml');
  } catch (e) { return null; }
  if (!doc) return null;
  const paras = readParagraphs(doc, readNumbering(numbering));

  // Taille du texte courant des versets (les numéros glissés dans un paragraphe sont bien plus petits)
  const votes = {};
  (paras.some((p) => p.list && p.list.fmt === 'decimal') ? paras.filter((p) => p.list && p.list.fmt === 'decimal') : paras)
    .forEach((p) => p.runs.forEach((r) => { if (r.size && !r.sup) votes[r.size] = (votes[r.size] || 0) + r.text.length; }));
  let bodySize = 0, best = -1;
  for (const [s, v] of Object.entries(votes)) if (v > best) { bodySize = Number(s); best = v; }

  const warnings = [], warn = (m) => { if (warnings.length < 30 && !warnings.includes(m)) warnings.push(m); };
  const chapters = new Map(), chapterInfo = {}, noteItems = [], lines = [], edition = [];
  let chapter = 0, verses = null, cur = null, last = 0, pending = null, inNotes = false, expectSub = false;
  let chapterAssumed = false, duplicates = 0, bookTitle = '';

  const startChapter = (n) => {
    chapter = n; if (!chapters.has(n)) chapters.set(n, []);
    verses = chapters.get(n); cur = null; last = verses.length ? Math.max(...verses.map((v) => v.verse)) : 0; pending = null;
  };
  const startVerse = (n) => {
    if (!verses) { startChapter(1); chapterAssumed = true; warn('Le titre du chapitre (« CHAPITRE … ») est introuvable : chapitre 1 supposé.'); }
    if (verses.some((v) => v.verse === n)) { duplicates++; warn(`Chapitre ${chapter} : le verset ${n} apparaît plusieurs fois (numérotation Word à vérifier).`); }
    else if (last && n > last + 1) warn(`Chapitre ${chapter} : saut de numérotation entre ${last} et ${n}.`);
    else if (last && n < last) warn(`Chapitre ${chapter} : le verset ${n} vient après le verset ${last}.`);
    cur = { verse: n, text: '', heading: pending, notes: [] }; pending = null; verses.push(cur); last = Math.max(last, n);
  };
  const appendText = (t) => {
    if (!cur) return;
    let s = t.replace(/\s+/g, ' ');
    if (!cur.text || /\s$/.test(cur.text)) s = s.replace(/^\s+/, '');
    cur.text += s;
  };
  const isNumberRun = (r) => /^\s*\d{1,3}\s*$/.test(r.text) && (r.sup || (r.bold && r.size && bodySize && r.size <= bodySize * 0.8));
  const isLetterRun = (r) => r.sup && /^\s*[a-z]{1,2}\s*$/i.test(r.text);
  const feed = (runs) => {
    for (const r of runs) {
      if (isNumberRun(r)) startVerse(parseInt(r.text, 10));
      else if (isLetterRun(r) && cur && cur.text.trim()) cur.notes.push({ letter: r.text.trim().toLowerCase(), offset: cur.text.replace(/\s+$/, '').length });
      else appendText(r.text);
    }
  };

  paras.forEach((p, i) => {
    const plain = p.text;
    const decimal = p.list && p.list.fmt === 'decimal';
    lines.push((decimal && !inNotes ? p.list.n + ' ' : '') + plain);
    const next = paras[i + 1];

    const cm = !p.list && plain.length < 90 ? plain.match(CHAPTER) : null;
    if (cm) { startChapter(toNumber(cm[1])); inNotes = false; expectSub = true; if (cm[2]) { chapterInfo[chapter] = { subtitle: cm[2].trim() }; expectSub = false; } return; }
    if (!p.list && plain.length < 80 && NOTES_HEAD.test(plain)) { inNotes = true; return; }

    if (inNotes) {
      const mt = marked(p.runs), nm = mt.match(NOTE);
      if (nm || (p.list && p.list.fmt === 'lowerLetter')) {
        const fromList = p.list && p.list.fmt === 'lowerLetter' ? p.list.n : 0;
        const rest = nm ? nm[4] : mt;
        const k = rest.indexOf(' : ');
        const labelled = k > 0 && k < 100;
        noteItems.push({
          chapter, start: nm ? Number(nm[2]) : 0, end: nm ? Number(nm[3] || nm[2]) : 0,
          letter: nm && nm[1] ? nm[1].toLowerCase() : (fromList ? letterFor(fromList) : null), alt: fromList ? altLetterFor(fromList) : null,
          title: labelled ? rest.slice(0, k).replace(/\*/g, '').trim() : null, paragraphs: [(labelled ? rest.slice(k + 3) : rest).trim()],
        });
        if (!nm) warn('Une note n\'indique pas de numéro de verset (« · v.N … ») : elle sera placée en tête du chapitre.');
      } else if (noteItems.length) noteItems[noteItems.length - 1].paragraphs.push(mt);
      return;
    }

    if (plain.includes('❧')) { pending = plain.replace(/❧/g, '').replace(/\s+/g, ' ').trim(); return; }
    if (decimal) { startVerse(p.list.n); feed(p.runs); return; }

    if (!cur && !(verses && verses.length)) { // avant le premier verset : page de titre, titre du livre, sous-titre du chapitre
      if (!bookTitle && (/^Titre\s?1$|^Heading\s?1$/i.test(p.style) || BOOK_TITLE.test(plain))) bookTitle = plain;
      else if (expectSub) { chapterInfo[chapter] = { subtitle: plain }; expectSub = false; }
      else edition.push(plain);
      return;
    }
    const heading = plain.length < 100 && !/[.!?;:,»”"…)]$/.test(plain) && next && next.list && next.list.fmt === 'decimal';
    if (heading) { pending = plain; return; }
    appendText(' '); feed(p.runs); // suite du verset en cours (retour à la ligne dans Word)
  });

  const out = [...chapters.entries()].sort((a, b) => a[0] - b[0]).map(([ch, vs]) => ({ chapter: ch, verses: vs }));
  let totalVerses = 0;
  out.forEach((c) => c.verses.forEach((v) => {
    totalVerses++; v.text = v.text.trim();
    v.notes.forEach((n) => { n.offset = Math.min(n.offset, v.text.length); });
    if (!v.text) warn(`Chapitre ${c.chapter} : le verset ${v.verse} est vide.`);
    const rg = v.heading && v.heading.match(/v\.?\s*(\d+)\s*[–-]\s*(\d+)/);
    if (rg && Number(rg[1]) !== v.verse) warn(`L'intertitre « ${v.heading} » annonce le verset ${rg[1]} mais précède le verset ${v.verse}.`);
  }));
  if (!totalVerses) return null;

  // Chaque lettre de renvoi du texte est reliée à la note de même lettre
  const markers = [];
  out.forEach((c) => c.verses.forEach((v) => v.notes.forEach((n) => markers.push({ chapter: c.chapter, verse: v.verse, letter: n.letter, matched: false }))));
  const comments = noteItems.map((it) => {
    const m = markers.find((x) => !x.matched && it.letter && x.letter === it.letter) || markers.find((x) => !x.matched && it.alt && x.letter === it.alt);
    if (m) {
      m.matched = true;
      if (it.start && (m.verse < it.start || m.verse > it.end)) warn(`La note « ${m.letter} » est annoncée pour le verset ${it.start} mais sa lettre est au verset ${m.verse}.`);
    } else warn(`La note « ${it.letter || '?'} » (verset ${it.start || '?'}) n'a pas de lettre correspondante dans le texte.`);
    const vs = it.start || (m ? m.verse : 0);
    return { chapter: it.chapter || (m ? m.chapter : out[0].chapter), verse_start: vs, verse_end: it.end || vs, title: it.title, letter: m ? m.letter : it.letter, paragraphs: it.paragraphs.filter(Boolean), how: 'note' };
  });
  markers.filter((m) => !m.matched).forEach((m) => warn(`La lettre « ${m.letter} » du verset ${m.verse} n'a pas de note correspondante.`));

  return { lines, parsed: { chapters: out, totalVerses, warnings, duplicates, chapterAssumed, comments, notes: markers, chapterInfo, bookTitle, edition } };
}

module.exports = { parseBibleDocx };
