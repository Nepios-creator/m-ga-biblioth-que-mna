const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../lib/auth-middleware');

const router = express.Router();
router.use(requireAuth);

const SYSTEM_PROMPT = `Tu es l'Assistant IA du Ministère de la Nouvelle Alliance (MNA). Tu réponds comme une personne qui parle à une autre : avec chaleur, simplicité et naturel, comme un frère ou une sœur dans la foi qui connaît bien les enseignements du ministère et qui prend le temps d'expliquer.

FIDÉLITÉ AUX DONNÉES (règle la plus importante) :
- Pour tout ce qui touche à l'enseignement du ministère, tu t'appuies UNIQUEMENT sur les extraits fournis avec la question. Tu ne prêtes jamais aux livres une idée, une citation, un chapitre, un numéro de page ou un verset qui n'apparaît pas dans ces extraits.
- Si les extraits ne couvrent pas la question, dis-le simplement et honnêtement, par exemple : « Ce point précis n'est pas développé dans les textes que j'ai sous la main. » Tu peux alors donner un repère biblique général, en précisant clairement que cela ne vient pas des livres du ministère.
- Ne complète jamais un trou par une supposition. Mieux vaut une réponse courte et vraie qu'une longue réponse inventée.
- Cohérence : si le lecteur poursuit le même sujet, reste fidèle à tes réponses précédentes de cette conversation.

STYLE :
- Parle naturellement, à la première personne, avec des phrases courtes et vivantes, comme à l'oral. Vouvoie le lecteur avec douceur.
- N'écris jamais « en tant qu'assistant », « en tant qu'IA », ni de formules toutes faites d'ouverture ou de conclusion.
- Écris en paragraphes simples. Pas de titres, pas de listes à puces, pas de tableaux, pas d'émojis, pas de symboles décoratifs.
- Mets en gras avec **deux astérisques** uniquement les quelques mots ou phrases essentiels (l'idée clé, un verset important), sans en abuser. N'utilise aucun autre formatage.
- Reste concis : va à l'essentiel, sans répéter la question.

PÉRIMÈTRE :
- Tu ne traites que la foi chrétienne, la Bible, la théologie et la vie spirituelle. Pour tout autre sujet, décline avec douceur en une phrase.
- Aucun conseil médical, juridique, financier ou technique.`;


// Nettoie la réponse : garde uniquement le gras **...**, retire le reste du balisage inutile
function cleanAnswer(t) {
  return String(t || '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/`+/g, '')
    .replace(/__([^_\n]+)__/g, '**$1**')
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Recherche par recoupement de mots-clés dans la base de connaissances
async function retrieveContext(question, previousUserQuestion) {
  const searchText = question.split(/\s+/).length < 8 && previousUserQuestion ? previousUserQuestion + ' ' + question : question;
  const words = searchText.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 3);
  if (!words.length) return [];

  const rows = (await pool.query('SELECT title, content FROM ai_knowledge')).rows;
  const scored = rows.map(row => {
    const normalized = (row.title + ' ' + row.content).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const score = words.reduce((acc, w) => acc + (normalized.includes(w) ? 1 : 0), 0);
    return { ...row, score };
  });
  return scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

// Liste des conversations du lecteur
router.get('/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, updated_at FROM ai_conversations WHERE user_id=$1 ORDER BY updated_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Crée une nouvelle conversation
router.post('/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      "INSERT INTO ai_conversations (user_id, title) VALUES ($1,'Nouvelle discussion') RETURNING id, title, updated_at",
      [req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Détail d'une conversation avec tous ses messages
router.get('/conversations/:id', async (req, res) => {
  try {
    const convo = (await pool.query('SELECT * FROM ai_conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!convo) return res.status(404).json({ message: 'Conversation introuvable' });
    const messages = (await pool.query('SELECT id, role, content, created_at FROM ai_messages WHERE conversation_id=$1 ORDER BY id', [req.params.id])).rows;
    res.json({ conversation: convo, messages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Supprime une conversation
router.delete('/conversations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Pose une question dans une conversation existante (garde le contexte complet de l'échange)
router.post('/conversations/:id/ask', async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ message: 'Question vide' });
  if (!process.env.MISTRAL_API_KEY) {
    return res.status(503).json({ message: 'L\'assistant n\'est pas encore configuré (clé API manquante).' });
  }
  try {
    const convo = (await pool.query('SELECT * FROM ai_conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!convo) return res.status(404).json({ message: 'Conversation introuvable' });

    const priorMessages = (await pool.query(
      'SELECT role, content FROM ai_messages WHERE conversation_id=$1 ORDER BY id', [convo.id]
    )).rows;

    await pool.query('INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,$2,$3)', [convo.id, 'user', question]);

    const lastUser = [...priorMessages].reverse().find(m => m.role === 'user');
    const context = await retrieveContext(question, lastUser ? lastUser.content : null);
    const contextText = context.length
      ? context.map(c => `--- ${c.title} ---\n${c.content}`).join('\n\n')
      : '(Aucun extrait pertinent trouvé — réponds avec une connaissance biblique générale.)';

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...priorMessages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: `Extraits disponibles pour cette question :\n\n${contextText}\n\nQuestion du lecteur : ${question}` },
    ];

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({ model: 'mistral-small-latest', max_tokens: 700, temperature: 0.3, messages }),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({ message: data.message || data.error?.message || 'Erreur de l\'assistant' });
    }
    const answer = cleanAnswer(data.choices?.[0]?.message?.content) || 'Désolé, je n\'ai pas pu répondre.';

    await pool.query('INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,$2,$3)', [convo.id, 'assistant', answer]);

    // Titre automatique basé sur la première question, si c'est la première réponse
    if (priorMessages.length === 0) {
      const title = question.length > 60 ? question.slice(0, 57) + '…' : question;
      await pool.query('UPDATE ai_conversations SET title=$1, updated_at=now() WHERE id=$2', [title, convo.id]);
    } else {
      await pool.query('UPDATE ai_conversations SET updated_at=now() WHERE id=$1', [convo.id]);
    }

    res.json({ answer, sources: context.map(c => c.title) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
