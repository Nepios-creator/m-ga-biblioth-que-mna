// Branche le module « Actualités chrétiennes » sur l'application Express existante.
//  1. API         : /api/actualites (public + administration)
//  2. Navigation  : ajoute le lien « Actualités » dans les pages existantes (sans modifier leurs fichiers)
//  3. Quotidien   : lance la recherche quotidienne d'actualités dans les sources officielles
//  4. EBK         : branche l'API /api/ebk (École Biblique Kainos) et ajoute l'onglet « EBK » dans les pages
//  5. Délais      : livres d'étude et sessions EBK à durée limitée, avec compte à rebours
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { ensureSchema } = require('./db');
const { escapeHtml } = require('./html-tools');
const buildRouter = require('./routes');
const { startScheduler } = require('./feeds');

const OWN_PAGES = new Set(['actualites.html', 'actualite.html', 'admin-actualites.html']);
const NO_INJECT = new Set(['ebk-verification.html']); // page autonome (ouverte par le code QR du certificat)
const NAV_SCRIPT = '<script src="/js/actualites-nav.js" defer></script>';
const EBK_SCRIPT = '<script src="/js/ebk-nav.js" defer></script>';
const DELAIS_SCRIPT = '<script src="/js/delais.js" defer></script>';

// Titre du ministère (en-tête de TOUTES les pages) : le sous-titre « Bibliothèque numérique » est défini
// dans style.css (header .brand::after). Il est remplacé ici, sans toucher à style.css, par la phrase
// animée « Partout avec vous ». « Ministère de la Nouvelle Alliance » reste tel quel.
const TAGLINE_STYLE = '<style id="mna-tagline">' +
  'html body header .brand::after{content:"Partout avec vous" !important;' +
  'background:linear-gradient(100deg,#a67f2e 0%,#e8c978 30%,#c9a24b 50%,#e8c978 70%,#a67f2e 100%);background-size:200% 100%;' +
  '-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;' +
  'animation:mnaFadeUp 1.1s ease both,mnaShimmer 3.2s ease-in-out 1.1s infinite alternate;}' +
  '@keyframes mnaFadeUp{from{opacity:0;transform:translateY(10px);letter-spacing:.18em}to{opacity:1;transform:none;letter-spacing:.01em}}' +
  '@keyframes mnaShimmer{from{background-position:0% 50%}to{background-position:100% 50%}}' +
  '@media (prefers-reduced-motion:reduce){html body header .brand::after{animation:none;background:none;-webkit-text-fill-color:#a67f2e;color:#a67f2e;}}' +
  '</style>';

// Accueil seulement : la phrase défile sans arrêt (elle sort à droite et revient par la gauche), avec un dégradé
// de couleurs qui coule et une lueur qui pulse. Les autres pages gardent la version simple ci-dessus.
const HOME_TAGLINE_STYLE = '<style id="mna-tagline-home">' +
  'html body header .brand{overflow:hidden;}' +
  'html body header .brand::after{content:"\\2726  Partout avec vous \\2726" !important;white-space:nowrap;font-size:.98em;font-weight:600;letter-spacing:.02em;padding:2px 0 4px;' +
  'background:linear-gradient(100deg,#b8860b 0%,#e8a317 22%,#e2703a 42%,#2f6fb0 62%,#e8a317 82%,#b8860b 100%);background-size:250% 100%;' +
  '-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;' +
  'animation:mnaLiveSlide 9s linear infinite,mnaLiveFlow 4.5s ease-in-out infinite alternate,mnaLiveGlow 3s ease-in-out infinite;}' +
  '@keyframes mnaLiveSlide{from{transform:translateX(calc(-50vw - 100%))}to{transform:translateX(calc(50vw + 100%))}}' +
  '@keyframes mnaLiveFlow{from{background-position:0% 50%}to{background-position:100% 50%}}' +
  '@keyframes mnaLiveGlow{0%,100%{filter:drop-shadow(0 0 0 rgba(232,163,23,0))}50%{filter:drop-shadow(0 2px 7px rgba(232,163,23,.55))}}' +
  '@media (prefers-reduced-motion:reduce){html body header .brand::after{animation:none;}}' +
  '</style>';

