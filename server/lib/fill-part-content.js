const pdfParse = require('pdf-parse');
const pool = require('../db/pool');

// Reconstruit le texte d'une page en repérant les lignes, les espacements entre paragraphes
// et les titres (gros caractères, "CHAPITRE N", ou numéros romains type "I. ...")
function pageToStructuredText(textContent) {
  const items = textContent.items.filter((i) => i.str.trim().length > 0);
  if (!items.length) return '';

  // Regroupe les items en lignes selon leur position verticale
  const lines = [];
  items.forEach((it) => {
    const y = Math.round(it.transform[5]);
    const h = Math.abs(it.transform[0]) || Math.abs(it.transform[3]) || 10;
    let line = lines.find((l) => Math.abs(l.y - y) < 3);
    if (!line) { line = { y, items: [], h }; lines.push(line); }
    line.items.push(it);
    line.h = Math.max(line.h, h);
  });
  lines.sort((a, b) => b.y - a.y); // haut vers bas
  lines.forEach((l) => l.items.sort((a, b) => a.transform[4] - b.transform[4]));
  lines.forEach((l) => { l.text = l.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(); });

  const bodyHeights = lines.map((l) => l.h).sort((a, b) => a - b);
  const bodySize = bodyHeights[Math.floor(bodyHeights.length / 2)] || 10;

  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const normalGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;

  let out = '';
  let prevWasChapterMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.text) continue;
    const isChapterMarker = /^CHAPITRE\s+\d+(\s+BIS)?$/i.test(l.text);
    const isBigFont = l.h >= bodySize * 1.22;
    const isRomanSub = /^[IVXLC]{1,5}\.\s+\S/.test(l.text) && l.text.length < 110;
    const isHeading = isChapterMarker || isBigFont || prevWasChapterMarker;
    prevWasChapterMarker = isChapterMarker;

    const gapBefore = i > 0 ? lines[i - 1].y - l.y : 0;
    const newParagraph = i === 0 || gapBefore > normalGap * 1.4 || isHeading || isRomanSub;

    if (isHeading) {
      out += `\n\n# ${l.text}\n\n`;
    } else if (isRomanSub) {
      out += `\n\n## ${l.text}\n\n`;
    } else if (newParagraph) {
      out += `\n\n${l.text}`;
    } else {
      out += ` ${l.text}`;
    }
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractPagesText(buffer) {
  const pages = [];
  await pdfParse(buffer, {
    pagerender: (pageData) =>
      pageData.getTextContent().then((tc) => {
        const text = pageToStructuredText(tc);
        pages.push(text);
        return text;
      }),
  });
  return pages;
}

// Remplit book_parts.content avec le vrai texte structuré du livre, automatiquement
async function fillMissingPartContent() {
  try {
    const parts = (await pool.query(
      `SELECT bp.id, bp.book_id, bp.page_start, bp.page_end
       FROM book_parts bp WHERE bp.content_filled = false`
    )).rows;
    if (!parts.length) return;

    const byBook = {};
    parts.forEach((p) => { (byBook[p.book_id] = byBook[p.book_id] || []).push(p); });

    for (const bookId of Object.keys(byBook)) {
      const book = (await pool.query('SELECT pdf_data, title FROM books WHERE id=$1', [bookId])).rows[0];
      if (!book || !book.pdf_data) continue;
      const pages = await extractPagesText(book.pdf_data);
      for (const part of byBook[bookId]) {
        const start = Math.max(1, part.page_start || 1);
        const end = Math.min(pages.length, part.page_end || pages.length);
        const text = pages.slice(start - 1, end).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
        await pool.query('UPDATE book_parts SET content=$1, content_filled=true WHERE id=$2', [text, part.id]);
      }
      console.log(`Texte structuré rempli pour "${book.title}" (${byBook[bookId].length} partie(s))`);
    }
  } catch (err) {
    console.error('Erreur fillMissingPartContent :', err.message);
  }
}

module.exports = { fillMissingPartContent };
