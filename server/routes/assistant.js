const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const SYSTEM_PROMPT = `Tu es l'assistant du Ministère de la Nouvelle Alliance (MNA), un ministère chrétien.

Ton unique rôle est de répondre à des questions religieuses et bibliques, en t'appuyant en priorité sur les extraits fournis ci-dessous (issus des livres du ministère), et sinon sur une connaissance biblique saine et généralement admise.

Règles strictes :
- Si la question n'a AUCUN rapport avec la foi chrétienne, la Bible, la théologie ou la vie spirituelle, décline poliment et rappelle que tu es un assistant religieux du MNA.
- Ne donne jamais de conseils médicaux, juridiques, financiers ou techniques, même déguisés en question spirituelle.
- Reste respectueux, pastoral, et clair. Cite les références bibliques quand c'est pertinent.
- Si les extraits fournis contiennent la réponse, base-toi dessus en priorité et mentionne le livre concerné.
- Si tu ne sais pas, dis-le honnêtement plutôt que d'inventer.`;

// Recherche simple par recoupement de mots-clés dans la base de connaissances
async function retrieveContext(question) {
  const words = question.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .split(/[^a-z0-9]+/).filter(w => w.length > 3);
  if (!words.length) return [];

  const rows = (await pool.query('SELECT title, content FROM ai_knowledge')).rows;
  const scored = rows.map(row => {
    const normalized = row.content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const score = words.reduce((acc, w) => acc + (normalized.includes(w) ? 1 : 0), 0);
    return { ...row, score };
  });
  return scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

router.post('/ask', async (req, res) => {
  const { question, history } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ message: 'Question vide' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ message: 'L\'assistant n\'est pas encore configuré (clé API manquante).' });
  }
  try {
    const context = await retrieveContext(question);
    const contextText = context.length
      ? context.map(c => `--- ${c.title} ---\n${c.content}`).join('\n\n')
      : '(Aucun extrait pertinent trouvé dans la bibliothèque pour cette question — réponds avec une connaissance biblique générale.)';

    const messages = [
      ...(Array.isArray(history) ? history.slice(-6) : []),
      { role: 'user', content: `Extraits disponibles :\n\n${contextText}\n\nQuestion du lecteur : ${question}` },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({ message: data.error?.message || 'Erreur de l\'assistant' });
    }
    const answer = data.content?.map(b => b.text || '').join('') || 'Désolé, je n\'ai pas pu répondre.';
    res.json({ answer, sources: context.map(c => c.title) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
