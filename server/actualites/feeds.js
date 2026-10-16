// Sources officielles : lecture des flux RSS/Atom et proposition quotidienne d'actualités à l'administrateur.
const pool = require('../db/pool');
const { fetchText } = require('./fetch-page');
const { decodeEntities, textFromHtml, truncate, parseAttrs, safeUrl } = require('./html-tools');

const PER_SOURCE = 6;          // actualités proposées par source à chaque passage
const MAX_AGE_DAYS = 10;       // on ne propose pas d'articles plus anciens
const EXPIRE_AFTER_DAYS = 14;  // une proposition ignorée disparaît après ce délai

// ---------- Lecture d'un flux ----------

function tagContent(block, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  if (!m) return '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return cdata ? cdata[1] : decodeEntities(m[1]);
}

function firstImage(block, base) {
  const tries = [
    /<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*>/i,
    /<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i,
    /<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image[^"']*["']/i,
    /<enclosure\b[^>]*\btype=["']image[^"']*["'][^>]*\burl=["']([^"']+)["']/i,
  ];
  for (const re of tries) {
    const m = re.exec(block);
    if (m) { const u = safeUrl(m[1], base); if (u) return u; }
  }
  const html = tagContent(block, 'content:encoded') || tagContent(block, 'description') || tagContent(block, 'content') || tagContent(block, 'summary');
  const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
  return img ? safeUrl(img[1], base) || null : null;
}

function parseFeed(xml, base) {
  const items = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const title = textFromHtml(tagContent(b, 'title'));
    let link = textFromHtml(tagContent(b, 'link'));
    if (!/^https?:/i.test(link)) {
      const links = [...b.matchAll(/<link\b([^>]*)\/?>/gi)].map((x) => parseAttrs(x[1]));
      const alt = links.find((a) => a.href && (!a.rel || a.rel === 'alternate')) || links.find((a) => a.href);
      link = alt ? alt.href : '';
    }
    if (!/^https?:/i.test(link)) { const g = textFromHtml(tagContent(b, 'guid')); if (/^https?:/i.test(g)) link = g; }
    link = safeUrl(link, base);
    if (!title || !link) continue;
    const desc = tagContent(b, 'description') || tagContent(b, 'summary') || tagContent(b, 'content:encoded') || tagContent(b, 'content');
    const dateRaw = tagContent(b, 'pubDate') || tagContent(b, 'published') || tagContent(b, 'updated') || tagContent(b, 'dc:date');
    const d = dateRaw ? new Date(textFromHtml(dateRaw)) : null;
    items.push({
      title: title.slice(0, 300),
      link,
      summary: truncate(textFromHtml(desc), 320),
      image: firstImage(b, link),
      published_at: d && !isNaN(d.getTime()) ? d.toISOString() : null,
    });
  }
  return items;
}

