const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth-middleware');

const router = express.Router();
router.use(requireAuth);

// Envoyer un message au ministère (accusé de réception automatique dans la réponse)
router.post('/', async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.status(400).json({ message: 'Le message ne peut pas être vide' });
  try {
    const result = await pool.query(
      'INSERT INTO messages (user_id, subject, body, status) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, subject || null, body, 'recu']
    );
    res.status(201).json({
      message: result.rows[0],
      acknowledgement: 'Votre message a bien été reçu par le Ministère de la Nouvelle Alliance. Nous vous répondrons dès que possible.',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Voir ses propres messages et les réponses reçues
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM messages WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
