const JSZip = require('jszip');

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Lit un fichier Word (.docx) et retourne ses lignes de texte (un paragraphe ou un retour à la ligne = une ligne).
// Les numéros de versets en exposant sont repérés et marqués ⟦n⟧ pour être reconnus sans ambiguïté.
async function docxToRawLines(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Fichier Word illisible');
  const xml = await file.async('string');
  const lines = [];
  for (const chunk of xml.split('</w:p>')) {
    const start = Math.max(chunk.lastIndexOf('<w:p '), chunk.lastIndexOf('<w:p>'));
    if (start === -1) continue;
    const p = chunk.slice(start);
    let out = '';
    const runRe = /<w:r[ >][\s\S]*?<\/w:r>/g;
    let m;
    while ((m = runRe.exec(p))) {
      const run = m[0];
      const superscript = /<w:vertAlign w:val="superscript"\s*\/>/.test(run);
      let runText = '';
      const tokRe = /<w:t[^>]*>([^<]*)<\/w:t>|<w:br[^>]*\/>|<w:tab\s*\/>/g;
      let t;
      while ((t = tokRe.exec(run))) {
        if (t[0].startsWith('<w:t')) runText += decodeXmlEntities(t[1]);
        else if (t[0].startsWith('<w:br')) runText += '\n';
        else runText += ' ';
      }
      if (superscript && /^\s*\d{1,3}\s*$/.test(runText)) out += '⟦' + runText.trim() + '⟧';
      else out += runText;
    }
    for (const line of out.split('\n')) {
      if (line.trim()) lines.push(line);
    }
  }
  return lines;
}

const CHAPTER_RE = /^(?:chapitre|chap\.?|psaumes?|ps\.?)\s*(\d{1,3})\b\s*[:.\-–—]?\s*(.*)$/i;
const CV_RE = /^(\d{1,3})[:.](\d{1,3})\s+(\S.*)$/;
const LEAD_RE = /^(\d{1,3})(?:\s*[.)]\s*|\s+|(?=[A-Za-zÀ-ÿ«“"‘']))(\S[\s\S]*)$/;

// Découpe un texte en chapitres et versets. Le texte des versets n'est jamais modifié
// (seuls les espaces multiples sont réduits à un seul).
function parseBible(rawLines) {
  const warnings = [];
  const warn = (msg) => { if (warnings.length < 25) warnings.push(msg); };
  const lines = rawLines
    .map((l) => String(l).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const chapters = new Map();
  let chapter = 0;
  let verses = null;
  let last = 0;
  let current = null;
  let pendingHeading = null;
  let duplicates = 0;
  let inferredNotice = false;

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) Titre de chapitre : « Chapitre 3 », « Psaume 23 »…
    let m = line.length < 90 ? line.match(CHAPTER_RE) : null;
    if (m) {
      startChapter(Number(m[1]));
      if (m[2]) pendingHeading = m[2].trim();
      continue;
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
      continue;
    }

    // 3) Format « 3:16 texte »
    m = line.match(CV_RE);
    if (m) {
      const c = Number(m[1]);
      if (c !== chapter) startChapter(c);
      startVerse(Number(m[2]), '');
      absorb(m[3]);
      continue;
    }

    // 4) Verset numéroté en début de ligne : « 1 Au commencement… »
    const lead = line.match(LEAD_RE);
    if (lead && plausible(Number(lead[1]))) {
      startVerse(Number(lead[1]), '');
      absorb(lead[2]);
      continue;
    }
    if (lead && Number(lead[1]) === 1 && last > 1) {
      inferNextChapter();
      startVerse(1, '');
      absorb(lead[2]);
      continue;
    }

    // 5) Suite d'un verset, ou intertitre
    if (current) {
      const next = lines[i + 1] || '';
      const nextLead = next.match(LEAD_RE);
      const nextIsVerse = !!(nextLead && plausible(Number(nextLead[1])));
      const looksLikeHeading = line.length < 100 && !/[.!?;:»”]$/.test(line);
      if (nextIsVerse && looksLikeHeading) { pendingHeading = line; continue; }
      absorb(line);
      continue;
    }
    pendingHeading = pendingHeading ? pendingHeading + ' ' + line : line;
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

  return { chapters: out, totalVerses: total, warnings, duplicates };
}

module.exports = { docxToRawLines, parseBible };
