// Lit une page web d'actualité et en extrait : titre, résumé, image, texte complet, auteur, date, source.
// Sans dépendance externe : analyse par expressions régulières, avec plusieurs méthodes de secours.
const { fetchText } = require('./fetch-page');
const { decodeEntities, escapeHtml, textFromHtml, truncate, parseAttrs, safeUrl, sanitizeHtml } = require('./html-tools');

const JUNK = /^(partager|share|tweet|tweeter|facebook|whatsapp|imprimer|print|lire aussi|read more|read also|related|suivez|follow us|subscribe|s['’]abonner|newsletter|publicité|advertisement|cookies?)\b/i;
const SOCIAL = /(^|\.)(facebook|instagram|twitter|x|tiktok|linkedin|threads)\.(com|net)$/i;

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function parseMeta(html) {
  const meta = {};
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = parseAttrs(m[1]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = decodeEntities(a.content).trim();
  }
  return meta;
}

function flattenLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, out)); return; }
  out.push(node);
  if (node['@graph']) flattenLd(node['@graph'], out);
}

function findArticleLd(html) {
  const nodes = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { flattenLd(JSON.parse(m[1].trim()), nodes); } catch (e) { /* bloc illisible : ignoré */ }
  }
  const isArticle = (n) => [].concat(n['@type'] || []).some((t) => /Article|BlogPosting|Report/i.test(String(t)));
  const articles = nodes.filter(isArticle);
  return articles.sort((a, b) => String(b.articleBody || '').length - String(a.articleBody || '').length)[0] || {};
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const ldImage = (img) => { const i = first(img); return !i ? '' : typeof i === 'string' ? i : (i.url || i.contentUrl || ''); };
const ldName = (a) => { const x = first(a); return !x ? '' : typeof x === 'string' ? x : (x.name || ''); };

function largestBlock(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let best = '';
  let bestLen = 0;
  let m;
  while ((m = re.exec(html))) {
    const len = textFromHtml(m[1]).length;
    if (len > bestLen) { best = m[1]; bestLen = len; }
  }
  return best;
}

function paragraphsHtml(text) {
  return decodeEntities(String(text || '')).split(/\r?\n+/).map((t) => t.trim()).filter((t) => t.length > 1)
    .map((t) => `<p>${escapeHtml(t)}</p>`).join('');
}

function cleanBody(raw, base, title) {
  let h = String(raw || '').replace(/<h1\b[\s\S]*?<\/h1>/gi, '');
  h = sanitizeHtml(h, base);
  h = h.replace(/<p>([\s\S]*?)<\/p>/gi, (m, inner) => {
    const t = textFromHtml(inner);
    if (t.length < 2 || (t.length < 60 && JUNK.test(t))) return '';
    return m;
  });
  const nt = norm(title);
  h = h.replace(/<h2>([\s\S]*?)<\/h2>/i, (m, inner) => (norm(textFromHtml(inner)) === nt ? '' : m));
  if (!/<p>/.test(h) && textFromHtml(h).length > 200) h = paragraphsHtml(textFromHtml(h));
  return h.slice(0, 150000).trim();
}

const toIso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

function cleanSourceUrl(u) {
  try {
    const url = new URL(u);
    [...url.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(k)) url.searchParams.delete(k); });
    url.hash = '';
    return url.href;
  } catch (e) { return u; }
}

async function extractFromUrl(rawUrl) {
  const { text: html, finalUrl } = await fetchText(rawUrl);
  const meta = parseMeta(html);
  const ld = findArticleLd(html);
  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  const notes = [];

  const h1 = (/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1];
  const titleTag = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  let title = textFromHtml(ld.headline || meta['og:title'] || meta['twitter:title'] || '');
  if (!title && h1) title = textFromHtml(h1);
  if (!title && titleTag) title = textFromHtml(titleTag).split(/\s[|–—-]\s/)[0];
  title = title.slice(0, 300);

  // Texte : <article> en priorité, puis <main>, puis la page entière
  let uncertain = false;
  let container = largestBlock(html, 'article');
  if (textFromHtml(container).length < 400) {
    const main = largestBlock(html, 'main');
    if (textFromHtml(main).length > textFromHtml(container).length) container = main;
  }
  if (textFromHtml(container).length < 400) {
    const b = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
    if (b) { container = b[1]; uncertain = true; }
  }
  let body = cleanBody(container, finalUrl, title);
  const ldBody = typeof ld.articleBody === 'string' ? ld.articleBody : '';
  if (ldBody.length > textFromHtml(body).length && (textFromHtml(body).length < 500 || uncertain)) {
    body = paragraphsHtml(ldBody);
    uncertain = false;
  }

  const description = meta['og:description'] || meta.description || meta['twitter:description'] || textFromHtml(ld.description || '');
  let partial = false;
  if (textFromHtml(body).length < 400) {
    partial = true;
    body = description ? `<p>${escapeHtml(description)}</p>` : '';
    notes.push('Le texte complet n\'a pas pu être lu automatiquement (site protégé ou réseau social). Complétez-le à la main.');
  } else if (uncertain) {
    notes.push('Mise en page inhabituelle : relisez bien le texte avant de publier.');
  }
  if (SOCIAL.test(host)) notes.push('Les réseaux sociaux limitent la lecture automatique : vérifiez le texte et ajoutez les images si besoin.');

  let cover = safeUrl(ldImage(ld.image) || meta['og:image'] || meta['twitter:image'] || '', finalUrl);
  if (!cover) {
    const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(body);
    if (img) cover = safeUrl(img[1], finalUrl);
  }

  const timeTag = (/<time\b[^>]*datetime=["']([^"']+)["']/i.exec(html) || [])[1];
  const publishedAt = toIso(ld.datePublished || meta['article:published_time'] || meta['og:published_time'] || meta.date || timeTag);
  const lang = ((/<html\b[^>]*\blang=["']?([a-zA-Z]{2})/i.exec(html) || [])[1] || (meta['og:locale'] || '').slice(0, 2) || '').toLowerCase();
  let author = textFromHtml(ldName(ld.author) || meta.author || '');
  if (/^https?:/i.test(author)) author = '';

  return {
    title,
    summary: truncate(textFromHtml(description) || textFromHtml(body), 300),
    body_html: body,
    cover_url: cover || null,
    source_name: (meta['og:site_name'] || ldName(ld.publisher) || host).slice(0, 120),
    source_url: cleanSourceUrl(finalUrl),
    author: author.slice(0, 120) || null,
    published_at: publishedAt,
    language: /^[a-z]{2}$/.test(lang) ? lang : 'fr',
    partial,
    uncertain,
    notes,
  };
}

module.exports = { extractFromUrl, parseMeta, findArticleLd, cleanBody, paragraphsHtml };
