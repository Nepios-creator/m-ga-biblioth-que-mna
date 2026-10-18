const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireSuperAdmin, permsReady, PERMISSIONS, PERMISSION_KEYS } = require('../lib/auth-middleware');

const router = express.Router();
// Réservé à l'administrateur principal : un administrateur délégué ne peut jamais nommer d'autres administrateurs
router.use(requireAuth, requireSuperAdmin);

// Administrateurs principaux + administrateurs délégués (avec leurs droits), et la liste des droits possibles
router.get('/', async (req, res) => {
  try {
    await permsReady;
    const result = await pool.query(
      `SELECT id, email, full_name, role, admin_permissions, created_at
       FROM users
       WHERE role = 'admin' OR coalesce(array_length(admin_permissions, 1), 0) > 0
       ORDER BY (role = 'admin') DESC, created_at`
    );
    res.json({
      permissions: PERMISSIONS,
      main: result.rows.filter((u) => u.role === 'admin').map((u) => ({ id: u.id, email: u.email, full_name: u.full_name })),
      delegated: result.rows
        .filter((u) => u.role !== 'admin')
        .map((u) => ({ id: u.id, email: u.email, full_name: u.full_name, permissions: u.admin_permissions || [] })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Chercher un membre à nommer (hors administrateurs déjà en place)
router.get('/candidates', async (req, res) => {
  try {
    await permsReady;
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const pattern = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const result = await pool.query(
      `SELECT id, email, full_name FROM users
       WHERE role <> 'admin' AND coalesce(array_length(admin_permissions, 1), 0) = 0
         AND (email ILIKE $1 OR full_name ILIKE $1)
       ORDER BY full_name NULLS LAST, email LIMIT 20`,
      [pattern]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Donner ou modifier les droits d'un membre (liste vide = retirer l'accès administrateur)
router.put('/:id', async (req, res) => {
  try {
    await permsReady;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Membre invalide' });
    const perms = Array.isArray(req.body.permissions) ? [...new Set(req.body.permissions.map(String))] : null;
    if (!perms || perms.some((p) => !PERMISSION_KEYS.includes(p))) {
      return res.status(400).json({ message: 'Liste de droits invalide' });
    }
    const target = (await pool.query('SELECT id, role FROM users WHERE id = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ message: 'Membre introuvable' });
    if (target.role === 'admin') {
      return res.status(400).json({ message: 'Un administrateur principal ne peut pas être modifié ici.' });
    }
    await pool.query('UPDATE users SET admin_permissions = $1::text[] WHERE id = $2', [perms.length ? perms : null, id]);
    res.json({ id, permissions: perms });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Retirer tous les droits d'administration d'un membre
router.delete('/:id', async (req, res) => {
  try {
    await permsReady;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Membre invalide' });
    await pool.query("UPDATE users SET admin_permissions = NULL WHERE id = $1 AND role <> 'admin'", [id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
