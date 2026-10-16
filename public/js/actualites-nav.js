// Intégration de l'espace « Actualités chrétiennes » dans les pages existantes.
// Ce script est ajouté automatiquement par le serveur : aucun fichier existant n'est modifié.
(function () {
  const path = location.pathname;
  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; } };

  // --- 1. Lien « Actualités » dans le menu ---
  const nav = document.querySelector('header nav');
  if (nav && !nav.querySelector('a[href="/actualites.html"]')) {
    const a = document.createElement('a');
    a.href = '/actualites.html';
    a.textContent = 'Actualités';
    nav.insertBefore(a, nav.querySelector('a[href="/login.html"]') || null);
  }

  // --- 2. Page d'accueil : bandeau « À la une » qui donne envie de lire ---
  if (path === '/' || path === '/index.html') {
    fetch('/api/actualites?limit=8')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.items || !data.items.length) return;
        const items = data.items.slice().sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0)).slice(0, 3);
        if (!document.getElementById('nw-css')) {
          const l = document.createElement('link');
          l.id = 'nw-css'; l.rel = 'stylesheet'; l.href = '/css/actualites.css';
          document.head.appendChild(l);
        }
        const isNew = (a) => Date.now() - new Date(a.created_at).getTime() < 3 * 86400000;
        const sec = document.createElement('section');
        sec.id = 'actualites-accueil';
        sec.className = 'nw-banner-wrap';
        sec.innerHTML = `
          <div class="nw-banner" role="region" aria-label="Actualités chrétiennes à la une">
            ${items.map((a, i) => `
              <a class="nw-slide${i === 0 ? ' on' : ''}" href="/actualite.html?id=${a.id}" ${a.cover ? `style="background-image:url('${esc(String(a.cover).replace(/'/g, '%27'))}')"` : ''}>
                <span class="nw-shade"></span>
                <span class="nw-slide-in">
                  <span class="nw-live"><i></i>${isNew(a) ? 'Nouveau' : 'À la une'}</span>
                  <strong class="nw-slide-title">${esc(a.title)}</strong>
                  ${a.summary ? `<span class="nw-slide-sum">${esc(a.summary)}</span>` : ''}
                  <span class="nw-slide-meta">${esc(fmtDate(a.date))}${a.source_name ? ' · ' + esc(a.source_name) : ''}</span>
                  <span class="nw-slide-btn">Lire l'actualité →</span>
                </span>
              </a>`).join('')}
            <a class="nw-all" href="/actualites.html">Toutes les actualités</a>
            ${items.length > 1 ? `<div class="nw-dots">${items.map((a, i) => `<button type="button" aria-label="Actualité ${i + 1}" class="${i === 0 ? 'on' : ''}"></button>`).join('')}</div>` : ''}
          </div>`;

        const hero = document.querySelector('.hero');
        const anchor = hero ? (hero.closest('section') || hero) : document.querySelector('header');
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor.nextSibling);
        else document.body.insertBefore(sec, document.body.firstChild);

        // Défilement automatique (en pause au survol / au toucher)
        if (items.length > 1) {
          const slides = sec.querySelectorAll('.nw-slide');
          const dots = sec.querySelectorAll('.nw-dots button');
          let cur = 0, timer;
          const show = (n) => {
            cur = (n + slides.length) % slides.length;
            slides.forEach((s, i) => s.classList.toggle('on', i === cur));
            dots.forEach((d, i) => d.classList.toggle('on', i === cur));
          };
          const start = () => { clearInterval(timer); timer = setInterval(() => show(cur + 1), 6500); };
          dots.forEach((d, i) => d.addEventListener('click', () => { show(i); start(); }));
          const banner = sec.querySelector('.nw-banner');
          ['mouseenter', 'touchstart'].forEach((ev) => banner.addEventListener(ev, () => clearInterval(timer), { passive: true }));
          ['mouseleave', 'touchend'].forEach((ev) => banner.addEventListener(ev, start, { passive: true }));
          start();
        }
      })
      .catch(() => {});
  }

  // --- 3. Panneau admin : raccourci vers l'administration des actualités ---
  if (path === '/admin.html') {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const area = document.getElementById('admin-area');
      if (area && !area.classList.contains('hidden')) {
        clearInterval(timer);
        if (document.getElementById('nw-admin-panel')) return;
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.id = 'nw-admin-panel';
        panel.innerHTML = `
          <h2 style="margin-bottom:6px;">Actualités chrétiennes</h2>
          <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:14px;">Publiez une actualité à partir d'un lien, rédigez-en une, ou validez les propositions du jour.</p>
          <a href="/admin-actualites.html" class="btn btn-primary">📰 Administration des actualités</a>`;
        area.insertBefore(panel, area.querySelector('.panel'));
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 250);
  }
})();
