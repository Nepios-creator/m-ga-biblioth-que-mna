// Compte à rebours des livres d'étude et des sessions EBK + raccourci d'administration.
// Ce script est ajouté automatiquement par le serveur : aucun fichier existant n'est modifié.
(function () {
  if (window.__mnaDelais) return;
  window.__mnaDelais = true;
  var path = location.pathname;
  var token = localStorage.getItem('mna_token');
  var me = null;
  try { me = JSON.parse(localStorage.getItem('mna_user') || 'null'); } catch (e) {}
  var onStudy = /espace-etude/.test(path);
  var onEbk = /\/ebk\.html$/.test(path);
  var onAdmin = /^\/admin/.test(path);

  // ---------- Administration : raccourci vers la page des délais ----------
  if (onAdmin && path !== '/admin-delais.html' && me && me.role === 'admin' && me.admin_scope !== 'limited') {
    var n = 0;
    var t2 = setInterval(function () {
      n++;
      var area = document.getElementById('admin-area');
      if (path === '/admin.html' && area && !area.classList.contains('hidden')) {
        clearInterval(t2);
        if (document.getElementById('delais-admin-panel')) return;
        var panel = document.createElement('div');
        panel.className = 'panel';
        panel.id = 'delais-admin-panel';
        panel.innerHTML =
          '<h2 style="margin-bottom:6px;">Délais et compte à rebours</h2>' +
          '<p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:14px;">Un livre d\'étude à terminer en 45 jours, une session EBK qui se ferme toute seule : choisissez la durée et les personnes concernées.</p>' +
          '<a href="/admin-delais.html" class="btn btn-primary">⏳ Gérer les délais</a>';
        area.insertBefore(panel, area.querySelector('.panel'));
      } else if (n > 40) {
        clearInterval(t2);
      }
    }, 250);
  }

  if (!onStudy && !onEbk) return;

  // ---------- Style ----------
  var css = document.createElement('style');
  css.textContent =
    '.dl-wrap{max-width:820px;margin:0 auto 22px}' +
    '.dl-card{position:relative;overflow:hidden;border-radius:16px;padding:18px 20px;margin-bottom:14px;color:#fff;background:linear-gradient(135deg,#1f5386,#16130f);box-shadow:0 6px 22px rgba(22,19,15,.18)}' +
    '.dl-card.dl-warn{background:linear-gradient(135deg,#b7791f,#3a2a0c)}' +
    '.dl-card.dl-danger{background:linear-gradient(135deg,#b3261e,#3b0d0a)}' +
    '.dl-card.dl-expired{background:linear-gradient(135deg,#6b6558,#2b2824)}' +
    '.dl-label{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;font-weight:700}' +
    '.dl-title{font-size:18px;font-weight:700;margin:3px 0 12px;line-height:1.3}' +
    '.dl-clock{display:flex;gap:10px}' +
    '.dl-u{flex:1;min-width:0;text-align:center;background:rgba(255,255,255,.12);border-radius:12px;padding:10px 4px}' +
    '.dl-u b{display:block;font-size:26px;line-height:1.1;font-variant-numeric:tabular-nums}' +
    '.dl-u small{font-size:11px;opacity:.8}' +
    '.dl-bar{height:5px;border-radius:99px;background:rgba(255,255,255,.18);margin-top:14px;overflow:hidden}' +
    '.dl-bar i{display:block;height:100%;width:0;background:#e8c874;border-radius:99px;transition:width 1s linear}' +
    '.dl-end{font-size:12.5px;opacity:.85;margin-top:9px}' +
    '.dl-over{font-size:15px;font-weight:600;padding:6px 0}' +
    '.dl-chip{display:inline-block;margin-top:6px;font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;background:#e8f1fa;color:#1f5386;font-variant-numeric:tabular-nums}' +
    '.dl-chip.dl-warn{background:#fff3df;color:#9a5b00}.dl-chip.dl-danger{background:#fdeaea;color:#b3261e}.dl-chip.dl-expired{background:#eee9df;color:#6b6558}' +
    '@media(max-width:480px){.dl-u b{font-size:21px}.dl-title{font-size:16px}}';
  document.head.appendChild(css);

  // ---------- Outils ----------
  var offset = 0; // écart entre l'heure du serveur et celle du téléphone
  var items = [];
  function nowMs() { return Date.now() + offset; }
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function pad(x) { return (x < 10 ? '0' : '') + x; }
  function parts(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600), m: Math.floor(s % 3600 / 60), s: s % 60 };
  }
  function dateText(iso) {
    try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }); } catch (e) { return iso; }
  }
  function urgency(left) { return left <= 0 ? 'dl-expired' : (left < 86400000 ? 'dl-danger' : (left < 3 * 86400000 ? 'dl-warn' : '')); }
  function labelFor(it, over) {
    if (it.kind === 'ebk_session') return over ? 'Session terminée' : 'Session ouverte — fermeture automatique dans';
    return over ? 'Délai terminé' : 'Livre à étudier — temps restant';
  }
  function overText(it) {
    return it.kind === 'ebk_session'
      ? 'Cette session est maintenant fermée.'
      : 'Le délai d\'étude est terminé : ce livre est maintenant bloqué.';
  }

  function cardHtml(it) {
    var left = new Date(it.ends_at).getTime() - nowMs();
    var over = left <= 0;
    return '<div class="dl-card ' + urgency(left) + '" data-dl-card data-start="' + esc(it.starts_at) + '" data-end="' + esc(it.ends_at) + '" data-kind="' + esc(it.kind) + '">' +
      '<div class="dl-label">⏳ ' + labelFor(it, over) + '</div>' +
      '<div class="dl-title">' + esc(it.title) + '</div>' +
      '<div class="dl-body">' + (over ? '<div class="dl-over">' + overText(it) + '</div>' :
        '<div class="dl-clock">' +
        '<div class="dl-u"><b data-u="d">0</b><small>jours</small></div>' +
        '<div class="dl-u"><b data-u="h">00</b><small>heures</small></div>' +
        '<div class="dl-u"><b data-u="m">00</b><small>min</small></div>' +
        '<div class="dl-u"><b data-u="s">00</b><small>sec</small></div></div>' +
        '<div class="dl-bar"><i></i></div>') + '</div>' +
      '<div class="dl-end">' + (over ? 'Terminé le ' : 'Jusqu\'au ') + esc(dateText(it.ends_at)) + '</div>' +
      '</div>';
  }
  function chipHtml(it) {
    return '<span class="dl-chip" data-dl-chip data-end="' + esc(it.ends_at) + '">⏳</span>';
  }

  function tick() {
    var now = nowMs();
    document.querySelectorAll('[data-dl-card]').forEach(function (c) {
      var end = new Date(c.getAttribute('data-end')).getTime();
      var start = new Date(c.getAttribute('data-start')).getTime();
      var left = end - now;
      c.className = 'dl-card ' + urgency(left);
      if (left <= 0) {
        if (!c.getAttribute('data-over')) {
          c.setAttribute('data-over', '1');
          var it = { kind: c.getAttribute('data-kind') };
          c.querySelector('.dl-label').textContent = '⏳ ' + labelFor(it, true);
          c.querySelector('.dl-body').innerHTML = '<div class="dl-over">' + overText(it) + '</div>';
        }
        return;
      }
      var p = parts(left);
      var set = function (k, v) { var e = c.querySelector('[data-u="' + k + '"]'); if (e) e.textContent = v; };
      set('d', p.d); set('h', pad(p.h)); set('m', pad(p.m)); set('s', pad(p.s));
      var bar = c.querySelector('.dl-bar i');
      if (bar && end > start) bar.style.width = Math.min(100, Math.max(0, (now - start) / (end - start) * 100)) + '%';
    });
    document.querySelectorAll('[data-dl-chip]').forEach(function (c) {
      var left = new Date(c.getAttribute('data-end')).getTime() - nowMs();
      c.className = 'dl-chip ' + urgency(left);
      if (left <= 0) { c.textContent = '⏳ Délai terminé'; return; }
      var p = parts(left);
      c.textContent = '⏳ ' + (p.d > 0 ? p.d + ' j ' : '') + pad(p.h) + ':' + pad(p.m) + ':' + pad(p.s);
    });
  }

  // ---------- Affichage ----------
  var DAY = 86400000;
  function relevant(kind) {
    var keep = kind === 'ebk_session' ? 60 * DAY : 30 * DAY;
    return items.filter(function (it) {
      if (it.kind !== kind) return false;
      return it.state === 'active' || nowMs() - new Date(it.ends_at).getTime() < keep;
    });
  }

  function showPanel() {
    var kind = onEbk ? 'ebk_session' : 'study_book';
    var list = relevant(kind);
    var old = document.getElementById('dl-panel');
    if (old) old.remove();
    if (!list.length) return;
    var box = document.createElement('div');
    box.id = 'dl-panel';
    box.className = 'dl-wrap';
    box.innerHTML = list.map(cardHtml).join('');
    if (onStudy) {
      var app = document.getElementById('app');
      if (!app) return;
      app.insertBefore(box, app.firstChild);
    } else {
      var host = document.querySelector('main') || document.querySelector('.wrap') || document.querySelector('.container') || document.querySelector('#app');
      if (host) host.insertBefore(box, host.firstChild);
      else { var h = document.querySelector('header'); if (h && h.parentNode) h.parentNode.insertBefore(box, h.nextSibling); else document.body.insertBefore(box, document.body.firstChild); }
    }
    tick();
  }

  // Étiquette « compte à rebours » sur chaque livre de la liste, et carte dans le détail d'un livre
  var decorating = false;
  function decorate() {
    if (!onStudy || decorating) return;
    decorating = true;
    try {
      var byTitle = {};
      items.forEach(function (it) { if (it.kind === 'study_book') byTitle[norm(it.title)] = it; });
      document.querySelectorAll('#books-panel .study-book').forEach(function (row) {
        if (row.querySelector('[data-dl-chip]')) return;
        var h = row.querySelector('h3');
        var it = h && byTitle[norm(h.textContent)];
        if (!it) return;
        var meta = row.querySelector('.meta');
        if (meta) meta.insertAdjacentHTML('afterend', chipHtml(it));
      });
      var bp = document.getElementById('book-panel');
      var h2 = bp && bp.querySelector('h2');
      if (bp && h2 && !bp.querySelector('[data-dl-card]')) {
        var it2 = byTitle[norm(h2.textContent)];
        if (it2) bp.insertAdjacentHTML('afterbegin', cardHtml(it2));
      }
      tick();
    } finally { decorating = false; }
  }

  function watch() {
    if (!onStudy) return;
    ['books-panel', 'book-panel'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) new MutationObserver(decorate).observe(el, { childList: true });
    });
    decorate();
  }

  function load() {
    var headers = token ? { Authorization: 'Bearer ' + token } : {};
    fetch('/api/delais/mine', { headers: headers })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        offset = new Date(d.now).getTime() - Date.now();
        items = d.items || [];
        showPanel();
        watch();
      })
      .catch(function () {});
  }

  load();
  setInterval(tick, 1000);
})();
