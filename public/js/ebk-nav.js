// Intégration de l'onglet « EBK » (École Biblique Kainos) dans les pages existantes.
// Ce script est ajouté automatiquement par le serveur : aucun fichier existant n'est modifié.
(function () {
  var path = location.pathname;
  var me = null;
  try { me = JSON.parse(localStorage.getItem('mna_user') || 'null'); } catch (e) {}

  // 1. Menu ordinateur : lien « EBK »
  var nav = document.querySelector('header nav');
  if (nav && !nav.querySelector('a[href="/ebk.html"]')) {
    var a = document.createElement('a');
    a.href = '/ebk.html';
    a.textContent = 'EBK';
    nav.insertBefore(a, nav.querySelector('a[href="/login.html"]') || null);
  }

  // 2. Téléphone : onglet « EBK » dans la barre du bas/haut (créée un peu plus tard par mobile-app.js)
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var tabs = document.querySelector('#mna-appbar .mna-tabs');
    if (tabs) {
      clearInterval(timer);
      if (tabs.querySelector('a[href="/ebk.html"]')) return;
      var on = path === '/ebk.html';
      var t = document.createElement('a');
      t.className = 'mna-tab' + (on ? ' on' : '');
      t.href = '/ebk.html';
      if (on) t.setAttribute('aria-current', 'page');
      t.innerHTML = '<span class="mna-ic" aria-hidden="true">✝️</span><span>EBK</span>';
      tabs.insertBefore(t, tabs.querySelector('a[href="/a-propos.html"]') || null);
      if (on) {
        var bar = document.getElementById('mna-appbar');
        requestAnimationFrame(function () { tabs.scrollLeft = t.offsetLeft - (tabs.clientWidth - t.offsetWidth) / 2; });
      }
    } else if (tries > 50) {
      clearInterval(timer);
    }
  }, 200);

  // 3. Panneau admin : raccourci vers l'administration de l'EBK (administrateur complet uniquement)
  if (path === '/admin.html' && me && me.role === 'admin' && me.admin_scope !== 'limited') {
    var n = 0;
    var t2 = setInterval(function () {
      n++;
      var area = document.getElementById('admin-area');
      if (area && !area.classList.contains('hidden')) {
        clearInterval(t2);
        if (document.getElementById('ebk-admin-panel')) return;
        var panel = document.createElement('div');
        panel.className = 'panel';
        panel.id = 'ebk-admin-panel';
        panel.innerHTML =
          '<h2 style="margin-bottom:6px;">École Biblique Kainos</h2>' +
          '<p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:14px;">Sessions, cours, vidéos, syllabus, tests, inscrits et certificats.</p>' +
          '<a href="/admin-ebk.html" class="btn btn-primary">✝️ Administration de l\'EBK</a>';
        area.insertBefore(panel, area.querySelector('.panel'));
      } else if (n > 40) {
        clearInterval(t2);
      }
    }, 250);
  }
})();
