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
