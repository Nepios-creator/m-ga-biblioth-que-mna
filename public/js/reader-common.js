/* Code commun aux deux lecteurs (catalogue et espace d'étude) :
   - repère automatiquement les passages bibliques cités dans chaque partie
   - les affiche toujours de la même façon, en début de partie ("Lecture biblique : ...")
   - rend les titres et paragraphes de la même manière partout
   Il s'applique à tous les livres, y compris ceux qui seront ajoutés plus tard. */
(function () {
  const BIBLE_BOOKS = [
    ['Genèse', ['Genèse', 'Genese', 'Gen', 'Gn']],
    ['Exode', ['Exode', 'Exo', 'Ex']],
    ['Lévitique', ['Lévitique', 'Levitique', 'Lév', 'Lev', 'Lv']],
    ['Nombres', ['Nombres', 'Nomb', 'Nb']],
    ['Deutéronome', ['Deutéronome', 'Deuteronome', 'Deut', 'Dt']],
    ['Josué', ['Josué', 'Josue', 'Jos']],
    ['Juges', ['Juges', 'Jug', 'Jg']],
    ['Ruth', ['Ruth']],
    ['1 Samuel', ['1 Samuel', '1 Sam']],
    ['2 Samuel', ['2 Samuel', '2 Sam']],
    ['1 Rois', ['1 Rois']],
    ['2 Rois', ['2 Rois']],
    ['1 Chroniques', ['1 Chroniques', '1 Chron']],
    ['2 Chroniques', ['2 Chroniques', '2 Chron']],
    ['Esdras', ['Esdras', 'Esd']],
    ['Néhémie', ['Néhémie', 'Nehemie', 'Néh', 'Neh']],
    ['Esther', ['Esther', 'Esth']],
    ['Job', ['Job']],
    ['Psaumes', ['Psaumes', 'Psaume', 'Ps']],
    ['Proverbes', ['Proverbes', 'Prov', 'Pr']],
    ['Ecclésiaste', ['Ecclésiaste', 'Ecclesiaste', 'Eccl', 'Ecc']],
    ['Cantique des Cantiques', ['Cantique des Cantiques', 'Cant']],
    ['Ésaïe', ['Ésaïe', 'Esaïe', 'Ésaie', 'Esaie', 'Isaïe', 'Isaie', 'Es', 'Is']],
    ['Jérémie', ['Jérémie', 'Jeremie', 'Jér', 'Jer']],
    ['Lamentations', ['Lamentations', 'Lam']],
    ['Ézéchiel', ['Ézéchiel', 'Ezéchiel', 'Ezechiel', 'Éz', 'Ez']],
    ['Daniel', ['Daniel', 'Dan']],
    ['Osée', ['Osée', 'Osee', 'Os']],
    ['Joël', ['Joël', 'Joel']],
    ['Amos', ['Amos']],
    ['Abdias', ['Abdias', 'Abd']],
    ['Jonas', ['Jonas', 'Jon']],
    ['Michée', ['Michée', 'Michee', 'Mich', 'Mic']],
    ['Nahum', ['Nahum', 'Nah']],
    ['Habakuk', ['Habakuk', 'Habacuc', 'Hab']],
    ['Sophonie', ['Sophonie', 'Soph']],
    ['Aggée', ['Aggée', 'Aggee', 'Agg']],
    ['Zacharie', ['Zacharie', 'Zach', 'Zac']],
    ['Malachie', ['Malachie', 'Mal']],
    ['Matthieu', ['Matthieu', 'Matt', 'Mt']],
    ['Marc', ['Marc', 'Mc']],
    ['Luc', ['Luc', 'Lc']],
    ['Jean', ['Jean', 'Jn']],
    ['Actes', ['Actes', 'Act']],
    ['Romains', ['Romains', 'Rom', 'Rm']],
    ['1 Corinthiens', ['1 Corinthiens', '1 Cor']],
    ['2 Corinthiens', ['2 Corinthiens', '2 Cor']],
    ['Galates', ['Galates', 'Gal']],
    ['Éphésiens', ['Éphésiens', 'Ephésiens', 'Ephesiens', 'Éph', 'Eph']],
    ['Philippiens', ['Philippiens', 'Phil', 'Php']],
    ['Colossiens', ['Colossiens', 'Col']],
    ['1 Thessaloniciens', ['1 Thessaloniciens', '1 Thess']],
    ['2 Thessaloniciens', ['2 Thessaloniciens', '2 Thess']],
    ['1 Timothée', ['1 Timothée', '1 Timothee', '1 Tim']],
    ['2 Timothée', ['2 Timothée', '2 Timothee', '2 Tim']],
    ['Tite', ['Tite', 'Tit']],
    ['Philémon', ['Philémon', 'Philemon', 'Philém', 'Philem']],
    ['Hébreux', ['Hébreux', 'Hebreux', 'Héb', 'Heb']],
    ['Jacques', ['Jacques', 'Jac']],
    ['1 Pierre', ['1 Pierre', '1 Pi']],
    ['2 Pierre', ['2 Pierre', '2 Pi']],
    ['1 Jean', ['1 Jean', '1 Jn']],
    ['2 Jean', ['2 Jean', '2 Jn']],
    ['3 Jean', ['3 Jean', '3 Jn']],
    ['Jude', ['Jude']],
    ['Apocalypse', ['Apocalypse', 'Apoc', 'Ap']],
  ];

  const BIBLE_CANON = {};
  const BIBLE_RE = (function () {
    const forms = [];
    BIBLE_BOOKS.forEach(function (b) {
      b[1].forEach(function (f) {
        forms.push(f);
        BIBLE_CANON[f.toLowerCase().replace(/[\s.]/g, '')] = b[0];
      });
    });
    forms.sort(function (a, b) { return b.length - a.length; });
    const toRe = function (f) { return f.replace(/^([123]) /, '$1\\s?').replace(/ /g, '\\s+'); };
    const books = forms.map(toRe).join('|');
    const NUM = '\\d{1,3}';
    const first = NUM + '\\s*[.:]\\s*' + NUM + '(?:\\s*[-–]\\s*' + NUM + ')?';
    // suite d'une référence : ", 9-12" ou "; 7.17" (jamais le numéro d'un livre comme "; 1 Corinthiens")
    const cont = '\\s*[,;]\\s*' + NUM + '(?:\\s*[.:]\\s*' + NUM + ')?(?:\\s*[-–]\\s*' + NUM + ')?(?!\\d|\\s*[A-Za-zÀ-ÿ\\d])';
    return new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + books + ')\\.?\\s*(' + first + '(?:' + cont + ')*)', 'gi');
  })();

  function cleanChain(c) {
    return c.replace(/\s+/g, ' ').replace(/\s*:\s*/g, '.').replace(/\s*\.\s*/g, '.').replace(/\s*[-–]\s*/g, '-').replace(/\s*([,;])\s*/g, '$1 ').trim();
  }

  // Retourne "Genèse 1.1-2, 9-12; Exode 3.8; ..." pour une liste de paragraphes (ou '' s'il n'y en a pas)
  function extractBibleRefs(paragraphs) {
    const text = paragraphs.map(function (p) { return p.replace(/^#{1,3}\s+/, ''); }).join('\u0001');
    const byBook = new Map();
    const matches = text.matchAll(BIBLE_RE);
    for (const m of matches) {
      const name = BIBLE_CANON[m[2].toLowerCase().replace(/[\s.]/g, '')];
      if (!name) continue;
      const chain = cleanChain(m[3]);
      if (!byBook.has(name)) byBook.set(name, []);
      const arr = byBook.get(name);
      if (arr.indexOf(chain) === -1) arr.push(chain);
    }
    return Array.from(byBook.entries()).map(function (e) { return e[0] + ' ' + e[1].join('; '); }).join('; ');
  }

  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // Construit le HTML des paragraphes [start, end[ : titres, paragraphes, et la ligne "Lecture biblique"
  // placée juste après le(s) titre(s) qui ouvrent la partie. `hidden` = indices à ne pas afficher.
  function renderHtml(paras, start, end, hidden) {
    const vis = [];
    for (let i = start; i < end; i++) if (!hidden || !hidden.has(i)) vis.push(i);

    const refs = extractBibleRefs(vis.map(function (i) { return paras[i]; }));
    const block = refs ? '<div class="mna-bible-reading"><strong>Lecture biblique :</strong> ' + esc(refs) + '</div>' : '';

    let lead = 0;
    while (lead < vis.length && lead < 2 && /^#{1,2} /.test(paras[vis[lead]])) lead++;

    let html = '';
    vis.forEach(function (i, pos) {
      if (pos === lead) html += block;
      const p = paras[i];
      if (refs && /^Lecture biblique\s*:/i.test(p)) return; // déjà repris dans le bloc ci-dessus
      if (p.indexOf('### ') === 0) html += '<h4 id="para-' + i + '" data-i="' + i + '">' + esc(p.slice(4)) + '</h4>';
      else if (p.indexOf('## ') === 0) html += '<h3 id="para-' + i + '" data-i="' + i + '">' + esc(p.slice(3)) + '</h3>';
      else if (p.indexOf('# ') === 0) html += '<h2 id="para-' + i + '" data-i="' + i + '">' + esc(p.slice(2)) + '</h2>';
      else html += '<p id="para-' + i + '" data-i="' + i + '">' + esc(p) + '</p>';
    });
    if (lead >= vis.length) html += block;
    return html;
  }

  // Style identique dans tous les lecteurs
  const style = document.createElement('style');
  style.textContent =
    '.mna-bible-reading{font-size:0.72em;line-height:1.7;color:#7a5a10;margin:0 0 1.4em;}' +
    '.mna-bible-reading strong{color:#3a2f1f;}' +
    '.ebook-text h4{font-size:1em;font-weight:700;margin:1.1em 0 0.5em;color:#3a2f1f;}';
  document.head.appendChild(style);

  window.MNAReader = { extractBibleRefs: extractBibleRefs, renderHtml: renderHtml };
})();
