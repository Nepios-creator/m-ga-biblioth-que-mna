const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../lib/auth-middleware');
const { tablesReady: statsReady } = require('./stats');

const router = express.Router();
// Tout ce qui suit est réservé aux administrateurs connectés (vérifié côté serveur à chaque appel)
router.use(requireAuth, requireAdmin);

// ---------- Préparation automatique de la table d'historique des envois ----------
const tablesReady = (async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mail_campaigns (
        id SERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        audience TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'en_cours',
        error_note TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );
    `);
    // Un envoi resté « en cours » après un redémarrage du serveur est marqué comme interrompu
    await pool.query("UPDATE mail_campaigns SET status = 'interrompu', finished_at = now() WHERE status = 'en_cours'");
  } catch (err) {
    console.error('Messages aux membres : création de la table impossible :', err.message);
  }
})();

// ---------- Configuration de l'envoi d'e-mails (Resend) ----------
function mailConfig() {
  const key = process.env.RESEND_API_KEY || '';
  const from = process.env.MAIL_FROM || '';
  const missing = [];
  if (!key) missing.push('RESEND_API_KEY');
  if (!from) missing.push('MAIL_FROM');
  return { key, from, replyTo: process.env.MAIL_REPLY_TO || '', missing };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const firstName = (u) => (String(u.full_name || '').trim().split(/\s+/)[0] || 'cher membre');
const fill = (tpl, u) => String(tpl).replace(/\{nom\}/gi, firstName(u));

function renderHtml(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#f4efe6;padding:20px;font-family:Georgia,'Times New Roman',serif;color:#222;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5dccb;">
<div style="background:#16130f;color:#e8c872;padding:18px 24px;font-size:18px;letter-spacing:.5px;">Ministère de la Nouvelle Alliance</div>
<div style="padding:24px;font-size:16px;">${paragraphs}</div>
<div style="padding:14px 24px;background:#faf6ee;font-size:12px;color:#777;">Vous recevez ce message parce que vous avez un compte sur ministeredelanouvellealliance.org.</div>
</div></body></html>`;
}

