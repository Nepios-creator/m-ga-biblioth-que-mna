const JSZip = require('jszip');

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Un passage est en gras si <w:b/> est présent (et pas <w:b w:val="0"/>)
const hasBold = (rPr) => /<w:b(?:\s*\/>|\s+w:val="(?:1|true|on)"\s*\/?>)/.test(rPr || '');

// Découpe le document.xml en paragraphes : texte, alignement, taille de police, gras et style de titre Word
function extractItems(xml) {
  const rawChunks = xml.split('</w:p>');
  const items = [];
  for (const chunk of rawChunks) {
    const start = Math.max(chunk.lastIndexOf('<w:p '), chunk.lastIndexOf('<w:p>'));
    if (start === -1) continue;
    const p = chunk.slice(start);

    const jcMatch = p.match(/<w:jc w:val="(\w+)"/);
    const jc = jcMatch ? jcMatch[1] : null;

    const textMatches = [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
    const text = decodeXmlEntities(textMatches.map((m) => m[1]).join('')).trim();
    if (!text) continue;

    let maxSize = 0;
    const rPrBlocks = [...p.matchAll(/<w:rPr>([^]*?)<\/w:rPr>/g)];
    for (const block of rPrBlocks) {
      const szMatch = block[1].match(/<w:sz w:val="(\d+)"/);
      if (szMatch) maxSize = Math.max(maxSize, parseInt(szMatch[1], 10));
    }

    // Gras : tous les passages contenant du texte sont en gras
    const runs = [...p.matchAll(/<w:r(?:\s[^>]*)?>([^]*?)<\/w:r>/g)].filter((m) => /<w:t[\s>]/.test(m[1]));
    const bold = runs.length > 0 && runs.every((m) => hasBold((m[1].match(/<w:rPr>([^]*?)<\/w:rPr>/) || [])[1]));

    // Style de titre Word (Titre 1, Heading 2, Title…)
    const styleMatch = p.match(/<w:pStyle w:val="([^"]+)"/);
    const style = styleMatch ? styleMatch[1] : '';
    let level = 0;
    const lv = style.match(/^(?:Heading|Titre)\s*(\d)/i);
    if (lv) level = parseInt(lv[1], 10);
    else if (/^(?:Title|Titre)$/i.test(style)) level = 1;
    else if (/^(?:Subtitle|Sous-?titre)$/i.test(style)) level = 2;

    items.push({ text, jc, size: maxSize, bold, level });
  }
  return items;
}

const NUMWORDS = 'UNE?|DEUX|TROIS|QUATRE|CINQ|SIX|SEPT|HUIT|NEUF|DIX|ONZE|DOUZE|TREIZE|QUATORZE|QUINZE|SEIZE|DIX-(?:SEPT|HUIT|NEUF)|VINGT(?:-[A-ZÉÈ]+)*|PREMIER|PREMIÈRE';
// « CHAPITRE 1 », « CHAPITRE UN », « Chapitre I » — avec ou sans titre sur la même ligne (« CHAPITRE 1 — Le Christ »)
const CHAP_RE = new RegExp('^(?:CHAPITRE|CHAP\\.)\\s+(\\d+|[IVXLC]+|' + NUMWORDS + ')(\\s+BIS)?\\s*(?:[—–:.\\-]\\s*(.+))?$', 'i');
const PART_RE = /^PARTIE\s+([IVX]+|\d+)\s*(?:[—–:.\-]\s*(.+))?$/i;

const chap = (t) => { const m = t.match(CHAP_RE); return m ? { label: ('CHAPITRE ' + m[1] + (m[2] ? ' BIS' : '')).toUpperCase(), title: (m[3] || '').trim() } : null; };
const part = (t) => { const m = t.match(PART_RE); return m ? { label: ('PARTIE ' + m[1]).toUpperCase(), title: (m[2] || '').trim() } : null; };

// Taille de police du corps du livre : celle qui porte le plus de texte (0 = taille par défaut du document)
function bodySizeOf(items) {
  const weight = new Map();
  for (const it of items) weight.set(it.size, (weight.get(it.size) || 0) + it.text.length);
  let best = 0;
  let bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight) { best = size; bestWeight = w; }
  }
  return best;
}