// Page d'accueil : titre de l'onglet, aperçu WhatsApp, phrase « Qui sommes-nous » et pied de page.
// Le fichier index.html reste intact.
function applyHome(html) {
  return html
    .replace('<meta property="og:title" content="Ministère de la Nouvelle Alliance — Bibliothèque numérique">',
             '<meta property="og:title" content="Ministère de la Nouvelle Alliance — Partout avec vous">')
    .replace('<title>Ministère de la Nouvelle Alliance — Bibliothèque numérique</title>',
             '<title>Ministère de la Nouvelle Alliance — Partout avec vous</title>')
    .replace('Cette bibliothèque numérique en est l\'une des expressions.',
             'Cette plateforme numérique en est l\'une des expressions.')
    .replace('<div>Grande Bibliothèque numérique MNA — © 2026</div>',
             '<div>La plateforme numérique MNA — © 2026</div>');
}

module.exports = function mountActualites(app, express, publicDir) {
  // Délais (compte à rebours) : si ce module échoue, le reste du site continue de fonctionner normalement
  try {
    require('../delais/mount')(app, express);
    console.log('[délais] module branché');
  } catch (err) {
    console.error('[délais] module non chargé :', err.message);
  }

  // École Biblique Kainos : si ce module échoue, le reste du site continue de fonctionner normalement
  try {
    app.use('/api/ebk', require('../routes/ebk'));
    console.log('[ebk] module branché');
  } catch (err) {
    console.error('[ebk] module non chargé :', err.message);
  }

  const ready = ensureSchema()
    .then(() => true)
    .catch((err) => { console.error('[actualités] base de données indisponible :', err.message); return false; });

  // Partage WhatsApp / Facebook : la page d'une actualité reçoit son titre, son résumé et son image dans l'en-tête
  app.get('/actualite.html', async (req, res, next) => {
    const id = parseInt(req.query.id, 10);
    if (!id) return next();
    try {
      const a = (await pool.query(
        `SELECT a.title, a.summary, a.cover_url,
                (SELECT i.id FROM actu_images i WHERE i.article_id = a.id AND i.is_cover ORDER BY i.id DESC LIMIT 1) AS cover_id
         FROM actu_articles a WHERE a.id = $1 AND a.status = 'publie'`, [id]
      )).rows[0];
      if (!a) return next();
      const html = await fs.promises.readFile(path.join(publicDir, 'actualite.html'), 'utf8');
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
      const origin = `${proto}://${req.get('host')}`;
      const image = a.cover_id ? `${origin}/api/actualites/images/${a.cover_id}` : (a.cover_url || '');
      const tags = [
        ['og:type', 'article'], ['og:title', a.title], ['og:description', a.summary || 'Actualités chrétiennes'],
        ['og:url', `${origin}/actualite.html?id=${id}`], ['og:site_name', 'Ministère de la Nouvelle Alliance'],
        ['twitter:card', image ? 'summary_large_image' : 'summary'],
      ];
      if (image) tags.push(['og:image', image]);
      const meta = tags.map(([k, v]) => `<meta property="${k}" content="${escapeHtml(v)}">`).join('\n');
      res.set('Cache-Control', 'no-cache').type('html').send(html.replace('</head>', meta + '\n</head>'));
    } catch (err) { next(); }
  });

  // Pages HTML existantes : on ajoute des lignes de script au moment de l'envoi (les fichiers restent intacts)
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const urlPath = req.path === '/' ? '/index.html' : req.path;
    if (!urlPath.endsWith('.html') || NO_INJECT.has(path.basename(urlPath))) return next();
    const file = path.normalize(path.join(publicDir, urlPath));
    if (!file.startsWith(publicDir + path.sep)) return next();
    const own = OWN_PAGES.has(path.basename(urlPath));
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      if (urlPath === '/index.html') html = applyHome(html);
      if (html.indexOf('id="mna-tagline"') === -1) html = html.replace('</head>', TAGLINE_STYLE + (urlPath === '/index.html' ? HOME_TAGLINE_STYLE : '') + '</head>');
      const add = [];
      if (!own && !html.includes('actualites-nav.js')) add.push(NAV_SCRIPT);
      if (!html.includes('ebk-nav.js')) add.push(EBK_SCRIPT);
      if (!html.includes('delais.js')) add.push(DELAIS_SCRIPT);
      if (add.length) {
        const i = html.toLowerCase().lastIndexOf('</body>');
        const tags = add.join('\n');
        html = i === -1 ? html + tags : html.slice(0, i) + tags + '\n' + html.slice(i);
      }
      res.set('Cache-Control', 'no-cache').type('html').send(html);
    });
  });

  app.use('/api/actualites', (req, res, next) => {
    ready.then((ok) => (ok ? next() : res.status(503).json({ message: 'Le module Actualités est momentanément indisponible.' })));
  });
  app.use('/api/actualites', buildRouter(express));

  ready.then((ok) => { if (ok) startScheduler(); });
  console.log('[actualités] module branché');
};
