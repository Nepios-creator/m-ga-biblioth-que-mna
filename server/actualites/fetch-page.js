// Téléchargement sécurisé de pages web, de flux RSS et d'images.
// Protège le serveur : refuse les adresses internes, limite la taille et la durée.
const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (compatible; MNA-Actualites/1.0; +https://mega-bibliotheque-mna.onrender.com)';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { throw new Error('Adresse invalide : collez un lien complet commençant par https://'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Adresse invalide : seuls les liens http et https sont acceptés');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Adresse non autorisée');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Adresse non autorisée');
    return url;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw new Error('Site introuvable : vérifiez le lien'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Adresse non autorisée');
  return url;
}

// Télécharge une adresse (redirections suivies et revérifiées). Retourne { buffer, contentType, finalUrl }.
async function fetchLimited(rawUrl, opts = {}) {
  const { maxBytes = 3 * 1024 * 1024, timeoutMs = 15000, accept } = opts;
  let target = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(target);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetch(u.href, {
          redirect: 'manual',
          signal: ctrl.signal,
          headers: {
            'User-Agent': UA,
            Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr,en;q=0.8',
          },
        });
      } catch (e) {
        throw new Error(e.name === 'AbortError' ? 'Le site met trop de temps à répondre' : 'Impossible de joindre ce site');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Redirection invalide');
        target = new URL(loc, u.href).href;
        continue;
      }
      if (!res.ok) throw new Error(`Le site a refusé la demande (code ${res.status})`);
      const chunks = [];
      let size = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { ctrl.abort(); throw new Error('Contenu trop volumineux'); }
        chunks.push(Buffer.from(value));
      }
      return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '', finalUrl: u.href };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Trop de redirections');
}

function decodeBuffer(buf, contentType) {
  let cs = (/charset=["']?([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 3000).toString('latin1')) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch (e) { return buf.toString('utf8'); }
}

async function fetchText(url, opts) {
  const r = await fetchLimited(url, opts);
  return { text: decodeBuffer(r.buffer, r.contentType), finalUrl: r.finalUrl, contentType: r.contentType };
}

// Télécharge une image (png, jpeg, webp, gif — pas de SVG). Retourne { buffer, mime }.
async function fetchImage(url) {
  const r = await fetchLimited(url, { maxBytes: 6 * 1024 * 1024, accept: 'image/*', timeoutMs: 15000 });
  let mime = r.contentType.split(';')[0].trim().toLowerCase();
  const b = r.buffer;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
    // type absent ou générique : on le déduit du contenu
    if (b[0] === 0xff && b[1] === 0xd8) mime = 'image/jpeg';
    else if (b.subarray(1, 4).toString() === 'PNG') mime = 'image/png';
    else if (b.subarray(0, 3).toString() === 'GIF') mime = 'image/gif';
    else if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
    else throw new Error('Format d\'image non pris en charge');
  }
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return { buffer: b, mime };
}

module.exports = { assertPublicUrl, fetchLimited, fetchText, fetchImage, UA };
