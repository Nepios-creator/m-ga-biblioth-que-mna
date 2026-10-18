// Ajouts communs à toutes les pages : liens du menu et raccourcis du panneau administrateur.
(function () {
  const path = location.pathname;

  function pageExists(url) {
    return fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  }

  // --- Menu : liens « Bible » et « Livres audio » ---
  const nav = document.querySelector('header nav');
  function addNavLink(href, label) {
    if (!nav || nav.querySelector(`a[href="${href}"]`)) return;
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    const connexion = nav.querySelector('a[href="/login.html"]');
    nav.insertBefore(a, connexion || null);
  }
  addNavLink('/bible.html', 'Bible');
  pageExists('/audio.html').then((ok) => { if (ok) addNavLink('/audio.html', 'Livres audio'); });

  // --- Panneau admin : raccourcis vers les espaces d'administration (selon les droits de la personne) ---
  if (path === '/admin.html') {
    const area = document.getElementById('admin-area');
    let me = null;
    try { me = JSON.parse(localStorage.getItem('mna_user') || 'null'); } catch (e) {}
    const limited = !!(me && me.admin_scope === 'limited');
    const can = (p) => !limited || (me.permissions || []).includes(p);
    if (area && !area.classList.contains('hidden')) {
      const links = [];
      if (!limited) links.push('<a href="/admin-administrateurs.html" class="btn btn-primary">🛡️ Administrateurs et droits</a>');
      if (can('membres') || can('emails')) links.push('<a href="/admin-membres.html" class="btn btn-primary">👥 Membres et messages</a>');
      if (can('statistiques')) links.push('<a href="/admin-statistiques.html" class="btn btn-primary">📊 Statistiques des visites</a>');
      if (can('bible')) links.push('<a href="/admin-bible.html" class="btn btn-primary">📖 Administration de la Bible</a>');
      if (can('audio')) links.push('<a href="/admin-audio.html" class="btn btn-primary" id="link-admin-audio" style="display:none;">🎧 Administration des livres audio</a>');
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = `
        <h2 style="margin-bottom:6px;">Espaces spéciaux</h2>
        <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:14px;">${limited ? 'Vos accès d\'administrateur.' : 'Gérez ici les administrateurs, la Bible « Parole pure », les livres audio, les membres et les statistiques.'}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">${links.join('')}</div>`;
      const firstPanel = area.querySelector('.panel');
      area.insertBefore(panel, firstPanel);
      pageExists('/admin-audio.html').then((ok) => { const l = document.getElementById('link-admin-audio'); if (ok && l) l.style.display = 'inline-block'; });
    }
  }
})();
