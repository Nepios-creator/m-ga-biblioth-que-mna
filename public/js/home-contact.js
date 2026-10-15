/* Page d'accueil : bouton « Écrire au ministère » + formulaire de message
   (le message arrive au ministère comme ceux envoyés depuis l'espace d'étude). */
(function () {
  if (document.getElementById('ecrire-ministere')) return;

  const token = localStorage.getItem('mna_token');
  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const section = document.createElement('section');
  section.className = 'section';
  section.id = 'ecrire-ministere';
  section.innerHTML = `
    <div class="container" style="text-align:center;max-width:680px;">
      <span class="tag">Contact</span>
      <h2>Écrire au ministère</h2>
      <p class="lead" style="margin-left:auto;margin-right:auto;">Une question, une prière, un témoignage ? Envoyez un message directement au Ministère de la Nouvelle Alliance.</p>
      <button class="btn btn-primary" id="contact-open">✉️ Écrire au ministère</button>
      <div id="contact-box" style="display:none;margin-top:22px;text-align:left;"></div>
    </div>`;

  const anchor = document.querySelector('.cta-final') || document.querySelector('footer');
  if (!anchor || !anchor.parentNode) return;
  anchor.parentNode.insertBefore(section, anchor);

  const box = document.getElementById('contact-box');

  function openBox() {
    box.style.display = 'block';
    if (!token) {
      box.innerHTML = `
        <div style="background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;text-align:center;">
          <p style="margin-bottom:14px;">Connectez-vous (ou créez un compte gratuit) pour écrire au ministère : il pourra ainsi vous répondre.</p>
          <a href="/login.html" class="btn btn-primary">Se connecter / Créer un compte</a>
        </div>`;
      return;
    }
    box.innerHTML = `
      <form id="contact-form" style="background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;">
        <div id="contact-feedback"></div>
        <textarea id="contact-body" rows="5" placeholder="Écrivez votre message ici…" required style="width:100%;padding:10px 13px;border:1px solid var(--line);border-radius:10px;font-family:inherit;font-size:15px;"></textarea>
        <button type="submit" class="btn btn-primary" style="margin-top:12px;">Envoyer</button>
        <a href="/espace-etude.html" style="margin-left:12px;font-size:13px;color:var(--blue-deep);">Voir mes messages et les réponses</a>
      </form>`;
    document.getElementById('contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const feedback = document.getElementById('contact-feedback');
      const body = document.getElementById('contact-body').value.trim();
      if (!body) return;
      try {
        const r = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ body }),
        });
        const data = await r.json();
        if (r.status === 401) {
          feedback.innerHTML = '<div class="msg error" style="background:#fdeaea;color:#a33;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:14px;">Votre session a expiré. <a href="/login.html">Reconnectez-vous</a> pour envoyer votre message.</div>';
          return;
        }
        if (!r.ok) throw new Error(data.message || 'Erreur');
        feedback.innerHTML = `<div class="msg success" style="background:#e8f6ec;color:#2a7a44;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:14px;">${esc(data.acknowledgement)}</div>`;
        document.getElementById('contact-body').value = '';
      } catch (err) {
        feedback.innerHTML = `<div class="msg error" style="background:#fdeaea;color:#a33;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:14px;">${esc(err.message || 'Impossible d\'envoyer le message pour le moment.')}</div>`;
      }
    });
    document.getElementById('contact-body').focus();
  }

  document.getElementById('contact-open').addEventListener('click', openBox);

  // Second bouton, tout en haut de l'accueil
  const heroActions = document.querySelector('.hero .actions');
  if (heroActions) {
    const heroBtn = document.createElement('a');
    heroBtn.href = '#ecrire-ministere';
    heroBtn.className = 'btn btn-ghost';
    heroBtn.style.cssText = 'background:transparent;border-color:rgba(255,255,255,0.35);color:#f4ede0;';
    heroBtn.textContent = '✉️ Écrire au ministère';
    heroBtn.addEventListener('click', () => setTimeout(openBox, 50));
    heroActions.appendChild(heroBtn);
  }
})();
