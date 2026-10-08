const JSZip = require('jszip');
const pdfParse = require('pdf-parse');
const pool = require('../db/pool');

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Découpe le document.xml en paragraphes avec texte, alignement et taille de police max
function extractDocxItems(xml) {
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

// Reconstruit un texte structuré (titres, sous-titres, paragraphes) à partir d'une tranche d'items
function buildStructuredText(slice) {
  const out = [];
  let i = 0;
  const n = slice.length;
  while (i < n) {
    const it = slice[i];
    const t = it.text;
    if (/^PARTIE\s+[IVX]+$/.test(t)) {
      const sub = i + 1 < n ? slice[i + 1].text : '';
      out.push(`# ${t} — ${sub}`);
      i += 2;
      continue;
    }
    if (/^CHAPITRE\s+\d+(\s+BIS)?$/i.test(t)) {
      const titleParts = [];
      let j = i + 1;
      while (j < n && slice[j].jc === 'center' && slice[j].text.length < 90 && !/^PARTIE\s+[IVX]+$/.test(slice[j].text)) {
        titleParts.push(slice[j].text);
        j++;
      }
      out.push(`## ${t} — ${titleParts.join(' ')}`);
      i = j;
      continue;
    }
    if (/^[✦\s]+$/.test(t)) {
      out.push('✦ ✦ ✦');
      i++;
      continue;
    }
    if (it.size >= 26 && it.jc !== 'center') {
      out.push(`### ${t}`);
      i++;
      continue;
    }
    out.push(t);
    i++;
  }
  return out.join('\n\n');
}

// Remplit les parties d'un livre à partir de son fichier Word (repères PARTIE I..N alignés sur l'ordre des parties en base)
async function fillFromDocx(book, parts) {
  const zip = await JSZip.loadAsync(book.docx_data);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) return false;
  const xml = await xmlFile.async('string');
  const items = extractDocxItems(xml);

  const partieStarts = items.reduce((acc, it, idx) => {
    if (/^PARTIE\s+[IVX]+$/.test(it.text)) acc.push(idx);
    return acc;
  }, []);
  if (!partieStarts.length || partieStarts.length < parts.length) return false;

  parts.sort((a, b) => a.part_index - b.part_index);
  for (let k = 0; k < parts.length; k++) {
    const start = partieStarts[k];
    const end = k + 1 < partieStarts.length ? partieStarts[k + 1] : items.length;
    const slice = items.slice(start, end);
    const text = buildStructuredText(slice);
    await pool.query('UPDATE book_parts SET content=$1, content_filled=true WHERE id=$2', [text, parts[k].id]);
  }
  return true;
}

// Repli : extraction depuis le PDF (moins structurée, mais fonctionne sans Word)
async function pageToStructuredText(textContent) {
  const items = textContent.items.filter((i) => i.str.trim().length > 0);
  if (!items.length) return '';
  const lines = [];
  items.forEach((it) => {
    const y = Math.round(it.transform[5]);
    const h = Math.abs(it.transform[0]) || Math.abs(it.transform[3]) || 10;
    let line = lines.find((l) => Math.abs(l.y - y) < 3);
    if (!line) { line = { y, items: [], h }; lines.push(line); }
    line.items.push(it);
    line.h = Math.max(line.h, h);
  });
  lines.sort((a, b) => b.y - a.y);
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
    if (isHeading) out += `\n\n# ${l.text}\n\n`;
    else if (isRomanSub) out += `\n\n## ${l.text}\n\n`;
    else {
      const gapBefore = i > 0 ? lines[i - 1].y - l.y : 0;
      out += (i === 0 || gapBefore > normalGap * 1.4) ? `\n\n${l.text}` : ` ${l.text}`;
    }
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function fillFromPdf(book, parts) {
  const pages = [];
  await pdfParse(book.pdf_data, {
    pagerender: (pageData) => pageData.getTextContent().then((tc) => {
      const text = pageToStructuredText(tc);
      pages.push(text);
      return text;
    }),
  });
  for (const part of parts) {
    const start = Math.max(1, part.page_start || 1);
    const end = Math.min(pages.length, part.page_end || pages.length);
    const text = pages.slice(start - 1, end).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    await pool.query('UPDATE book_parts SET content=$1, content_filled=true WHERE id=$2', [text, part.id]);
  }
}

// Découpe automatiquement un livre en parties, à partir de son Word (repères PARTIE ou CHAPITRE) ou, à défaut, de son PDF (en parts égales)
async function autoSplitDocx(book) {
  const zip = await JSZip.loadAsync(book.docx_data);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) return [];
  const xml = await xmlFile.async('string');
  const items = extractDocxItems(xml);
  if (!items.length) return [];

  const partieIdx = items.reduce((acc, it, idx) => { if (/^PARTIE\s+[IVX]+$/.test(it.text)) acc.push(idx); return acc; }, []);
  const chapitreIdx = items.reduce((acc, it, idx) => { if (/^CHAPITRE\s+\d+(\s+BIS)?$/i.test(it.text)) acc.push(idx); return acc; }, []);

  let boundaries;
  if (partieIdx.length >= 2) {
    boundaries = partieIdx;
  } else if (chapitreIdx.length >= 2) {
    const perPart = chapitreIdx.length > 12 ? 3 : chapitreIdx.length > 6 ? 2 : 1;
    boundaries = chapitreIdx.filter((_, i) => i % perPart === 0);
  } else {
    // Aucun repère détecté : on découpe en 6 tranches égales
    const n = 6;
    boundaries = Array.from({ length: n }, (_, i) => Math.floor((items.length * i) / n));
  }

  const results = [];
  for (let k = 0; k < boundaries.length; k++) {
    const start = boundaries[k];
    const end = k + 1 < boundaries.length ? boundaries[k + 1] : items.length;
    const slice = items.slice(start, end);
    if (!slice.length) continue;
    const content = buildStructuredText(slice);
    let title = `Partie ${k + 1}`;
    const headingItem = slice.find((it) => /^PARTIE\s+[IVX]+$/.test(it.text) || /^CHAPITRE\s+\d+/i.test(it.text));
    if (headingItem) {
      const idx = slice.indexOf(headingItem);
      const next = slice[idx + 1];
      title = next && next.jc === 'center' ? `${headingItem.text} — ${next.text}` : headingItem.text;
    }
    results.push({ title, content });
  }
  return results;
}

