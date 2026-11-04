// Envoi du brevet à l'administration (espace d'étude et École Biblique Kainos)
// + raccourci vers le classeur des brevets (administration).
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
          '<p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:14px;">Les brevets envoyés par les lecteurs (livres d\'étude) et par les étudiants de l\'École Biblique Kainos, classés avec toutes leurs références.</p>' +
          '<a href="/admin-brevets.html" class="btn btn-primary">🎓 Ouvrir le classeur des brevets</a>';
        area.insertBefore(panel, area.querySelector('.panel'));
      } else if (n > 40) {
        clearInterval(t2);
      }
    }, 250);
  }

  var isStudy = /espace-etude/.test(path);
  var isEbk = /\/ebk(\.html)?$/.test(path);
  if (!token || (!isStudy && !isEbk)) return;

  var css = document.createElement('style');
  css.textContent =
    '.bv-done{display:inline-block;max-width:100%;background:#e8f6ec;color:#2a7a44;border-radius:10px;padding:10px 14px;font-size:14px;font-weight:600}' +
    '.bv-err{background:#fdeaea;color:#a33;border-radius:10px;padding:8px 12px;font-size:13.5px;margin-top:8px}' +
    '.bv-msg{margin:10px auto 0;max-width:560px;text-align:left;font-size:13.5px}' +
    '.bv-msg summary{cursor:pointer;color:var(--blue-deep,#1f5386);font-weight:600;text-align:center}' +
    '.bv-msg pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:8px 0 0;padding:12px 14px;border:1px solid var(--line,#e5dccb);border-radius:10px;background:var(--paper,#faf6ee);color:inherit}';
  document.head.appendChild(css);

  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function dateText(iso) {
    try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }); } catch (e) { return iso; }
  }
  function doneHtml(sentAt, message) {
    return '<div class="bv-done">✅ Brevet envoyé à l\'administration le ' + esc(dateText(sentAt)) + '</div>' +
      (message ? '<details class="bv-msg"><summary>Voir le message envoyé</summary><pre>' + esc(message) + '</pre></details>' : '');
  }
  function sendHtml(attr, value) {
    return '<button type="button" class="btn btn-ghost" ' + attr + '="' + esc(value) + '">📤 Envoyer mon brevet à l\'administration</button>';
  }
  function post(url) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.message || 'Erreur'); return res.d; });
  }
  function errText(err) { return esc(err && err.message ? err.message : 'Envoi impossible pour le moment. Réessayez.'); }

  // ---------- Espace d'étude : bouton « Envoyer mon brevet à l'administration » ----------
  if (isStudy) (function () {
    var sent = {}; // identifiant du livre -> date d'envoi

    function boxHtml(bookId, message) {
      return sent[bookId] ? doneHtml(sent[bookId], message) : sendHtml('data-bv-send', bookId);
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
      post('/api/brevets/send/' + encodeURIComponent(id))
        .then(function (d) {
          sent[id] = d.sent_at;
          if (box) box.innerHTML = boxHtml(id, d.message);
        })
        .catch(function (err) {
          if (box) box.innerHTML = sendHtml('data-bv-send', id) + '<div class="bv-err">' + errText(err) + '</div>';
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

  // ---------- École Biblique Kainos : bouton sous « Ouvrir mon brevet » ----------
  if (isEbk) (function () {
    var info = { sent: false, sent_at: null, message: null };

    function boxHtml() {
      return info.sent ? doneHtml(info.sent_at, info.message) : sendHtml('data-bvk-send', '1');
    }

    // « Ouvrir mon brevet » existe à deux endroits : dans la salle de classe (#k-cert) et après le grand test (#k-certn)
    function decorate() {
      ['k-cert', 'k-certn'].forEach(function (id) {
        var btn = document.getElementById(id);
        if (!btn || !btn.parentNode) return;
        var next = btn.nextElementSibling;
        if (next && next.hasAttribute('data-bvk-box')) return;
        var box = document.createElement('div');
        box.setAttribute('data-bvk-box', '1');
        box.style.cssText = 'margin-top:12px';
        box.innerHTML = boxHtml();
        btn.parentNode.insertBefore(box, btn.nextSibling);
      });
    }

    function refreshBoxes() {
      document.querySelectorAll('[data-bvk-box]').forEach(function (box) {
        if (box.querySelector('button[disabled]')) return; // envoi en cours
        box.innerHTML = boxHtml();
      });
    }

    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-bvk-send]') : null;
      if (!b || b.disabled) return;
      var box = b.closest('[data-bvk-box]');
      b.disabled = true;
      b.textContent = 'Envoi en cours…';
      post('/api/brevets-ebk/send')
        .then(function (d) {
          info = { sent: true, sent_at: d.sent_at, message: d.message };
          refreshBoxes();
        })
        .catch(function (err) {
          if (box) box.innerHTML = sendHtml('data-bvk-send', '1') + '<div class="bv-err">' + errText(err) + '</div>';
        });
    });

    // La salle de classe est réécrite à chaque écran : on replace le bouton à chaque fois
    var boxEl = document.getElementById('k-box');
    if (boxEl) new MutationObserver(decorate).observe(boxEl, { childList: true });
    decorate();

    fetch('/api/brevets-ebk/mine', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : { sent: false }; })
      .then(function (d) { info = d || { sent: false }; refreshBoxes(); })
      .catch(function () {});
  })();
})();
