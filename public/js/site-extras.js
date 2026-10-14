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

  // --- Panneau admin : raccourcis vers les nouveaux espaces d'administration ---
  if (path === '/admin.html') {
    const area = document.getElementById('admin-area');
    if (area && !area.classList.contains('hidden')) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML = `
        <h2 style="margin-bottom:6px;">Espaces spéciaux</h2>
        <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:14px;">Gérez ici la Bible « Parole pure » et les livres audio.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <a href="/admin-bible.html" class="btn btn-primary">📖 Administration de la Bible</a>
          <a href="/admin-audio.html" class="btn btn-primary" id="link-admin-audio" style="display:none;">🎧 Administration des livres audio</a>
        </div>`;
      const firstPanel = area.querySelector('.panel');
      area.insertBefore(panel, firstPanel);
      pageExists('/admin-audio.html').then((ok) => { if (ok) document.getElementById('link-admin-audio').style.display = 'inline-block'; });
    }
  }
})();