async function resend(cfg, path, payload) {
  const r = await fetch(`https://api.resend.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Erreurs qui arrêtent tout l'envoi (clé invalide, domaine non vérifié, limite atteinte)
function fatalMessage(res) {
  const name = String(res.data.name || '').toLowerCase();
  const msg = String(res.data.message || '');
  if (name.includes('quota') || /quota/i.test(msg)) {
    return 'Limite d\'envoi de Resend atteinte (le plan gratuit permet 100 e-mails par jour). Réessayez demain ou passez à un plan supérieur.';
  }
  if (res.status === 401) return 'La clé Resend (RESEND_API_KEY) est invalide.';
  if (res.status === 403) return `Resend refuse l'envoi : le domaine de l'expéditeur n'est probablement pas encore vérifié. Détail : ${msg}`.slice(0, 300);
  return null;
}
const describe = (res) => `${res.status} ${res.data.name || ''} ${res.data.message || ''}`.trim().slice(0, 300);

async function sendWithRetry(cfg, path, payload) {
  let res = await resend(cfg, path, payload);
  if (res.status === 429 && !/quota/i.test(String(res.data.name || '') + String(res.data.message || ''))) {
    await sleep(2000);
    res = await resend(cfg, path, payload);
  }
  return res;
}

// Envoi en arrière-plan : la page n'a pas à attendre la fin
async function runCampaign(id, recipients, subjectTpl, bodyTpl, cfg) {
  let sent = 0;
  let failed = 0;
  let note = null;
  let status = 'termine';
  const total = recipients.length;
  const make = (u) => {
    const text = fill(bodyTpl, u);
    return {
      from: cfg.from,
      to: [u.email],
      subject: fill(subjectTpl, u),
      html: renderHtml(text),
      text,
      ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    };
  };

  try {
    outer:
    for (let i = 0; i < total; i += 100) {
      const chunk = recipients.slice(i, i + 100);
      const res = await sendWithRetry(cfg, '/emails/batch', chunk.map(make));
      if (res.ok) {
        sent += chunk.length;
      } else {
        const fatal = fatalMessage(res);
        if (fatal) { note = fatal; status = 'interrompu'; break outer; }
        // Une adresse refusée fait échouer tout le lot : on renvoie un par un pour isoler le problème
        for (const u of chunk) {
          await sleep(600);
          const one = await sendWithRetry(cfg, '/emails', make(u));
          if (one.ok) { sent += 1; continue; }
          const oneFatal = fatalMessage(one);
          if (oneFatal) { note = oneFatal; status = 'interrompu'; break outer; }
          failed += 1;
          note = note || describe(one);
        }
      }
      await pool.query('UPDATE mail_campaigns SET sent = $1, failed = $2 WHERE id = $3', [sent, failed, id]);
      await sleep(600); // respecte la limite de Resend (2 requêtes par seconde)
    }
    if (status === 'interrompu') failed = total - sent;
  } catch (err) {
    status = 'interrompu';
    failed = total - sent;
    note = err.message.slice(0, 300);
  }
  await pool.query(
    'UPDATE mail_campaigns SET sent = $1, failed = $2, status = $3, error_note = $4, finished_at = now() WHERE id = $5',
    [sent, failed, status, note, id]
  ).catch(() => {});
}

// =====================================================================
//  ROUTES
// =====================================================================

// L'envoi d'e-mails est-il prêt ?
router.get('/mail-status', (req, res) => {
  const cfg = mailConfig();
  res.json({ configured: cfg.missing.length === 0, missing: cfg.missing, from: cfg.from || null });
});

// Historique des envois
router.get('/campaigns', async (req, res) => {
  try {
    await tablesReady;
    const result = await pool.query(
      `SELECT id, subject, audience, total, sent, failed, status, error_note, created_at, finished_at
       FROM mail_campaigns ORDER BY created_at DESC LIMIT 40`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    await tablesReady;
    const result = await pool.query(
      `SELECT id, subject, audience, total, sent, failed, status, error_note, created_at, finished_at
       FROM mail_campaigns WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'Envoi introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Envoyer un message : à tous les membres, à une sélection, ou un test à soi-même
router.post('/send', async (req, res) => {
  try {
    await tablesReady;
    const cfg = mailConfig();
    if (cfg.missing.length) {
      return res.status(400).json({ message: `L'envoi d'e-mails n'est pas encore configuré (manque : ${cfg.missing.join(', ')}).` });
    }
    const subject = String(req.body.subject || '').trim().slice(0, 200);
    const body = String(req.body.body || '').trim().slice(0, 20000);
    if (!subject || !body) return res.status(400).json({ message: 'Le sujet et le message sont obligatoires' });

    const mode = ['all', 'selected', 'test'].includes(req.body.mode) ? req.body.mode : 'selected';
    let rows;
    if (mode === 'test') {
      rows = (await pool.query('SELECT id, email, full_name FROM users WHERE id = $1', [req.user.id])).rows;
    } else if (mode === 'all') {
      rows = (await pool.query('SELECT id, email, full_name FROM users ORDER BY id')).rows;
    } else {
      const ids = Array.isArray(req.body.user_ids)
        ? [...new Set(req.body.user_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
        : [];
      if (!ids.length) return res.status(400).json({ message: 'Choisissez au moins un destinataire' });
      rows = (await pool.query('SELECT id, email, full_name FROM users WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows;
    }
    rows = rows.filter((u) => EMAIL_RE.test(String(u.email || '')));
    if (!rows.length) return res.status(400).json({ message: 'Aucune adresse e-mail valide parmi les destinataires' });

    if (mode !== 'test') {
      const running = await pool.query("SELECT 1 FROM mail_campaigns WHERE status = 'en_cours' AND audience <> 'test' LIMIT 1");
      if (running.rows.length) return res.status(409).json({ message: 'Un envoi est déjà en cours — attendez qu\'il se termine.' });
    }

    const audience = mode === 'all' ? 'tous' : mode === 'test' ? 'test' : 'selection';
    const created = await pool.query(
      'INSERT INTO mail_campaigns (subject, body, audience, total, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, total',
      [subject, body, audience, rows.length, req.user.id]
    );
    const campaign = created.rows[0];
    res.status(202).json({ id: campaign.id, total: campaign.total });

    runCampaign(campaign.id, rows, subject, body, cfg).catch((err) => console.error('Envoi des messages :', err.message));
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});

// Liste de tous les membres inscrits (jamais de mot de passe)
router.get('/', async (req, res) => {
  try {
    await statsReady;
    const members = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.created_at,
              v.last_visit, coalesce(v.visits, 0)::int AS visits
       FROM users u
       LEFT JOIN (
         SELECT user_id, max(viewed_at) AS last_visit, count(*) AS visits
         FROM page_views WHERE user_id IS NOT NULL GROUP BY user_id
       ) v ON v.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT 20000`
    );
    res.json({ members: members.rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
