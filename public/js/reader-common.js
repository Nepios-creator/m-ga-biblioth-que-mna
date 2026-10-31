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

  // ---------- Mise en page commune : titres, paragraphes courts, texte sans gras ----------

  // Marques d'emphase venues du texte d'origine (*italique*, **gras**). Les renvois de notes « (*) », « (**) »
  // et les séparateurs « * * * » ne sont pas touchés.
  const MARK_RE = /(^|[^(*\w])\*\*([^\s*)](?:[^*\n]*?[^\s*(])?)\*\*(?![*)])|(^|[^(*\w])\*([^\s*)](?:[^*\n]*?[^\s*(])?)\*(?![*)\w])/g;

  function parseInline(src) {
    let text = '';
    const fmt = [];
    const push = function (s, f) { for (let k = 0; k < s.length; k++) fmt.push(f); text += s; };
    let last = 0, m;
    MARK_RE.lastIndex = 0;
    while ((m = MARK_RE.exec(src))) {
      const isBold = m[2] !== undefined;
      const pre = isBold ? m[1] : m[3];
      const body = isBold ? m[2] : m[4];
      push(src.slice(last, m.index) + pre, 0);
      push(body, isBold ? 2 : 1);
      last = m.index + m[0].length;
    }
    push(src.slice(last), 0);
    // un paragraphe presque entièrement en gras n'est pas du gras voulu : le texte courant reste sans gras
    let b = 0;
    for (let k = 0; k < fmt.length; k++) if (fmt[k] & 2) b++;
    if (b && text.length > 80 && b >= text.length * 0.6) for (let k = 0; k < fmt.length; k++) fmt[k] &= ~2;
    return { text: text, fmt: fmt };
  }

  // Un paragraphe est un titre s'il commence par #, ## ou ###, ou s'il est court et entièrement entouré de ** **
  function paraInfo(raw) {
    const m = /^(#{1,3})\s+/.exec(raw);
    if (m) return { head: true, prefix: m[1].length, src: raw.slice(m[0].length) };
    const b = /^\*\*([^*\n]{1,140})\*\*$/.exec(raw.trim());
    if (b && !/[.!?;:,»”]$/.test(b[1].trim())) return { head: true, prefix: 3, src: b[1].trim() };
    return { head: false, src: raw };
  }

  // Niveau du titre : celui de son repère (#), précisé par sa numérotation (1 → 1.1 → 1.1.1) : plus c'est profond, plus c'est petit
  function headLevel(info, text) {
    let lvl = info.prefix;
    const m = /^\s*(\d{1,3}(?:\.\d{1,3})*)(?:[.)])?[\s\u00a0]/.exec(text);
    if (m) lvl = Math.max(lvl, m[1].split('.').length);
    return Math.min(4, lvl);
  }

  function isSeparator(raw) { return /^(?:\*\s*){3,}$/.test(raw.trim()) || /^[✦\s]+$/.test(raw); }

  // Coupe les très longs paragraphes en blocs plus courts, aux fins de phrases (affichage seulement : le texte n'est pas modifié)
  const LONG_MIN = 640, CHUNK_MIN = 260, CHUNK_MAX = 560;
  const ABBR = /^(?:[A-Za-zÀ-ÿ]{1,2}|Mme|Mlle|Mgr|ch|art|vv)$/;
  function splitLong(t) {
    if (t.length <= LONG_MIN) return [[0, t.length]];
    const bal = new Array(t.length + 1);
    let b = 0;
    for (let k = 0; k < t.length; k++) { bal[k] = b; if (t[k] === '«') b++; else if (t[k] === '»') b--; }
    bal[t.length] = b;
    const bounds = [];
    const re = /([.!?…])(["»”’)]*)(\s+)(?=["«“(A-ZÀ-ÖØ-Þ])/g;
    let m;
    while ((m = re.exec(t))) {
      const idx = m.index + m[0].length;
      if (m[1] === '.') {
        const tok = (t.slice(Math.max(0, m.index - 8), m.index).match(/(\S+)$/) || ['', ''])[1].replace(/^[^A-Za-zÀ-ÿ0-9]+/, '');
        if (ABBR.test(tok)) continue;
      }
      bounds.push({ i: idx, ok: bal[idx] <= 0 });
    }
    const segs = [];
    let start = 0;
    while (t.length - start > LONG_MIN) {
      let inOk = -1, inAny = -1, outOk = -1, outAny = -1;
      for (let k = 0; k < bounds.length; k++) {
        const bi = bounds[k].i;
        if (bi <= start + CHUNK_MIN) continue;
        if (bi > start + 1200) break;
        if (bi <= start + CHUNK_MAX) { inAny = bi; if (bounds[k].ok) inOk = bi; }
        else { if (outAny < 0) outAny = bi; if (bounds[k].ok && outOk < 0) outOk = bi; }
      }
      const pick = inOk > 0 ? inOk : (outOk > 0 ? outOk : (inAny > 0 ? inAny : outAny));
      if (pick < 0 || t.length - pick < 100) break;
      segs.push([start, pick]);
      start = pick;
    }
    segs.push([start, t.length]);
    return segs;
  }

  // HTML intérieur d'un paragraphe : astérisques retirés, italique, blocs courts, surlignages et commentaires
  function paraHtml(raw, annos) {
    if (isSeparator(raw)) return '✦ ✦ ✦';
    const info = paraInfo(raw);
    const pi = parseInline(info.src);
    const text = pi.text;
    const fmt = info.head ? null : pi.fmt;
    const marks = new Array(text.length).fill(null);
    (annos || []).forEach(function (a) {
      if (!a.quote_text || a.type === 'favorite') return;
      const idx = text.indexOf(a.quote_text);
      if (idx === -1) return;
      for (let k = idx; k < idx + a.quote_text.length; k++) {
        if (a.type === 'note' || !marks[k]) marks[k] = a.type === 'note' ? 'note' : 'hl';
      }
    });
    const run = function (s, e) {
      let html = '', k = s;
      while (k < e) {
        let j = k;
        const f = fmt ? fmt[k] : 0;
        while (j < e && marks[j] === marks[k] && (fmt ? fmt[j] : 0) === f) j++;
        let chunk = esc(text.slice(k, j));
        if (f & 1) chunk = '<em>' + chunk + '</em>';
        if (f & 2) chunk = '<strong>' + chunk + '</strong>';
        html += marks[k] ? '<mark class="' + marks[k] + '">' + chunk + '</mark>' : chunk;
        k = j;
      }
      return html;
    };
    const segs = info.head ? [[0, text.length]] : splitLong(text);
    if (segs.length === 1) return run(0, text.length);
    return segs.map(function (s) { return '<span class="mna-seg">' + run(s[0], s[1]) + '</span>'; }).join('');
  }

  // Les deux lecteurs recolorent les passages surlignés avec leur fonction « applyHighlights » : on la branche sur
  // la mise en page commune, pour que les paragraphes courts et le texte sans astérisques restent en place.
  function hookHighlights() {
    const orig = window.applyHighlights;
    if (typeof orig !== 'function' || orig.__mna) return;
    const wrapped = function () {
      try {
        const st = readerState;
        st.paragraphs.forEach(function (raw, i) {
          const el = document.getElementById('para-' + i);
          if (el) el.innerHTML = paraHtml(raw, st.annotations);
        });
      } catch (e) {
        return orig.apply(this, arguments);
      }
    };
    wrapped.__mna = true;
    window.applyHighlights = wrapped;
  }

  // Construit le HTML des paragraphes [start, end[ : titres, paragraphes, et la ligne "Lecture biblique"
  // placée juste après le(s) titre(s) qui ouvrent la partie. `hidden` = indices à ne pas afficher.
  function renderHtml(paras, start, end, hidden) {
    hookHighlights();
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
      const info = paraInfo(p);
      const attrs = ' id="para-' + i + '" data-i="' + i + '"';
      if (info.head) {
        const lvl = headLevel(info, parseInline(info.src).text);
        const tag = lvl === 1 ? 'h2' : (lvl === 2 ? 'h3' : 'h4');
        html += '<' + tag + ' class="mna-h mna-h' + lvl + '"' + attrs + '>' + paraHtml(p, null) + '</' + tag + '>';
      } else if (isSeparator(p)) {
        html += '<p class="mna-sep"' + attrs + '>' + paraHtml(p, null) + '</p>';
      } else {
        html += '<p' + attrs + '>' + paraHtml(p, null) + '</p>';
      }
    });
    if (lead >= vis.length) html += block;
    return html;
  }

  // Style identique dans tous les lecteurs : titres en gras (taille selon le niveau), texte courant sans gras
  const style = document.createElement('style');
  style.textContent =
    '.mna-bible-reading{font-size:0.72em;line-height:1.7;color:#7a5a10;margin:0 0 1.4em;}' +
    '.mna-bible-reading strong{color:#3a2f1f;}' +
    'html .ebook-text{font-family:"Source Serif 4",Georgia,"Times New Roman",serif;font-weight:400;line-height:1.7;}' +
    'html .ebook-text p{font-weight:400;font-style:normal;margin:0 0 1.1em;}' +
    'html .ebook-text .mna-seg{display:block;margin:0 0 1.1em;}' +
    'html .ebook-text .mna-seg:last-child{margin-bottom:0;}' +
    'html .ebook-text strong{font-weight:700;}' +
    'html .ebook-text em{font-style:italic;}' +
    'html .ebook-text .mna-sep{text-align:center;letter-spacing:.5em;color:#a67f2e;margin:1.6em 0;}' +
    'html .ebook-text .mna-h{font-family:"Fraunces",Georgia,serif;font-weight:700;font-style:normal;line-height:1.28;margin:1.5em 0 .55em;break-after:avoid;}' +
    'html .ebook-text .mna-h1{font-size:1.5em;margin-top:1.8em;}' +
    'html .ebook-text .mna-h2{font-size:1.28em;}' +
    'html .ebook-text .mna-h3{font-size:1.14em;}' +
    'html .ebook-text .mna-h4{font-size:1.04em;}' +
    'html .ebook-text .mna-h:first-child{margin-top:0;}';
  document.head.appendChild(style);
  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,700;1,8..60,400&display=swap';
  document.head.appendChild(font);

  window.MNAReader = { extractBibleRefs: extractBibleRefs, renderHtml: renderHtml, paraHtml: paraHtml };
})();
