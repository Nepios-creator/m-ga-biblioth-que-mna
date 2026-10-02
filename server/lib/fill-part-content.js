const pdfParse = require('pdf-parse');
const pool = require('../db/pool');

// Extrait le texte de chaque page du PDF séparément (au lieu du texte global)
async function extractPagesText(buffer) {
  const pages = [];
  await pdfParse(buffer, {
    pagerender: (pageData) =>
      pageData.getTextContent().then((tc) => {
        const text = tc.items.map((i) => i.str).join(' ');
        pages.push(text);
        return text;
      }),
  });
  return pages;
}

// Remplit book_parts.content avec le vrai texte du livre (une fois par partie), automatiquement
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
        const text = pages.slice(start - 1, end).join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n\n').trim();
        await pool.query('UPDATE book_parts SET content=$1, content_filled=true WHERE id=$2', [text, part.id]);
      }
      console.log(`Texte intégral rempli pour "${book.title}" (${byBook[bookId].length} partie(s))`);
    }
  } catch (err) {
    console.error('Erreur fillMissingPartContent :', err.message);
  }
}

module.exports = { fillMissingPartContent };
