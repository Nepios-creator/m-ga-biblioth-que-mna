// Traduction automatique d'une actualité en français (optionnelle : demande la clé MISTRAL_API_KEY, déjà utilisée par le site).
const { sanitizeHtml, textFromHtml } = require('./html-tools');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askMistral(prompt, maxTokens) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({ model: 'mistral-small-latest', max_tokens: maxTokens, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < 2) { await sleep(6000); continue; }
    if (!response.ok) throw new Error((data.message || (data.error && data.error.message)) || 'Erreur du service de traduction');
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }
  return '';
}

// Découpe le HTML en morceaux (≈ 4500 caractères) aux fins de paragraphes
function chunkHtml(html) {
  const parts = String(html || '').split(/(?<=<\/(?:p|h2|h3|h4|ul|ol|blockquote|figure)>)/i);
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length > 4500) { chunks.push(cur); cur = ''; }
    cur += p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

function stripFences(s) {
  return String(s || '').trim().replace(/^```(?:html|json)?\s*/i, '').replace(/```$/, '').trim();
}

async function translateToFrench({ title, summary, body_html }) {
  if (!process.env.MISTRAL_API_KEY) {
    throw new Error('La traduction automatique n\'est pas activée : la clé MISTRAL_API_KEY est absente du serveur.');
  }
  // Titre et résumé
  const head = stripFences(await askMistral(
    'Traduis en français naturel et sobre le titre et le résumé d\'une actualité chrétienne. ' +
    'Réponds UNIQUEMENT par un objet JSON de la forme {"title":"…","summary":"…"}, sans autre texte.\n\n' +
    JSON.stringify({ title: title || '', summary: summary || '' }), 700));
  let t = title || '';
  let s = summary || '';
  try { const j = JSON.parse(head); t = String(j.title || t); s = String(j.summary || s); } catch (e) { /* on garde l'original */ }

  // Texte, morceau par morceau
  const out = [];
  for (const chunk of chunkHtml(body_html)) {
    const res = stripFences(await askMistral(
      'Traduis en français naturel et fidèle le contenu HTML ci-dessous. Conserve exactement les balises HTML et leurs attributs ' +
      '(adresses des liens et des images inchangées). N\'ajoute aucun commentaire ni explication. Réponds uniquement par le HTML traduit.\n\n' + chunk, 4000));
    out.push(res || chunk);
    await sleep(800);
  }
  const html = sanitizeHtml(out.join(''));
  if (body_html && textFromHtml(html).length < textFromHtml(body_html).length * 0.4) {
    throw new Error('La traduction est incomplète : réessayez ou traduisez le texte à la main.');
  }
  return { title: t.slice(0, 300), summary: s.slice(0, 600), body_html: html, language: 'fr' };
}

module.exports = { translateToFrench };
