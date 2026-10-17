// Utilisation sans connexion :
//  - indique discrètement quand le téléphone est hors connexion ;
//  - télécharge la Bible en arrière-plan (quand il y a internet) pour qu'elle s'ouvre sans connexion ;
//  - efface les données privées gardées pour le hors-connexion quand on se déconnecte.
(function () {
  'use strict';
  try {
    // ---------- Déconnexion : on efface les listes privées gardées sur le téléphone ----------
    function clearPrivate() {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('mna-clear-private');
      } catch (e) {}
    }
    var origRemove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (k) {
      try { if (this === window.localStorage && k === 'mna_token') clearPrivate(); } catch (e) {}
      return origRemove.apply(this, arguments);
    };
    var origClear = Storage.prototype.clear;
    Storage.prototype.clear = function () {
      try { if (this === window.localStorage) clearPrivate(); } catch (e) {}
      return origClear.apply(this, arguments);
    };

    // ---------- Message « hors connexion » / information ----------
    var css = document.createElement('style');
    css.textContent =
      '#mna-net{position:fixed;left:50%;transform:translateX(-50%);top:calc(var(--mna-bar-h,0px) + 8px);z-index:36;max-width:92vw;box-sizing:border-box;' +
      'padding:9px 16px;border-radius:999px;background:#16130f;color:#f6eedb;border:1px solid #c9a24b;font:600 14px/1.3 "Inter",system-ui,sans-serif;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.35);text-align:center;display:none}#mna-net.show{display:block}';
    document.head.appendChild(css);
    var box = null, hideTimer = null;
    function say(text, ms) {
      if (!box) { box = document.createElement('div'); box.id = 'mna-net'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
      box.textContent = text;
      box.classList.add('show');
      clearTimeout(hideTimer);
      if (ms) hideTimer = setTimeout(function () { box.classList.remove('show'); }, ms);
    }
    function hide() { if (box) box.classList.remove('show'); }
    window.addEventListener('offline', function () { say('📴 Hors connexion — le contenu enregistré reste disponible'); });
    window.addEventListener('online', function () { say('✅ De retour en ligne', 2500); startPrefetch(); });
    if (!navigator.onLine) say('📴 Hors connexion — le contenu enregistré reste disponible');

    // ---------- Téléchargement de la Bible pour la lecture sans connexion ----------
    var running = false;
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    async function prefetchBible() {
      if (running) return;
      var token = null;
      try { token = localStorage.getItem('mna_token'); } catch (e) {}
      if (!token || !navigator.onLine || !('caches' in window)) return;
      var conn = navigator.connection || {};
      if (conn.saveData) return;
      if (!(navigator.serviceWorker && navigator.serviceWorker.controller)) return;
      var last = 0, done = false;
      try { last = Number(localStorage.getItem('mna_bible_checked') || 0); done = localStorage.getItem('mna_bible_complete') === '1'; } catch (e) {}
      if (done && Date.now() - last < 12 * 3600 * 1000) return;
      running = true;
      try {
        var H = { Authorization: 'Bearer ' + token };
        var r = await fetch('/api/bible/books', { headers: H });
        if (!r.ok) return;
        var books = await r.json();
        var urls = [];
        books.forEach(function (b) { (b.chapters || []).forEach(function (c) { urls.push('/api/bible/books/' + b.id + '/chapters/' + c); }); });
        var todo = [];
        for (var i = 0; i < urls.length; i++) {
          var hit = await caches.match(urls[i], { cacheName: 'mna-bible-v1' });
          if (!hit) todo.push(urls[i]);
        }
        var next = 0, failed = false;
        async function worker() {
          while (next < todo.length && !failed && navigator.onLine) {
            var u = todo[next++];
            try {
              var rr = await fetch(u, { headers: H });
              if (rr.status === 401) failed = true;
            } catch (e) { failed = true; }
            await sleep(40);
          }
        }
        await Promise.all([worker(), worker(), worker()]);
        if (!failed && next >= todo.length) {
          try { localStorage.setItem('mna_bible_checked', String(Date.now())); localStorage.setItem('mna_bible_complete', '1'); } catch (e) {}
          if (todo.length >= 5) say('📖 Bible enregistrée : elle s\'ouvre aussi sans internet', 4000);
        }
      } catch (e) {
      } finally { running = false; }
    }
    function startPrefetch() { setTimeout(prefetchBible, 3000); }

    window.addEventListener('load', function () {
      if (navigator.serviceWorker) {
        if (navigator.serviceWorker.controller) startPrefetch();
        else navigator.serviceWorker.addEventListener('controllerchange', startPrefetch);
      }
    });
  } catch (err) { /* ne jamais empêcher le site de fonctionner */ }
})();
