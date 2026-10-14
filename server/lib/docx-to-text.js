const JSZip = require('jszip');

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Découpe le document.xml en paragraphes avec texte, alignement et taille de police max
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
    items.push({ text, jc, size: maxSize });
  }
  return items;
}

const isPartie = (t) => /^PARTIE\s+[IVX]+$/.test(t);
const isChapitre = (t) => /^CHAPITRE\s+\d+(\s+BIS)?$/i.test(t);

// Même convention que l'espace d'étude : "# " = grand titre, "## " = sous-titre, sinon paragraphe
function buildParagraphs(items) {
  const out = [];
  const n = items.length;
  const hasPartie = items.some((it) => isPartie(it.text));
  const chapterPrefix = hasPartie ? '## ' : '# ';
  let i = 0;
  while (i < n) {
    const it = items[i];
    const t = it.text;

    if (isPartie(t)) {
      const next = i + 1 < n ? items[i + 1].text : '';
      const hasSub = next && !isPartie(next) && !isChapitre(next) && next.length < 120;
      out.push('# ' + t + (hasSub ? ' — ' + next : ''));
      i += hasSub ? 2 : 1;
      continue;
    }

    if (isChapitre(t)) {
      const titleParts = [];
      let j = i + 1;
      while (j < n && items[j].jc === 'center' && items[j].text.length < 90 && !isPartie(items[j].text) && !isChapitre(items[j].text)) {
        titleParts.push(items[j].text);
        j++;
      }
      out.push(chapterPrefix + t + (titleParts.length ? ' — ' + titleParts.join(' ') : ''));
      i = j;
      continue;
    }

    if (/^[✦\s]+$/.test(t)) {
      out.push('✦ ✦ ✦');
      i++;
      continue;
    }

    if (it.size >= 26 && it.jc !== 'center') {
      out.push('## ' + t);
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

module.exports = { docxToParagraphs };
