const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || 'change-moi-en-production';

// Colonne des droits d'un administrateur délégué (créée automatiquement au démarrage)
const permsReady = pool
  .query('ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_permissions TEXT[]')
  .catch((err) => console.error('Droits des administrateurs : colonne impossible à créer :', err.message));

// Les droits que vous pouvez accorder à un membre (la gestion des administrateurs reste toujours réservée à vous)
const PERMISSIONS = [
  { key: 'membres', label: 'Voir la liste des membres', description: 'Noms, e-mails, dates d\'inscription et dernières visites.' },
  { key: 'emails', label: 'Envoyer des messages aux membres', description: 'Écrire aux membres par e-mail (donne aussi accès à la liste pour les choisir).' },
  { key: 'statistiques', label: 'Voir les statistiques des visites', description: 'Visites par jour, pages vues, appareils, inscriptions.' },
  { key: 'livres', label: 'Gérer les livres et citations', description: 'Catalogue, espace d\'étude, citations.' },
  { key: 'messages_lecteurs', label: 'Lire les messages des lecteurs', description: 'Messages reçus depuis le site.' },
  { key: 'assistant_ia', label: 'Gérer l\'assistant (connaissances)', description: 'Documents de connaissance de l\'assistant.' },
  { key: 'bible', label: 'Gérer la Bible', description: 'Publier, masquer ou supprimer les livres de la Bible.' },
  { key: 'audio', label: 'Gérer les livres audio', description: 'Administration des livres audio.' },
];
const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// Quelle section de l'administration correspond à quelle adresse. Tout ce qui n'est pas listé ici
// reste réservé aux administrateurs complets (c'est la règle par défaut, la plus sûre).
const RULES = [
  [/^\/api\/admin\/members\/(send|campaigns|mail-status)/, ['emails']],
  [/^\/api\/admin\/members\/?$/, ['membres', 'emails']],
  [/^\/api\/admin\/stats/, ['statistiques']],
  [/^\/api\/admin\/(books|quotes)/, ['livres']],
  [/^\/api\/admin\/messages/, ['messages_lecteurs']],
  [/^\/api\/admin\/knowledge/, ['assistant_ia']],
  [/^\/api\/bible\/admin/, ['bible']],
  [/^\/api\/audio\/admin/, ['audio']],
];

function neededPermissions(req) {
  const full = (req.baseUrl || '') + (req.path || '');
  for (const [re, perms] of RULES) if (re.test(full)) return perms;
  return null;
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Vérifie le jeton envoyé dans l'en-tête Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Connexion requise' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ message: 'Session invalide ou expirée' });
  }
}

// Droits actuels, lus dans la base à chaque appel (un retrait de droits agit tout de suite)
async function loadAccess(userId) {
  await permsReady;
  const r = await pool.query('SELECT role, admin_permissions FROM users WHERE id = $1', [userId]);
  const u = r.rows[0];
  if (!u) return null;
  return { full: u.role === 'admin', permissions: Array.isArray(u.admin_permissions) ? u.admin_permissions : [] };
}

// À utiliser après requireAuth : administrateur complet, ou administrateur délégué ayant le droit
// correspondant à la section demandée
async function requireAdmin(req, res, next) {
  try {
    const access = req.user ? await loadAccess(req.user.id) : null;
    if (access && access.full) { req.access = access; return next(); }
    if (access && access.permissions.length) {
      const needed = neededPermissions(req);
      if (needed && needed.some((p) => access.permissions.includes(p))) { req.access = access; return next(); }
      return res.status(403).json({ message: 'Vous n\'avez pas le droit d\'accéder à cette section.' });
    }
    return res.status(403).json({ message: 'Accès réservé aux administrateurs' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// Réservé à l'administrateur complet (jamais aux administrateurs délégués)
async function requireSuperAdmin(req, res, next) {
  try {
    const access = req.user ? await loadAccess(req.user.id) : null;
    if (access && access.full) { req.access = access; return next(); }
    return res.status(403).json({ message: 'Réservé à l\'administrateur principal' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// Ce que le site (le navigateur) doit savoir de l'utilisateur. Un administrateur délégué apparaît comme
// « admin » côté affichage, avec la liste de ses droits ; le vrai contrôle reste fait par le serveur.
function clientUser(row) {
  const perms = Array.isArray(row.admin_permissions) ? row.admin_permissions : [];
  const u = { id: row.id, email: row.email, full_name: row.full_name, role: row.role };
  if (row.role === 'admin') u.admin_scope = 'full';
  else if (perms.length) { u.role = 'admin'; u.admin_scope = 'limited'; u.permissions = perms; }
  return u;
}

module.exports = {
  signToken, requireAuth, requireAdmin, requireSuperAdmin, clientUser, permsReady,
  PERMISSIONS, PERMISSION_KEYS, JWT_SECRET,
};
