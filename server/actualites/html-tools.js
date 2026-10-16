// Outils HTML sans dépendance : décodage des entités, nettoyage du contenu publié, extraction de texte.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', laquo: '«', raquo: '»', copy: '©', euro: '€', deg: '°', oelig: 'œ', OElig: 'Œ',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ograve: 'ò', oacute: 'ó', ocirc: 'ô', ouml: 'ö',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', ntilde: 'ñ', szlig: 'ß',
  Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ugrave: 'Ù', Ucirc: 'Û',
};

function decodeEntities(str) {
  return String(str == null ? '' : str).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; } catch (err) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Texte brut d'un fragment HTML
function textFromHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function truncate(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[ ,;:.\-–—]+$/, '') + '…';
}

// Attributs d'une balise : { nom: valeur } (noms en minuscules)
function parseAttrs(str) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str || ''))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return out;
}

// Adresse sûre (http, https, mailto, tel ou image interne). Retourne '' si refusée.
function safeUrl(raw, base) {
  let u = decodeEntities(String(raw || '')).trim();
  if (!u) return '';
  if (u.startsWith('/api/actualites/images/')) return u;
  try {
    if (u.startsWith('//')) u = 'https:' + u;
    const url = base ? new URL(u, base) : new URL(u);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return '';
    return url.href;
  } catch (e) { return ''; }
}

const ALLOWED = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'a', 'blockquote', 'br', 'img', 'figure', 'figcaption', 'hr']);
const VOID = new Set(['br', 'img', 'hr']);
const DROP = /<(script|style|iframe|noscript|svg|form|object|embed|template|head|header|nav|footer|aside|button|select|textarea)\b[\s\S]*?<\/\1\s*>/gi;

// Nettoie un HTML venant d'un site ou de l'éditeur : ne garde que des balises de mise en forme sûres.
function sanitizeHtml(html, base) {
  let s = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(DROP, '');
  const out = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  const esc = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    out.push(esc(s.slice(last, m.index)));
    last = re.lastIndex;
    let tag = m[2].toLowerCase();
    if (tag === 'h1') tag = 'h2';
    if (tag === 'h5' || tag === 'h6') tag = 'h4';
    if (!ALLOWED.has(tag)) continue;

    if (m[1]) {
      if (VOID.has(tag)) continue;
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out.push(`</${stack.pop()}>`);
      continue;
    }

    const a = parseAttrs(m[3]);
    if (tag === 'a') {
      const href = safeUrl(a.href, base);
      if (!href) continue; // lien sans adresse valide : on garde seulement le texte
      out.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">`);
      stack.push('a');
    } else if (tag === 'img') {
      const candidates = [a['data-src'], a['data-lazy-src'], a['data-original'], a.src].filter((x) => x && !/^data:/i.test(x));
      const src = safeUrl(candidates[0], base);
      if (!src || !/^https?:|^\/api\/actualites\/images\//i.test(src)) continue;
      out.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(decodeEntities(a.alt || ''))}" loading="lazy">`);
    } else if (VOID.has(tag)) {
      out.push(`<${tag}>`);
    } else {
      out.push(`<${tag}>`);
      stack.push(tag);
    }
  }
  out.push(esc(s.slice(last)));
  while (stack.length) out.push(`</${stack.pop()}>`);

  return out.join('')
    .replace(/<(p|li|strong|b|em|i|u|blockquote|h[2-4])>\s*(?:&nbsp;|<br>)*\s*<\/\1>/gi, '')
    .replace(/(<br>\s*){3,}/gi, '<br><br>')
    .trim();
}

module.exports = { decodeEntities, escapeHtml, textFromHtml, truncate, parseAttrs, safeUrl, sanitizeHtml };