const endsLikeSentence = (t) => /[.!?;:,»”]$/.test(t.trim());

// Même convention que l'espace d'étude : "# " = grand titre, "## " = sous-titre, sinon paragraphe
function buildParagraphs(items) {
  const out = [];
  const n = items.length;
  const hasPartie = items.some((it) => part(it.text));
  const chapterPrefix = hasPartie ? '## ' : '# ';
  const bodySize = bodySizeOf(items);

  // Un sous-titre est nettement plus grand que le texte du livre. Si tout le livre est écrit en grande police,
  // ses paragraphes restent de simples paragraphes au lieu de s'afficher tous en titres.
  const isBigger = (size) => (bodySize === 0 ? size >= 26 : size >= bodySize + 4);
  // Le gras ne distingue les titres que s'il n'est pas utilisé partout dans le livre
  const boldCount = items.filter((it) => it.bold).length;
  const boldIsDistinctive = n > 0 && boldCount / n < 0.5;
  const isTitleish = (it) => it.text.length <= 140 && !endsLikeSentence(it.text) &&
    (it.level > 0 || (boldIsDistinctive && it.bold) || isBigger(it.size) || it.jc === 'center');

  let i = 0;
  while (i < n) {
    const it = items[i];
    const t = it.text;

    const pa = part(t);
    if (pa) {
      let title = pa.title;
      let j = i + 1;
      if (!title && j < n && items[j].text.length < 120 && !part(items[j].text) && !chap(items[j].text) && isTitleish(items[j])) { title = items[j].text; j++; }
      out.push('# ' + pa.label + (title ? ' — ' + title : ''));
      i = j;
      continue;
    }

    const ch = chap(t);
    if (ch) {
      const titleParts = ch.title ? [ch.title] : [];
      let j = i + 1;
      if (!ch.title) {
        // Le titre principal du chapitre suit le numéro : on le rattache au titre (jusqu'à 3 lignes)
        while (j < n && titleParts.length < 3) {
          const nx = items[j];
          if (part(nx.text) || chap(nx.text) || nx.text.length > 140 || endsLikeSentence(nx.text)) break;
          const styled = nx.level > 0 || (boldIsDistinctive && nx.bold) || isBigger(nx.size) || nx.jc === 'center';
          if (!styled && !(titleParts.length === 0 && nx.text.length <= 90)) break; // texte courant isolé : le titre d'un chapitre sans mise en forme tient sur une ligne
          // Après la 1re ligne, on n'en ajoute d'autres que si le titre est centré sur plusieurs lignes ;
          // sinon la ligne suivante est un sous-titre du chapitre, pas la suite du titre principal
          if (titleParts.length > 0 && !(nx.jc === 'center' && items[j - 1].jc === 'center')) break;
          titleParts.push(nx.text);
          j++;
        }
      }
      out.push(chapterPrefix + ch.label + (titleParts.length ? ' — ' + titleParts.join(' ') : ''));
      i = j;
      continue;
    }

    if (/^[✦\s]+$/.test(t)) {
      out.push('✦ ✦ ✦');
      i++;
      continue;
    }

    // Titres et sous-titres du livre : style de titre Word, gras court, ou police nettement plus grande
    const strong = it.level > 0 || (boldIsDistinctive && it.bold) || isBigger(it.size);
    if (strong && t.length <= 160 && !endsLikeSentence(t)) {
      const top = it.level === 1 || (it.jc === 'center' && (it.bold || isBigger(it.size)) && !hasPartie);
      out.push((top ? '# ' : '## ') + t);
      i++;
      continue;
    }
    if (strong && it.size && isBigger(it.size) && it.jc !== 'center' && t.length <= 160) {
      out.push('## ' + t); // conserve l'ancien comportement pour les sous-titres en grande police qui se terminent par une ponctuation
      i++;
      continue;
    }

    out.push(t);
    i++;
  }
  return out;
}

// Retourne la liste des paragraphes du livre, ou null si le fichier est illisible
async function docxToParagraphs(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) return null;
  const xml = await xmlFile.async('string');
  const items = extractItems(xml);
  if (!items.length) return null;
  return buildParagraphs(items);
}

module.exports = { docxToParagraphs, _test: { extractItems, buildParagraphs } };
