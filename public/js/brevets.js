// Envoi du brevet à l'administration (espace d'étude) + raccourci vers le classeur des brevets (administration).
// Ce script est ajouté automatiquement par le serveur : aucun fichier existant n'est modifié.
(function () {
  if (window.__mnaBrevets) return;
  window.__mnaBrevets = true;
  var path = location.pathname;
  var token = localStorage.getItem('mna_token');
  var me = null;
  try { me = JSON.parse(localStorage.getItem('mna_user') || 'null'); } catch (e) {}

  // ---------- Administration : raccourci vers le classeur des brevets ----------
  if (path === '/admin.html' && me && me.role === 'admin' && me.admin_scope !== 'limited') {
    var n = 0;
    var t2 = setInterval(function () {
      n++;
      var area = document.getElementById('admin-area');
      if (area && !area.classList.contains('hidden')) {
        clearInterval(t2);
        if (document.getElementById('brevets-admin-panel')) return;
        var panel = document.createElement('div');
        panel.className = 'panel';
        panel.id = 'brevets-admin-panel';
        panel.innerHTML =
          '<h2 style="margin-bottom:6px;">Classeur des brevets</h2>' +
          '<p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:14px;">Les brevets envoyés par les lecteurs, classés par livre étudié, avec toutes leurs références.</p>' +
          '<a href="/admin-brevets.html" class="btn btn-primary">🎓 Ouvrir le classeur des brevets</a>';
        area.insertBefore(panel, area.querySelector('.panel'));
      } else if (n > 40) {
        clearInterval(t2);
      }
    }, 250);
  }

  if (!/espace-etude/.test(path) || !token) return;

  // ---------- Espace d'étude : bouton « Envoyer mon brevet à l'administration » ----------
  var css = document.createElement('style');
  css.textContent =
    '.bv-done{display:inline-block;max-width:100%;background:#e8f6ec;color:#2a7a44;border-radius:10px;padding:10px 14px;font-size:14px;font-weight:600}' +
    '.bv-err{background:#fdeaea;color:#a33;border-radius:10px;padding:8px 12px;font-size:13.5px;margin-top:8px}' +
    '.bv-msg{margin:10px auto 0;max-width:560px;text-align:left;font-size:13.5px}' +
    '.bv-msg summary{cursor:pointer;color:var(--blue-deep,#1f5386);font-weight:600;text-align:center}' +
    '.bv-msg pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:8px 0 0;padding:12px 14px;border:1px solid var(--line,#e5dccb);border-radius:10px;background:var(--paper,#faf6ee);color:inherit}';
  document.head.appendChild(css);

  var sent = {}; // identifiant du livre -> date d'envoi

  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function dateText(iso) {
    try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }); } catch (e) { return iso; }
  }

  function boxHtml(bookId, message) {
    if (sent[bookId]) {
      return '<div class="bv-done">✅ Brevet envoyé à l\'administration le ' + esc(dateText(sent[bookId])) + '</div>' +
        (message ? '<details class="bv-msg"><summary>Voir le message envoyé</summary><pre>' + esc(message) + '</pre></details>' : '');
    }
    return '<button type="button" class="btn btn-ghost" data-bv-send="' + esc(bookId) + '">📤 Envoyer mon brevet à l\'administration</button>';
  }

  // Place le bouton juste sous « Télécharger mon brevet » dès que le détail d'un livre achevé s'affiche
  function decorate() {
    var panel = document.getElementById('book-panel');
    if (!panel || panel.querySelector('[data-bv-box]')) return;
    var cert = panel.querySelector('button[onclick^="openCertificate("]');
    if (!cert) return;
    var m = /openCertificate\((\d+)\)/.exec(cert.getAttribute('onclick') || '');
    if (!m) return;
    var box = document.createElement('div');
    box.setAttribute('data-bv-box', m[1]);
    box.style.cssText = 'margin-top:12px;text-align:center';
    box.innerHTML = boxHtml(m[1]);
    var holder = cert.parentElement;
    if (holder && holder.parentNode) holder.parentNode.insertBefore(box, holder.nextSibling);
  }

  function refreshBoxes() {
    document.querySelectorAll('[data-bv-box]').forEach(function (box) {
      if (box.querySelector('button[disabled]')) return; // envoi en cours
      box.innerHTML = boxHtml(box.getAttribute('data-bv-box'));
    });
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-bv-send]') : null;
    if (!b || b.disabled) return;
    var id = b.getAttribute('data-bv-send');
    var box = b.closest('[data-bv-box]');
    b.disabled = true;
    b.textContent = 'Envoi en cours…';
    fetch('/api/brevets/send/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: '{}'
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.message || 'Erreur');
        sent[id] = res.d.sent_at;
        if (box) box.innerHTML = boxHtml(id, res.d.message);
      })
      .catch(function (err) {
        if (!box) return;
        box.innerHTML = '<button type="button" class="btn btn-ghost" data-bv-send="' + esc(id) + '">📤 Envoyer mon brevet à l\'administration</button>' +
          '<div class="bv-err">' + esc(err && err.message ? err.message : 'Envoi impossible pour le moment. Réessayez.') + '</div>';
      });
  });

  // Détail d'un livre : le panneau est réécrit à chaque ouverture, on replace donc le bouton à chaque fois
  var panelEl = document.getElementById('book-panel');
  if (panelEl) new MutationObserver(decorate).observe(panelEl, { childList: true });
  decorate();

  fetch('/api/brevets/mine', { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (rows) {
      (rows || []).forEach(function (x) { sent[x.book_id] = x.sent_at; });
      refreshBoxes();
    })
    .catch(function () {});
})();
