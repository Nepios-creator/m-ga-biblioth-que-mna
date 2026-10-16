// Intégration de l'espace « Actualités chrétiennes » dans les pages existantes du site.
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

  // --- 2. Page d'accueil : les dernières actualités ---
  if (path === '/' || path === '/index.html') {
    fetch('/api/actualites?limit=3')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.items || !data.items.length) return;
        if (!document.getElementById('nw-css')) {
          const l = document.createElement('link');
          l.id = 'nw-css'; l.rel = 'stylesheet'; l.href = '/css/actualites.css';
          document.head.appendChild(l);
        }
        const sec = document.createElement('section');
        sec.className = 'section nw-home';
        sec.id = 'actualites-accueil';
        sec.innerHTML = `
          <div class="container">
            <span class="tag">Actualités chrétiennes</span>
            <h2>L'Église dans le monde</h2>
            <p class="lead">Les dernières nouvelles chrétiennes du monde entier, présentées simplement.</p>
            <div class="nw-grid">${data.items.map((a) => `
              <a class="nw-card" href="/actualite.html?id=${a.id}">
                <div class="img" ${a.cover ? `style="background-image:url('${esc(a.cover)}')"` : ''}>${a.cover ? '' : '📰'}</div>
                <div class="body">
                  <div class="nw-meta"><span>${esc(fmtDate(a.date))}</span>${a.source_name ? `<span>· ${esc(a.source_name)}</span>` : ''}</div>
                  <h3>${esc(a.title)}</h3>
                  ${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
                </div>
              </a>`).join('')}
            </div>
            <a class="btn btn-primary" href="/actualites.html">Voir toutes les actualités</a>
          </div>`;
        const target = document.querySelector('.cta-final') || document.querySelector('footer');
        if (target && target.parentNode) target.parentNode.insertBefore(sec, target);
        else document.body.appendChild(sec);
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
