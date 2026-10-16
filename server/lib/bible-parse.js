const JSZip = require('jszip');

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Reconnaît le vrai type d'un fichier d'après son contenu (et non d'après son nom : sur téléphone,
// le nom reçu n'a parfois pas d'extension).
function sniffFormat(buffer) {
  if (!buffer || !buffer.length) return 'empty';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'docx';                               // « PK » : fichier zip = .docx
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return 'doc'; // ancien Word .doc
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.slice(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if (buffer.slice(0, 4000).includes(0)) return 'binary';
  return 'text';
}

const WORD_HELP = 'Ouvrez-le dans Word puis faites « Enregistrer sous » au format Word (.docx), et téléversez-le de nouveau.';
const textOf = (xml) => decodeXmlEntities([...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
const flagOn = (rPr, tag) => new RegExp('<w:' + tag + '(?:\\s*\\/>|\\s+w:val="(?:1|true|on)"\\s*\\/?>)').test(rPr || '');

// Lit un fichier Word (.docx) et retourne ses paragraphes avec leur mise en forme (italique, encadré, zone de texte…),
// ainsi que les commentaires Word natifs. Les numéros de versets en exposant, ou numérotés automatiquement par Word,
// sont marqués ⟦n⟧ dans le texte.
async function docxToBlocks(buffer) {
  const kind = sniffFormat(buffer);
  if (kind === 'doc') throw new Error('Ce fichier est un ancien document Word (.doc), que le site ne sait pas lire. ' + WORD_HELP);
  if (kind === 'pdf') throw new Error('Ce fichier est un PDF : le texte d\'une Bible ne peut pas être reconnu de façon fiable depuis un PDF. Utilisez le fichier Word (.docx) ou collez le texte.');
  if (kind === 'rtf') throw new Error('Ce fichier est au format RTF. ' + WORD_HELP);
  if (kind !== 'docx') throw new Error('Fichier Word illisible. ' + WORD_HELP);

  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new Error('Fichier Word endommagé ou illisible. ' + WORD_HELP); }
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Fichier Word illisible (document.xml absent). ' + WORD_HELP);
  const xml = await file.async('string');

  // Commentaires Word natifs (« Insertion > Commentaire »)
  const nativeText = {};
  const cfile = zip.file('word/comments.xml');
  if (cfile) {
    const cx = await cfile.async('string');
    for (const m of cx.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
      const id = (m[1].match(/w:id="(\d+)"/) || [])[1];
      const author = decodeXmlEntities((m[1].match(/w:author="([^"]*)"/) || [])[1] || '');
      const paras = [...m[2].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((pp) => textOf(pp[0]).trim()).filter(Boolean);
      if (id !== undefined && paras.length) nativeText[id] = { text: paras.join('\n'), author };
    }
  }

  const blocks = [];
  const open = {};      // commentaires natifs dont la plage est ouverte : id → { anchor, block }
  const nativeRanges = {};
  const counters = {};  // numérotation automatique de Word : un compteur par liste
  let boxDepth = 0;
  const headingLike = (t) => t.length < 60 && (/^(?:chapitre|chap\.?|psaumes?|ps\.?)\s*\d{1,3}\b/i.test(t) || /^[A-Za-zÀ-ÿ0-9'’ .]{0,30}\s\d{1,3}$/.test(t) || /^\d{1,3}$/.test(t));
  let bodySizeVotes = {};

  for (const chunk of xml.split('</w:p>')) {
    const start = Math.max(chunk.lastIndexOf('<w:p '), chunk.lastIndexOf('<w:p>'));
    // Suivi des zones de texte : leurs paragraphes sont souvent des encadrés de commentaire
    const before = start === -1 ? chunk : chunk.slice(0, start);
    const opensBefore = (before.match(/<w:txbxContent[ >]/g) || []).length;
    const closesBefore = (before.match(/<\/w:txbxContent>/g) || []).length;
    const inBox = boxDepth + opensBefore - closesBefore > 0;
    boxDepth = Math.max(0, boxDepth + (chunk.match(/<w:txbxContent[ >]/g) || []).length - (chunk.match(/<\/w:txbxContent>/g) || []).length);
    if (start === -1) continue;
    const p = chunk.slice(start);

    let out = '';
    let sup = '';
    let italicAll = true, boldAll = true, hasText = false, maxSize = 0;
    const flushSup = () => { if (sup) { out += '⟦' + sup + '⟧'; sup = ''; } };

    const tokRe = /<w:commentRangeStart\s+w:id="(\d+)"\s*\/>|<w:commentRangeEnd\s+w:id="(\d+)"\s*\/>|<w:r[ >][\s\S]*?<\/w:r>/g;
    let m;
    while ((m = tokRe.exec(p))) {
      if (m[1] !== undefined) { open[m[1]] = { anchor: '', block: blocks.length }; continue; }
      if (m[2] !== undefined) {
        if (open[m[2]]) { nativeRanges[m[2]] = open[m[2]]; delete open[m[2]]; }
        continue;
      }
      const run = m[0];
      const rPr = (run.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
      const superscript = /<w:vertAlign w:val="superscript"\s*\/>/.test(rPr)
        || /<w:position w:val="[1-9]\d*"\s*\/>/.test(rPr)
        || /<w:rStyle w:val="[^"]*(?:verset|verse|exposant|superscript)[^"]*"/i.test(rPr);
      let runText = '';
      const wt = /<w:t[^>]*>([^<]*)<\/w:t>|<w:br[^>]*\/>|<w:tab\s*\/>/g;
      let t;
      while ((t = wt.exec(run))) {
        if (t[0].startsWith('<w:t')) runText += decodeXmlEntities(t[1]);
        else if (t[0].startsWith('<w:br')) runText += '\n';
        else runText += ' ';
      }
      if (runText.trim()) {
        hasText = true;
        if (!flagOn(rPr, 'i')) italicAll = false;
        if (!flagOn(rPr, 'b')) boldAll = false;
        const sz = (rPr.match(/<w:sz w:val="(\d+)"/) || [])[1];
        if (sz) maxSize = Math.max(maxSize, parseInt(sz, 10));
        for (const id of Object.keys(open)) open[id].anchor += runText;
      }
      // Un numéro coupé en plusieurs morceaux (« 1 » puis « 2 ») redevient « 12 »
      if (superscript && /^\s*\d{1,3}\s*$/.test(runText) && sup.length < 3) { sup += runText.trim(); continue; }
      flushSup();
      out += runText;
    }
    flushSup();
    for (const id of Object.keys(open)) open[id].anchor += ' '; // la plage continue dans le paragraphe suivant

    const text = out.replace(/\n/g, ' ').trim();
    if (!text) continue;

    // Numéro de verset automatique (liste numérotée Word) : on le rend visible au texte
    const numPr = p.match(/<w:numPr>([\s\S]*?)<\/w:numPr>/);
    const style = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    const isHeadingStyle = /^(?:Heading|Titre)\d?$/i.test(style);
    if (numPr && !isHeadingStyle) {
      const numId = (numPr[1].match(/<w:numId w:val="(\d+)"/) || [])[1];
      if (numId && numId !== '0') {
        counters[numId] = (counters[numId] || 0) + 1;
        if (!/^(?:⟦\d{1,3}⟧|\d{1,3}[\s.):])/.test(text)) out = '⟦' + counters[numId] + '⟧' + out;
      }
    } else if (headingLike(text)) {
      for (const k of Object.keys(counters)) counters[k] = 0; // un titre de chapitre : la numérotation repart de 1
    }

    const pPr = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
    const shd = (pPr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/) || [])[1];
    const shaded = !!shd && !/^(?:FFFFFF|ffffff)$/.test(shd);
    const bordered = /<w:pBdr>/.test(pPr);

    // Une zone de texte est dupliquée par Word (version moderne + de secours) : on ne garde qu'un exemplaire
    const last = blocks[blocks.length - 1];
    if (inBox && last && last.inBox && last.text === out) continue;

    if (maxSize) bodySizeVotes[maxSize] = (bodySizeVotes[maxSize] || 0) + text.length;
    blocks.push({ text: out, italic: hasText && italicAll, bold: hasText && boldAll, shaded, bordered, inBox, style, size: maxSize });
  }

  // Taille du texte courant du livre (celle qui porte le plus de texte)
  let bodySize = 0, bestVotes = -1;
  for (const [sz, v] of Object.entries(bodySizeVotes)) if (v > bestVotes) { bodySize = Number(sz); bestVotes = v; }
  blocks.forEach((b, i) => { b.idx = i; b.bodySize = bodySize; });

  const natives = [];
  for (const [id, r] of Object.entries(nativeRanges)) {
    if (nativeText[id]) natives.push({ id, text: nativeText[id].text, author: nativeText[id].author, anchorText: r.anchor.replace(/\s+/g, ' ').trim(), block: r.block });
  }
  return { blocks, natives };
}

// Ancienne interface : seulement les lignes de texte
async function docxToRawLines(buffer) {
  const { blocks } = await docxToBlocks(buffer);
  const lines = [];
  for (const b of blocks) for (const line of b.text.split('\n')) if (line.trim()) lines.push(line);
  return lines;
}

const CHAPTER_RE = /^(?:chapitre|chap\.?|psaumes?|ps\.?)\s*(\d{1,3})\b\s*[:.\-–—]?\s*(.*)$/i;
const CHAPTER_PREFIX_RE = /^[A-Za-zÀ-ÿ0-9'’ ]{1,25}\s(?:chapitre|chap\.?)\s*(\d{1,3})\s*$/i; // « Genèse chapitre 1 »
const NAME_NUM_RE = /^[A-Za-zÀ-ÿ'’. ]{2,30}?\s+(\d{1,3})\s*$/;                              // « Genèse 1 », « GENÈSE 2 »
const CV_RE = /^(\d{1,3})[:.](\d{1,3})\s+(\S.*)$/;
const LEAD_RE = /^(\d{1,3})(?:\s*[.)]\s*|\s+|(?=[A-Za-zÀ-ÿ«“"‘']))(\S[\s\S]*)$/;

// Découpe un texte en chapitres et versets. Le texte des versets n'est jamais modifié
// (seuls les espaces multiples sont réduits à un seul).
// `trace[i]` indique, après la ligne i, le chapitre et le dernier verset atteints (sert à placer les commentaires).
function parseBible(rawLines) {
  const warnings = [];
  const warn = (msg) => { if (warnings.length < 25) warnings.push(msg); };
  const kept = [];
  rawLines.forEach((l, orig) => {
    const t = String(l).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
    if (t) kept.push({ t, orig });
  });
  const lines = kept.map((k) => k.t);
  const trace = new Array(rawLines.length).fill(null);

  const chapters = new Map();
  let chapter = 0;
  let verses = null;
  let last = 0;
  let current = null;
  let pendingHeading = null;
  let duplicates = 0;
  let inferredNotice = false;
  let chapterAssumed = false;

  function startChapter(n) {
    chapter = n;
    if (!chapters.has(n)) chapters.set(n, []);
    verses = chapters.get(n);
    last = verses.length ? verses[verses.length - 1].verse : 0;
    current = verses.length ? verses[verses.length - 1] : null;
    pendingHeading = null;
  }

  function inferNextChapter() {
    startChapter(chapter + 1);
    if (!inferredNotice) {
      warn('Certains chapitres ont été déduits (la numérotation des versets repart à 1) : vérifiez l\'aperçu.');
      inferredNotice = true;
    }
  }

  function ensureChapter() {
    if (!verses) {
      startChapter(1);
      chapterAssumed = true;
      warn('Aucun titre de chapitre trouvé avant le premier verset : chapitre 1 supposé.');
    }
  }

  function startVerse(n, text) {
    ensureChapter();
    if (verses.some((v) => v.verse === n)) {
      duplicates++;
      warn(`Chapitre ${chapter} : le verset ${n} apparaît plusieurs fois.`);
    } else if (last && n > last + 1) {
      warn(`Chapitre ${chapter} : saut de numérotation entre ${last} et ${n}.`);
    }
    current = { verse: n, text: (text || '').trim(), heading: pendingHeading };
    pendingHeading = null;
    verses.push(current);
    last = n;
  }

  function appendText(t) {
    t = (t || '').trim();
    if (!t || !current) return;
    current.text = current.text ? current.text + ' ' + t : t;
  }

  // Cherche, dans une ligne, le début du verset attendu (numéro précédé d'une ponctuation de fin de phrase)
  function splitInline(text, expected) {
    const re = /([.!?;:»”)\]])\s+(\d{1,3})[.)]?\s+(?=[^\d\s])/g;
    let m;
    while ((m = re.exec(text))) {
      if (Number(m[2]) === expected) {
        return { before: text.slice(0, m.index + 1), n: expected, after: text.slice(m.index + m[0].length) };
      }
    }
    return null;
  }

  function absorb(rest) {
    let guard = 0;
    while (rest && guard++ < 500) {
      const sp = splitInline(rest, last + 1);
      if (!sp) { appendText(rest); return; }
      appendText(sp.before);
      startVerse(sp.n, '');
      rest = sp.after;
    }
  }

  const plausible = (n) => (last === 0 ? n === 1 : n > last && n <= last + 6);

  function step(i) {
    const line = lines[i];
    const nextLine = lines[i + 1] || '';

    // 1) Titre de chapitre : « Chapitre 3 », « Psaume 23 », « Genèse chapitre 3 », « Genèse 3 »…
    let m = line.length < 90 ? line.match(CHAPTER_RE) : null;
    if (m) {
      startChapter(Number(m[1]));
      if (m[2]) pendingHeading = m[2].trim();
      return;
    }
    if (line.length < 40) {
      m = line.match(CHAPTER_PREFIX_RE);
      if (m) { startChapter(Number(m[1])); return; }
      m = line.match(NAME_NUM_RE);
      // seulement si c'est bien le chapitre attendu, pour ne pas confondre avec une ligne de texte
      if (m && (Number(m[1]) === chapter + 1 || (chapter === 0 && Number(m[1]) === 1)) && !/^(?:ps|psaumes?)\b/i.test(line)) {
        startChapter(Number(m[1]));
        return;
      }
    }

    // 2) Numéros de verset en exposant (Word) : ⟦n⟧
    if (line.includes('⟦')) {
      for (const part of line.split(/(⟦\d{1,3}⟧)/).filter((p) => p !== '')) {
        const mm = part.match(/^⟦(\d{1,3})⟧$/);
        if (mm) {
          const n = Number(mm[1]);
          if (n === 1 && last > 1) inferNextChapter();
          startVerse(n, '');
        } else if (current) {
          appendText(part);
        } else {
          pendingHeading = (pendingHeading ? pendingHeading + ' ' : '') + part.trim();
        }
      }
      return;
    }

    // 3) Format « 3:16 texte »
    m = line.match(CV_RE);
    if (m) {
      const c = Number(m[1]);
      if (c !== chapter) startChapter(c);
      startVerse(Number(m[2]), '');
      absorb(m[3]);
      return;
    }

    // 3b) Numéro seul sur sa ligne : numéro de chapitre ou numéro de verset dont le texte est à la ligne suivante
    const solo = line.match(/^(\d{1,3})$/);
    if (solo) {
      const n = Number(solo[1]);
      const nextStartsAtOne = /^1(?:\s|$|[.)])/.test(nextLine) || /^⟦1⟧/.test(nextLine);
      if ((n === chapter + 1 || (chapter === 0 && n === 1)) && nextStartsAtOne) { startChapter(n); return; } // « 3 » puis « 1 Au commencement… »
      if (n === 1 && last > 1) { inferNextChapter(); startVerse(1, ''); return; }
      if (plausible(n)) { startVerse(n, ''); return; }
      if (n === chapter + 1) { startChapter(n); return; }
    }

    // 4) Verset numéroté en début de ligne : « 1 Au commencement… »
    const lead = line.match(LEAD_RE);
    if (lead && plausible(Number(lead[1]))) {
      startVerse(Number(lead[1]), '');
      absorb(lead[2]);
      return;
    }
    if (lead && Number(lead[1]) === 1 && last > 1) {
      inferNextChapter();
      startVerse(1, '');
      absorb(lead[2]);
      return;
    }

    // 5) Suite d'un verset, ou intertitre
    if (current) {
      const nextLead = nextLine.match(LEAD_RE);
      const nextIsVerse = !!(nextLead && plausible(Number(nextLead[1])));
      const looksLikeHeading = line.length < 100 && !/[.!?;:»”]$/.test(line);
      if (nextIsVerse && looksLikeHeading) { pendingHeading = line; return; }
      absorb(line);
      return;
    }
    pendingHeading = pendingHeading ? pendingHeading + ' ' + line : line;
  }

  for (let i = 0; i < lines.length; i++) {
    step(i);
    trace[kept[i].orig] = { chapter, last };
  }

  const out = [...chapters.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ch, vs]) => ({ chapter: ch, verses: vs }));

  let total = 0;
  const missing = [];
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    total += c.verses.length;
    if (!c.verses.length) { warn(`Chapitre ${c.chapter} : aucun verset détecté.`); continue; }
    if (c.verses[0].verse !== 1) warn(`Chapitre ${c.chapter} : le premier verset est le n° ${c.verses[0].verse}.`);
    const longest = Math.max(...c.verses.map((v) => v.text.length));
    if (c.verses.length === 1 && longest > 600) warn(`Chapitre ${c.chapter} : un seul verset très long détecté (numérotation non reconnue ?).`);
    if (i > 0 && c.chapter !== out[i - 1].chapter + 1) missing.push(`${out[i - 1].chapter + 1}–${c.chapter - 1}`);
  }
  if (missing.length) warn(`Chapitres absents : ${missing.join(', ')}.`);

  return { chapters: out, totalVerses: total, warnings, duplicates, chapterAssumed, trace };
}

// =====================================================================
//  Commentaires : repérage dans le document et rattachement aux versets
// =====================================================================

const MARKER_WORDS = 'commentaires?|commentary|notes?|explications?|observations?|r[ée]flexions?|m[ée]ditations?|applications?|[àa] retenir|points? importants?|passages? importants?|remarques?|enseignements?';
const MARKER_RE = new RegExp('^\\s*(' + MARKER_WORDS + ')(?=\\s*(?:[:—–\\-.(]|$|\\s(?:sur|du|des|au|aux|de|d\'|pour|concernant|\\d|v\\.|vv\\.|vers)))', 'i');
const COMMENT_STYLE_RE = /(commentaire|comment|note|encadr|citation|quote|aside|remarque|explication)/i;
const VREF = '(?:v{1,2}\\.?|vers(?:ets?)?\\.?)\\s*';
const NUMRANGE = '(\\d{1,3})(?:\\s*(?:[-–]|à|au|et)\\s*(?:' + VREF + ')?(\\d{1,3}))?';
// Références de versets, au début d'un paragraphe de commentaire
const LEAD_REFS = [
  new RegExp('^\\(?\\s*' + VREF + NUMRANGE + '\\s*\\)?\\s*[:.)—–\\-]?\\s*', 'i'),                  // « v. 3 : », « versets 3-5 », « (v. 3) »
  /^\(?\s*(\d{1,3})\s*(?:[-–]|à)\s*(\d{1,3})\s*\)?\s*[:.)—–\-]\s*/,                                 // « 3-5 : »
  /^\(?\s*\d{1,3}\s*[:.]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*\)?\s*[:.)—–\-]?\s*/,                 // « 1:3-5 »
];
const ANY_REF = new RegExp('(?:\\bv{1,2}\\.|\\bvers(?:ets?)?\\b\\.?)\\s*' + NUMRANGE, 'i');

function leadRef(text, inSection) {
  let m = text.match(LEAD_REFS[0]);
  if (m) return { start: Number(m[1]), end: Number(m[2] || m[1]), rest: text.slice(m[0].length) };
  m = text.match(LEAD_REFS[1]);
  if (m) return { start: Number(m[1]), end: Number(m[2]), rest: text.slice(m[0].length) };
  m = text.match(LEAD_REFS[2]);
  if (m) return { start: Number(m[1]), end: Number(m[2] || m[1]), rest: text.slice(m[0].length), chapterRef: true };
  if (inSection) { // dans une section « Commentaires » : « 3. … », « 3 : … », « 3 — … »
    m = text.match(/^\(?\s*(\d{1,3})\s*\)?\s*[:.)—–\-]\s*(\S[\s\S]*)$/);
    if (m) return { start: Number(m[1]), end: Number(m[1]), rest: m[2] };
  }
  return null;
}

