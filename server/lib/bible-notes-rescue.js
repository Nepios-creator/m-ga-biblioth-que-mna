'use strict';
// Filet de sécurité pour les notes explicatives.
// Quand la rubrique « Notes · Chapitre II » n'est pas reconnue par le lecteur de fichier, tout son texte se retrouve
// collé à la fin du dernier verset du chapitre. Cette fonction l'en détache (le verset retrouve son texte exact)
// et transforme chaque note « a · v.1 « mot » : explication… » en note reliée à sa lettre dans les versets.
// Elle ne fait rien quand le fichier a déjà été lu correctement.

const HEAD = /\s+(?:notes?|commentaires?|remarques?)\s*[·•:\-–—]\s*chapitre\s+(?:[IVXLCDM]+|\d{1,3})\s+(?=[a-z]{1,4}\s*[·•]\s*v)/i;
const SPLIT = /\s+(?=[a-z]{1,4}\s*[·•]\s*v(?:ers(?:et)?s?)?\.?\s*\d{1,3})/;
const NOTE = /^([a-z]{1,4})\s*[·•]\s*v(?:ers(?:et)?s?)?\.?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*([\s\S]*)$/;

function rescueGluedNotes(parsed) {
  let rescued = 0;
  if (!parsed || !Array.isArray(parsed.chapters)) return rescued;
  const letters = new Set();
  for (const c of parsed.chapters) {
    const v = c.verses && c.verses[c.verses.length - 1];
    if (!v || typeof v.text !== 'string') continue;
    const m = HEAD.exec(v.text);
    if (!m) continue;
    const pieces = v.text.slice(m.index + m[0].length).split(SPLIT).map((p) => p.trim()).filter(Boolean);
    const found = pieces.map((p) => NOTE.exec(p));
    if (!found.length || found.some((x) => !x)) continue; // en cas de doute, on ne touche à rien

    v.text = v.text.slice(0, m.index).trim();
    (v.notes || []).forEach((n) => { n.offset = Math.min(n.offset, v.text.length); });
    if (!Array.isArray(parsed.comments)) parsed.comments = [];
    found.forEach((x) => {
      const rest = x[4].trim();
      const k = rest.indexOf(' : ');
      const labelled = k > 0 && k < 100;
      const start = Number(x[2]);
      parsed.comments.push({
        chapter: c.chapter, verse_start: start, verse_end: Number(x[3] || x[2]),
        title: labelled ? rest.slice(0, k).trim() : null, letter: x[1],
        paragraphs: [(labelled ? rest.slice(k + 3) : rest).trim()].filter(Boolean), how: 'note',
      });
      letters.add(x[1]);
      const mk = (parsed.notes || []).find((n) => n.chapter === c.chapter && n.letter === x[1] && !n.matched);
      if (mk) mk.matched = true;
      rescued++;
    });
  }
  if (rescued && Array.isArray(parsed.warnings)) {
    parsed.warnings = parsed.warnings.filter((w) => {
      const mm = /La lettre « ([a-z]{1,4}) » du verset \d+ n'a pas de (?:commentaire|note) correspondant/.exec(w);
      return !(mm && letters.has(mm[1]));
    });
  }
  return rescued;
}

module.exports = { rescueGluedNotes };
