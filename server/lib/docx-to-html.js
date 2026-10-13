const JSZip = require('jszip');

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function buildBodyHtml(items) {
  const out = [];
  const n = items.length;
  // Même hiérarchie que le lecteur de l'espace d'étude : PARTIE = grand titre, CHAPITRE = sous-titre.
  // Sans repère PARTIE dans le livre, les chapitres deviennent les grands titres.
  const hasPartie = items.some((it) => isPartie(it.text));
  const chapterTag = hasPartie ? 'h3' : 'h2';
  let i = 0;
  while (i < n) {
    const it = items[i];
    const t = it.text;

    if (isPartie(t)) {
      const next = i + 1 < n ? items[i + 1].text : '';
      const hasSub = next && !isPartie(next) && !isChapitre(next) && next.length < 120;
      out.push(`<h2>${escapeHtml(t)}${hasSub ? ' — ' + escapeHtml(next) : ''}</h2>`);
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
      out.push(`<${chapterTag}>${escapeHtml(t)}${titleParts.length ? ' — ' + escapeHtml(titleParts.join(' ')) : ''}</${chapterTag}>`);
      i = j;
      continue;
    }

    if (/^[✦\s]+$/.test(t)) {
      out.push('<p class="sep">✦ ✦ ✦</p>');
      i++;
      continue;
    }

    if (it.size >= 26 && it.jc !== 'center') {
      out.push(`<h3>${escapeHtml(t)}</h3>`);
      i++;
      continue;
    }

    out.push(`<p${it.jc === 'center' ? ' class="center"' : ''}>${escapeHtml(t)}</p>`);
    i++;
  }
  return out.join('\n');
}

// Mise en page identique au lecteur de l'espace d'étude (police Fraunces, grand texte, page crème, en-tête du site)
const PAGE_CSS = `
  .wrap { max-width: 820px; margin: 0 auto; padding: 40px 24px 90px; }
  .panel { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 26px; }
  .ebook-text { font-size: 26px; line-height: 1.8; color: #241e16; font-family: 'Fraunces', Georgia, serif; overflow-wrap: anywhere; }
  .ebook-text p { margin: 0 0 1.3em; }
  .ebook-text p.center { text-align: center; }
  .ebook-text p.sep { text-align: center; color: var(--gold-deep); letter-spacing: .4em; }
  .ebook-text h2 { font-size: 1.5em; font-weight: 700; margin: 1em 0 0.6em; color: #16130f; line-height: 1.3; }
  .ebook-text h2:first-child { margin-top: 0; }
  .ebook-text h3 { font-size: 1.12em; font-weight: 700; font-style: italic; margin: 1.1em 0 0.5em; color: #3a2f1f; }
  .book-title { font-family: 'Fraunces', serif; font-size: 30px; line-height: 1.25; margin: 0 0 24px; }
  @media (min-width: 720px) { .ebook-text { font-size: 28px; } }
`;

// Transforme un fichier Word (.docx) en page de lecture au style du site. Retourne null si le fichier est illisible.
async function docxToHtml(docxBuffer, title) {
  const zip = await JSZip.loadAsync(docxBuffer);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) return null;
  const xml = await xmlFile.async('string');
  const items = extractItems(xml);
  if (!items.length) return null;

  const safeTitle = escapeHtml((title || 'Livre').trim());
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} — Ministère de la Nouvelle Alliance</title>
<link rel="stylesheet" href="/css/style.css">
<style>${PAGE_CSS}</style>
<meta name="theme-color" content="#16130f">
</head>
<body>
<header>
  <div class="brand"><a href="/">Ministère de la <span>Nouvelle Alliance</span></a></div>
  <nav>
    <a href="/catalogue.html">Catalogue</a>
  </nav>
</header>
<div class="wrap">
  <a href="/catalogue.html" class="btn btn-ghost" style="margin-bottom:18px;">← Retour au catalogue</a>
  <div class="panel">
    <h1 class="book-title">${safeTitle}</h1>
    <div class="ebook-text">
${buildBodyHtml(items)}
    </div>
  </div>
</div>
<footer>Ministère de la Nouvelle Alliance — © 2026</footer>
</body>
</html>`;
}

module.exports = { docxToHtml };
