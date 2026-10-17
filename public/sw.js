// Service worker : l'application s'ouvre et se parcourt sans connexion internet.
//  - les pages et fichiers de l'application sont gardés sur le téléphone ;
//  - la Bible (texte public) est gardée sur le téléphone, chapitre par chapitre ;
//  - les listes consultées (catalogue, actualités…) restent consultables hors connexion ;
//  - le texte des livres, les paiements, l'administration et les connexions ne sont JAMAIS gardés ;
//  - les fichiers audio (lecture en continu, écran éteint) sont laissés au navigateur : jamais interceptés.
const CACHE = 'mna-biblio-v4';   // pages et fichiers de l'application
const PUBLIC = 'mna-bible-v1';   // Bible et actualités (contenu public)
const PRIVATE = 'mna-api-v1';    // autres listes, propres à chaque compte (effacées à la déconnexion)
const KEEP = [CACHE, PUBLIC, PRIVATE];

const PRECACHE = [
  '/', '/a-propos.html', '/catalogue.html', '/espace-etude.html', '/assistant.html', '/bible.html',
  '/actualites.html', '/actualite.html', '/login.html', '/lecture.html', '/offline.html', '/audio.html',
  '/css/style.css', '/css/actualites.css', '/css/mobile.css',
  '/js/pwa.js', '/js/mobile-app.js', '/js/fullscreen.js', '/js/reader-tools.js', '/js/offline.js',
  '/js/site-extras.js', '/js/home.js', '/js/home-contact.js', '/js/actualites-nav.js', '/js/reader-common.js',
  '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'
];

// Jamais gardés : connexions, administration (y compris celle des livres audio), paiements, lecteur de livres,
// et les liens d'écoute audio (temporaires : un lien gardé serait périmé)
const DENY_API = /^\/api\/(auth|admin|payments?|reader)(\/|$)|^\/api\/audio\/(admin(\/|$)|tracks\/)|read-link/i;
const PUBLIC_API = /^\/api\/(bible\/books(\/|$)|actualit)/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => KEEP.indexOf(k) === -1).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// À la déconnexion, les pages demandent d'effacer les données privées gardées pour le hors-connexion
self.addEventListener('message', (event) => {
  if (event.data === 'mna-clear-private') event.waitUntil(caches.delete(PRIVATE));
});

function fetchTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function jsonResponse(body, status) {
  return new Response(body, { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// Pages et fichiers : réseau d'abord (toujours à jour), sinon la copie gardée sur le téléphone
async function pageStrategy(req, url) {
  const cache = await caches.open(CACHE);
  let cached = await cache.match(req);
  if (!cached) cached = await cache.match(req, { ignoreSearch: true });
  if (!cached && url.pathname === '/index.html') cached = await cache.match('/');
  try {
    const res = await fetchTimeout(req, cached ? 6000 : 25000);
    if (res && res.ok && res.type === 'basic') { const copy = res.clone(); cache.put(req, copy).catch(() => {}); }
    return res;
  } catch (e) {
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const off = await cache.match('/offline.html');
      if (off) return off;
    }
    return Response.error();
  }
}

// Données : réseau d'abord, sinon la dernière copie. La Bible garde chaque chapitre déjà ouvert ou téléchargé.
async function apiStrategy(req, url) {
  const p = url.pathname;
  if (DENY_API.test(p) || /[?&]token=/.test(url.search)) return fetch(req);
  const isPublic = PUBLIC_API.test(p);
  const cache = await caches.open(isPublic ? PUBLIC : PRIVATE);
  const key = isPublic
    ? new Request(url.origin + p + url.search)
    : new Request(url.href + (url.search ? '&' : '?') + '__u=' + hash(req.headers.get('Authorization') || ''));
  const had = await cache.match(key);
  try {
    const res = await fetchTimeout(req, had ? 7000 : 25000);
    if (res && res.ok) { const copy = res.clone(); cache.put(key, copy).catch(() => {}); }
    return res;
  } catch (e) {
    if (had) return had;
    // Favoris, notes et surlignages de la Bible : listes vides hors connexion, la lecture continue
    if (/^\/api\/bible\/marks/i.test(p)) return jsonResponse('[]');
    return jsonResponse(JSON.stringify({ message: 'Vous êtes hors connexion.' }), 503);
  }
}

// Polices (Google Fonts) : gardées après le premier chargement
async function fontStrategy(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); cache.put(req, copy).catch(() => {}); }
    return res;
  } catch (e) { return Response.error(); }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Lecture audio/vidéo (demandes par morceaux, « Range ») : laissée au navigateur, sinon la lecture
  // en continu — surtout écran éteint — serait cassée
  if (req.method !== 'GET' || req.headers.has('range') || req.destination === 'audio' || req.destination === 'video') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) event.respondWith(fontStrategy(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) event.respondWith(apiStrategy(req, url));
  else event.respondWith(pageStrategy(req, url));
});
