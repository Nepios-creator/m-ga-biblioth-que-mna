// Branche le module « Actualités chrétiennes » sur l'application Express existante.
//  1. API         : /api/actualites (public + administration)
//  2. Navigation  : ajoute le lien « Actualités » dans les pages existantes (sans modifier leurs fichiers)
//  3. Quotidien   : lance la recherche quotidienne d'actualités dans les sources officielles
//  4. EBK         : branche l'API /api/ebk (École Biblique Kainos) et ajoute l'onglet « EBK » dans les pages
//  5. Délais      : livres d'étude et sessions EBK à durée limitée, avec compte à rebours
//  6. Brevets     : brevets envoyés à l'administration, classés par livre étudié
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
const BREVETS_SCRIPT = '<script src="/js/brevets.js" defer></script>';
const BREVETS_PAGES = new Set(['espace-etude.html', 'ebk.html', 'admin.html']); // seules pages où le script des brevets est ajouté

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

// Accueil seulement : la phrase animée est retirée (l'emplacement reste vide) et le nom du site
// « mna-world.org » s'écrit très discrètement sous « Se familiariser avec les enseignements… ».
// Il est écrit en CSS (::after) : le script de l'accueil, qui réécrit ce texte, ne peut pas l'effacer.
const HOME_TAGLINE_STYLE = '<style id="mna-tagline-home">' +
  'html body header .brand::after{content:none !important;display:none !important;}' +
  'html body .hero > p:first-of-type::after{content:"mna-world.org";display:block;margin:8px auto 0;' +
  'font:500 11px/1.2 Inter,system-ui,sans-serif;font-style:normal;letter-spacing:.14em;text-transform:none;' +
  'color:var(--ink-soft,#6b5f4d);opacity:.55;}' +
  '</style>';

// Page EBK : le titre « École Biblique Kainos » restait noir sur le fond bleu nuit en mode jour.
// Il est maintenant clair dans les deux modes ; en mode nuit, les titres et textes posés directement
// sur le fond sombre (programme, sessions, pied de page) deviennent clairs aussi.
const EBK_FIX_STYLE = '<style id="mna-ebk-fix">' +
  'html body .k-hero h1{color:#fbf3e3 !important;}' +
  'html body .k-hero h1 span{color:#d9b45a !important;}' +
  'html.mna-dark .k-sec h2,html.mna-dark .k-prog b{color:#f1e7cf !important;}' +
  'html.mna-dark .k-sec h2 + .k-lead,html.mna-dark .k-prog small,html.mna-dark .k-foot,html.mna-dark .k-contact{color:#c9bda4 !important;}' +
  'html.mna-dark .k-prog li{border-bottom-color:#372f24;}' +
  'html.mna-dark .k-prog li::before{background:#1f3a5f;}' +
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

// Page « À propos » : « Grande Bibliothèque numérique », « Bibliothèque numérique » et « cette bibliothèque »
// deviennent « plateforme numérique MNA » / « cette plateforme ». Le fichier a-propos.html reste intact.
const ABOUT_SWAPS = [
  ['<h2>La Bibliothèque numérique</h2>', '<h2>La plateforme numérique MNA</h2>'],
  ['La Bibliothèque numérique du Ministère de la Nouvelle Alliance est née de cette vision.', 'La plateforme numérique MNA est née de cette vision.'],
  ['Cette bibliothèque veut être plus qu\'un simple espace de téléchargement', 'Cette plateforme veut être plus qu\'un simple espace de téléchargement'],
  ['met cette bibliothèque à votre disposition.', 'met cette plateforme à votre disposition.'],
  ['<h2>Bienvenue dans la Bibliothèque numérique du MNA</h2>', '<h2>Bienvenue sur la plateforme numérique MNA</h2>'],
  ['<div>Grande Bibliothèque numérique MNA — © 2026</div>', '<div>La plateforme numérique MNA — © 2026</div>']
];
function applyAbout(html) {
  ABOUT_SWAPS.forEach(([from, to]) => { html = html.split(from).join(to); });
  return html;
}

module.exports = function mountActualites(app, express, publicDir) {
  // Délais (compte à rebours) : si ce module échoue, le reste du site continue de fonctionner normalement
  try {
    require('../delais/mount')(app, express);
    console.log('[délais] module branché');
  } catch (err) {
    console.error('[délais] module non chargé :', err.message);
  }

  // Brevets envoyés à l'administration : si ce module échoue, le reste du site continue de fonctionner normalement
  try {
    require('../brevets/mount')(app, express);
    console.log('[brevets] module branché');
  } catch (err) {
    console.error('[brevets] module non chargé :', err.message);
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
      if (urlPath === '/a-propos.html') html = applyAbout(html);
      if (html.indexOf('id="mna-tagline') === -1) {
        let headExtra = urlPath === '/index.html' ? HOME_TAGLINE_STYLE : TAGLINE_STYLE;
        if (path.basename(urlPath) === 'ebk.html') headExtra += EBK_FIX_STYLE;
        html = html.replace('</head>', headExtra + '</head>');
      }
      const add = [];
      if (!own && !html.includes('actualites-nav.js')) add.push(NAV_SCRIPT);
      if (!html.includes('ebk-nav.js')) add.push(EBK_SCRIPT);
      if (!html.includes('delais.js')) add.push(DELAIS_SCRIPT);
      if (BREVETS_PAGES.has(path.basename(urlPath)) && !html.includes('brevets.js')) add.push(BREVETS_SCRIPT);
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