// Une ligne qui ressemble à un verset du texte biblique (et non à un commentaire)
function looksLikeVerse(text, lastSeen) {
  const m = text.match(/^⟦(\d{1,3})⟧/) || text.match(/^(\d{1,3})(?=\s+\S)/);
  if (!m) return false;
  const n = Number(m[1]);
  return n === lastSeen + 1 || (n === 1 && lastSeen > 1) || (lastSeen === 0 && n === 1);
}

// Sépare les paragraphes du document en versets et en commentaires, puis rattache chaque commentaire à son verset.
// `blocks` : paragraphes (avec mise en forme) ; `natives` : commentaires Word natifs.
function parseBibleDocument(blocks, natives) {
  const verseLines = [];
  const lineBlock = [];   // numéro de paragraphe d'origine de chaque ligne de verset
  const items = [];       // commentaires repérés : { afterLine, ... }
  let inSection = false;  // on est dans une rubrique « Commentaires »
  let inRun = false;      // le paragraphe précédent était un commentaire : la suite (sans numéro de verset) en fait partie
  let lastSeen = 0;       // dernier numéro de verset aperçu (estimation)

  // Si presque tout le document a la même mise en forme (tout en italique, tout encadré…), elle ne distingue plus rien
  const total = Math.max(1, blocks.length);
  const rare = (key) => blocks.filter((b) => b[key]).length / total <= 0.5;
  const italicUseful = rare('italic'), boxUseful = rare('inBox') && rare('shaded') && rare('bordered');
  const isChapterHeading = (t) => t.length < 40 && (CHAPTER_RE.test(t) || CHAPTER_PREFIX_RE.test(t) || NAME_NUM_RE.test(t));

  const pushLines = (b) => {
    for (const line of b.text.split('\n')) {
      if (!line.trim()) continue;
      verseLines.push(line);
      lineBlock.push(b.idx);
      const mm = line.match(/^⟦(\d{1,3})⟧/) || line.match(/^(\d{1,3})(?:[.:]\d{1,3})?(?=\s|$)/);
      if (mm) lastSeen = Number(mm[1]);
      if (CHAPTER_RE.test(line)) lastSeen = 0;
    }
  };

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const text = b.text.replace(/\n/g, ' ').trim();
    if (!text) continue;
    const plain = text.replace(/⟦(\d{1,3})⟧/g, '$1 ').replace(/\s+/g, ' ').trim();

    // Un titre de chapitre met fin à une rubrique de commentaires
    if (isChapterHeading(plain)) { inSection = false; inRun = false; pushLines(b); continue; }

    const verseStart = looksLikeVerse(text, lastSeen);
    const marker = plain.match(MARKER_RE);
    const styleSaysComment = COMMENT_STYLE_RE.test(b.style || '');
    const boxCue = boxUseful && (b.inBox || b.shaded || b.bordered) || styleSaysComment;
    const startsWithVerseRef = !!leadRef(plain, false) && !verseStart;
    const italicCue = italicUseful && b.italic && plain.length >= 40 && !verseStart;
    const smallCue = b.size && b.bodySize && b.size <= b.bodySize - 3 && plain.length >= 40 && !verseStart;

    // Titre seul « Commentaire(s) » / « Notes » / « Passages importants » : ce qui suit est du commentaire
    const afterMarker = marker ? plain.replace(MARKER_RE, '').replace(/^[\s:—–\-.]+/, '').replace(/[:.]$/, '').trim() : '';
    const headingOnly = marker && (afterMarker === '' || /^(?:du chapitre|de ce chapitre|du passage|du texte|importants?|bibliques?)$/i.test(afterMarker));
    if (headingOnly) { inSection = true; inRun = true; continue; }

    // Un intertitre (court, sans ponctuation) juste avant un verset n'est pas la suite d'un commentaire
    const nextText = ((blocks[bi + 1] || {}).text || '').trim();
    const looksLikeIntertitle = plain.length < 80 && !/[.!?;:»”]$/.test(plain) && nextText && looksLikeVerse(nextText, lastSeen);

    let isComment = false;
    if (marker || startsWithVerseRef || boxCue || italicCue || smallCue) isComment = true;
    else if ((inSection || inRun) && !verseStart && !looksLikeIntertitle) isComment = true;
    if (isComment && verseStart && !marker && !boxCue) isComment = false;
    if (verseStart && !marker && !boxCue) { inSection = false; inRun = false; }

    if (!isComment) { inRun = false; pushLines(b); continue; }
    inRun = true;

    // Contenu du commentaire : marqueur et références de versets retirés du début du texte
    let rest = plain;
    let title = null;
    const mk = rest.match(MARKER_RE);
    if (mk) { title = mk[1].charAt(0).toUpperCase() + mk[1].slice(1).toLowerCase(); rest = rest.slice(mk[0].length).replace(/^[\s:—–\-.]+/, ''); }
    let ref = leadRef(rest, inSection);
    if (!ref && mk) ref = leadRef(rest.replace(/^(?:sur|du|des|au|aux|de|d'|pour|concernant)\s+/i, ''), inSection);
    if (ref) rest = ref.rest; else {
      const any = plain.slice(0, 140).match(ANY_REF);
      if (any) ref = { start: Number(any[1]), end: Number(any[2] || any[1]), rest, mention: true };
    }
    rest = rest.replace(/^[\s:—–\-.)]+/, '').trim();
    if (!rest && !ref) continue;
    items.push({ afterLine: verseLines.length, block: b.idx, title, ref, body: rest, explicit: !!ref, boxed: boxCue });
  }

  // Analyse des versets (les commentaires n'y sont plus mélangés)
  const parsed = parseBible(verseLines);

  // Rattachement : référence indiquée dans le document, sinon le verset qui précède le commentaire
  const verseExists = (ch, v) => (parsed.chapters.find((c) => c.chapter === ch) || { verses: [] }).verses.some((x) => x.verse === v);
  const lastOf = (ch) => { const c = parsed.chapters.find((x) => x.chapter === ch); return c && c.verses.length ? Math.max(...c.verses.map((v) => v.verse)) : 0; };
  const comments = [];
  const notes = [];
  for (const it of items) {
    const prev = it.afterLine > 0 ? parsed.trace[findOrig(verseLines, parsed, it.afterLine - 1)] : null;
    const ctxChapter = prev ? prev.chapter : (parsed.chapters[0] ? parsed.chapters[0].chapter : 1);
    let vs, ve, how;
    if (it.ref) {
      vs = it.ref.start; ve = Math.max(it.ref.start, it.ref.end); how = 'document';
      const max = lastOf(ctxChapter);
      if (max && vs > max) { notes.push(`Un commentaire cite le verset ${vs}, absent du chapitre ${ctxChapter} : il est placé à la fin du chapitre.`); vs = ve = max; how = 'approx'; }
      else if (max && ve > max) ve = max;
    } else if (prev && prev.last > 0) { vs = ve = prev.last; how = 'position'; }
    else { vs = ve = 0; how = 'debut'; } // avant le premier verset : en tête du chapitre
    comments.push({ chapter: ctxChapter, verse_start: vs, verse_end: ve, title: it.title, paragraphs: [it.body].filter(Boolean), how, _line: it.afterLine, _explicit: it.explicit, _block: it.block });
  }

  // Paragraphes de commentaire qui se suivent sans nouvelle référence : un seul commentaire
  const merged = [];
  for (const c of comments) {
    const p = merged[merged.length - 1];
    if (p && !c._explicit && !c.title && c._line === p._line && c.chapter === p.chapter) p.paragraphs.push(...c.paragraphs);
    else merged.push(c);
  }

  // Commentaires Word natifs : rattachés au verset qui contient le passage commenté
  for (const n of natives || []) {
    const snippet = n.anchorText.slice(0, 50).toLowerCase();
    let hit = null;
    if (snippet.length >= 8) {
      outer: for (const c of parsed.chapters) for (const v of c.verses) if (v.text.toLowerCase().includes(snippet)) { hit = { chapter: c.chapter, verse: v.verse }; break outer; }
    }
    if (!hit && parsed.chapters.length) {
      const c = parsed.chapters[0];
      hit = { chapter: c.chapter, verse: c.verses.length ? c.verses[c.verses.length - 1].verse : 0 };
      notes.push('Un commentaire Word n\'a pas pu être relié à un verset précis : il est placé à la fin du chapitre.');
    }
    if (hit) merged.push({ chapter: hit.chapter, verse_start: hit.verse, verse_end: hit.verse, title: n.author ? `Commentaire (${n.author})` : 'Commentaire', paragraphs: n.text.split('\n'), how: 'word' });
  }

  merged.sort((a, b) => a.chapter - b.chapter || a.verse_end - b.verse_end || a.verse_start - b.verse_start);
  merged.forEach((c) => { delete c._line; delete c._explicit; delete c._block; });

  const warnings = parsed.warnings.slice();
  notes.forEach((n) => { if (warnings.length < 30 && !warnings.includes(n)) warnings.push(n); });
  return { chapters: parsed.chapters, totalVerses: parsed.totalVerses, warnings, duplicates: parsed.duplicates, chapterAssumed: parsed.chapterAssumed, comments: merged };
}

// Retrouve l'indice d'origine (dans verseLines) d'une ligne : parseBible ignore les lignes vides, pas les nôtres
function findOrig(verseLines, parsed, i) { return i; }

// Pour un texte collé ou un .txt : mêmes règles, sans mise en forme
function parseBibleText(rawLines) {
  const blocks = rawLines.map((l, idx) => ({ text: String(l), italic: false, bold: false, shaded: false, bordered: false, inBox: false, style: '', size: 0, bodySize: 0, idx }));
  return parseBibleDocument(blocks, []);
}

module.exports = { docxToRawLines, docxToBlocks, parseBible, parseBibleDocument, parseBibleText, sniffFormat };
