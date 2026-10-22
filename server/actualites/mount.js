// Branche le module « Actualités chrétiennes » sur l'application Express existante.
//  1. API         : /api/actualites (public + administration)
//  2. Navigation  : ajoute le lien « Actualités » dans les pages existantes (sans modifier leurs fichiers)
//  3. Quotidien   : lance la recherche quotidienne d'actualités dans les sources officielles
//  4. EBK         : branche l'API /api/ebk (École Biblique Kainos) et ajoute l'onglet « EBK » dans les pages
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

module.exports = function mountActualites(app, express, publicDir) {
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
      const add = [];
      if (!own && !html.includes('actualites-nav.js')) add.push(NAV_SCRIPT);
      if (!html.includes('ebk-nav.js')) add.push(EBK_SCRIPT);
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