// Trouve l'adresse du flux RSS d'un site (balise « alternate » de la page d'accueil, ou adresses usuelles)
async function discoverFeed(siteUrl) {
  const candidates = [];
  try {
    const { text, finalUrl } = await fetchText(siteUrl);
    const re = /<link\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(text))) {
      const a = parseAttrs(m[1]);
      if (/alternate/i.test(a.rel || '') && /(rss|atom)\+xml/i.test(a.type || '') && a.href) candidates.push(safeUrl(a.href, finalUrl));
    }
    const origin = new URL(finalUrl).origin;
    ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'].forEach((p) => candidates.push(origin + p));
  } catch (e) {
    const origin = new URL(siteUrl).origin;
    ['/feed', '/rss', '/rss.xml', '/feed.xml'].forEach((p) => candidates.push(origin + p));
  }
  for (const url of [...new Set(candidates.filter(Boolean))].slice(0, 8)) {
    try {
      const { text } = await fetchText(url, { maxBytes: 2.5 * 1024 * 1024, accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5' });
      if (parseFeed(text, url).length) return url;
    } catch (e) { /* adresse suivante */ }
  }
  return null;
}

async function loadSource(source) {
  let feedUrl = source.feed_url;
  if (!feedUrl) {
    feedUrl = await discoverFeed(source.site_url);
    if (!feedUrl) throw new Error('Aucun flux RSS trouvé sur ce site : indiquez son adresse dans les sources');
  }
  const { text } = await fetchText(feedUrl, { maxBytes: 2.5 * 1024 * 1024, accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5' });
  const items = parseFeed(text, feedUrl);
  if (!items.length) throw new Error('Le flux ne contient aucune actualité');
  return { feedUrl, items };
}

// ---------- Classement automatique ----------

function guessCategory(text, fallback) {
  const t = String(text || '').toLowerCase();
  if (/persécut|persecut|martyr|christian(s)? (killed|attacked)|church (attack|burn)|liberté religieuse|religious freedom|blasphem/.test(t)) return 'persecution';
  if (/humanitair|humanitarian|famine|refugee|réfugi|aid |aide d'urgence|charity|solidarit|flood|inondation|earthquake|séisme/.test(t)) return 'solidarite';
  if (/mission|évangélis|evangelis|church plant|implantation d'église|crusade|croisade/.test(t)) return 'mission';
  if (/jeunes|youth|famille|family|children|enfants|marriage|mariage/.test(t)) return 'jeunesse';
  if (/conférence|conference|assemblée|assembly|synode|synod|congress|congrès|rassemblement|festival|retreat|retraite/.test(t)) return 'evenement';
  return fallback || 'eglise';
}

// ---------- Passage quotidien ----------

let running = false;

async function setMeta(key, value) {
  await pool.query('INSERT INTO news_meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
}
async function getMeta(key) {
  const r = await pool.query('SELECT value FROM news_meta WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function runDailyFetch() {
  if (running) return { running: true, added: 0, results: [] };
  running = true;
  const results = [];
  let added = 0;
  try {
    await pool.query(
      "UPDATE news_suggestions SET status = 'expiree' WHERE status = 'nouvelle' AND created_at < now() - ($1 || ' days')::interval",
      [String(EXPIRE_AFTER_DAYS)]
    );
    const sources = (await pool.query('SELECT * FROM news_sources WHERE enabled ORDER BY id')).rows;
    const oldest = Date.now() - MAX_AGE_DAYS * 86400000;

    for (const s of sources) {
      try {
        const { feedUrl, items } = await loadSource(s);
        let n = 0;
        for (const it of items) {
          if (n >= PER_SOURCE) break;
          if (it.published_at && new Date(it.published_at).getTime() < oldest) continue;
          const done = await pool.query('SELECT 1 FROM news_articles WHERE source_url = $1', [it.link]);
          if (done.rows.length) continue;
          const ins = await pool.query(
            `INSERT INTO news_suggestions (source_id, source_name, title, summary, link, image_url, published_at, language, region, category)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (link) DO NOTHING RETURNING id`,
            [s.id, s.name, it.title, it.summary, it.link, it.image, it.published_at, s.language, s.region, guessCategory(it.title + ' ' + it.summary, s.category)]
          );
          if (ins.rows.length) { n++; added++; }
        }
        await pool.query("UPDATE news_sources SET feed_url = $2, last_checked_at = now(), last_status = 'ok', last_error = NULL WHERE id = $1", [s.id, feedUrl]);
        results.push({ source: s.name, ok: true, added: n });
      } catch (err) {
        await pool.query("UPDATE news_sources SET last_checked_at = now(), last_status = 'erreur', last_error = $2 WHERE id = $1", [s.id, String(err.message).slice(0, 300)]);
        results.push({ source: s.name, ok: false, error: err.message });
      }
    }
    await setMeta('last_fetch_date', new Date().toISOString().slice(0, 10));
    await setMeta('last_fetch_at', new Date().toISOString());
    return { added, results };
  } finally {
    running = false;
  }
}

// Une fois par jour : au démarrage du serveur (ou à son réveil) puis toutes les 30 minutes si le passage du jour n'a pas eu lieu.
function startScheduler() {
  const check = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if ((await getMeta('last_fetch_date')) !== today) {
        const r = await runDailyFetch();
        console.log(`[actualités] passage quotidien : ${r.added} nouvelle(s) proposition(s)`);
      }
    } catch (err) {
      console.error('[actualités] passage quotidien en échec :', err.message);
    }
  };
  setTimeout(check, 45 * 1000);
  setInterval(check, 30 * 60 * 1000);
}

module.exports = { parseFeed, discoverFeed, runDailyFetch, startScheduler, getMeta, guessCategory };
