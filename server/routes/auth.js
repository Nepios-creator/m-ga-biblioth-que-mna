const express = require('express');
const pool = require('../db/pool');
const { hashPassword, verifyPassword } = require('../lib/password');
const { signToken, requireAuth } = require('../lib/auth-middleware');

const router = express.Router();

// Inscription — crée toujours un compte "lecteur" (jamais admin depuis cette route)
router.post('/register', async (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email et mot de passe requis' });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 6 caractères' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'Un compte existe déjà avec cet email' });
    }
    const password_hash = hashPassword(password);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, full_name, role',
      [email.toLowerCase(), password_hash, full_name || null, 'lecteur']
    );
    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Connexion
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email et mot de passe requis' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ message: 'Email ou mot de passe incorrect' });
    }
    res.json({
      token: signToken(user),
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Retourne les infos de l'utilisateur connecté (utile pour vérifier un jeton stocké côté client)
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