async function autoSplitPdf(book) {
  const pages = [];
  await pdfParse(book.pdf_data, {
    pagerender: (pageData) => pageData.getTextContent().then((tc) => {
      const text = pageToStructuredText(tc);
      pages.push(text);
      return text;
    }),
  });
  const n = Math.min(6, Math.max(1, pages.length));
  const results = [];
  for (let k = 0; k < n; k++) {
    const start = Math.floor((pages.length * k) / n);
    const end = k + 1 < n ? Math.floor((pages.length * (k + 1)) / n) : pages.length;
    results.push({ title: `Partie ${k + 1}`, content: pages.slice(start, end).join('\n\n'), page_start: start + 1, page_end: end });
  }
  return results;
}

// Découpe automatiquement tout livre de l'espace d'étude qui n'a pas encore de parties
async function autoSplitStudyBooks() {
  try {
    const books = (await pool.query(
      `SELECT b.* FROM books b
       WHERE b.is_study_book = true
         AND (b.docx_data IS NOT NULL OR b.pdf_data IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM book_parts bp WHERE bp.book_id = b.id)`
    )).rows;
    for (const book of books) {
      try {
        const parts = book.docx_data ? await autoSplitDocx(book) : await autoSplitPdf(book);
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          await pool.query(
            `INSERT INTO book_parts (book_id, part_index, title, content, content_filled, page_start, page_end)
             VALUES ($1,$2,$3,$4,true,$5,$6)`,
            [book.id, i + 1, p.title, p.content, p.page_start || null, p.page_end || null]
          );
        }
        console.log(`Découpage automatique de "${book.title}" : ${parts.length} partie(s)`);
      } catch (err) {
        console.error(`Échec du découpage automatique pour "${book.title}" :`, err.message);
      }
    }
  } catch (err) {
    console.error('Erreur autoSplitStudyBooks :', err.message);
  }
}

async function fillMissingPartContent() {
  try {
    const parts = (await pool.query(
      `SELECT bp.id, bp.book_id, bp.part_index, bp.page_start, bp.page_end FROM book_parts bp WHERE bp.content_filled = false`
    )).rows;
    if (!parts.length) return;

    const byBook = {};
    parts.forEach((p) => { (byBook[p.book_id] = byBook[p.book_id] || []).push(p); });

    for (const bookId of Object.keys(byBook)) {
      const book = (await pool.query('SELECT docx_data, pdf_data, title FROM books WHERE id=$1', [bookId])).rows[0];
      if (!book) continue;
      try {
        let done = false;
        if (book.docx_data) done = await fillFromDocx(book, byBook[bookId]);
        if (!done && book.pdf_data) await fillFromPdf(book, byBook[bookId]);
        console.log(`Texte structuré rempli pour "${book.title}" (source: ${book.docx_data && done ? 'Word' : 'PDF'})`);
      } catch (err) {
        console.error(`Échec remplissage pour le livre ${bookId} :`, err.message);
      }
    }
  } catch (err) {
    console.error('Erreur fillMissingPartContent :', err.message);
  }
}

module.exports = { fillMissingPartContent, autoSplitStudyBooks };
