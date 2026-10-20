// Ajouts (fichier nouveau) : mode sombre, économie de données, chargement fluide, section « Pour vous » de l'accueil.
// Ne retire ni ne modifie aucun contenu existant.
(function () {
  'use strict';
  try {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var home = path === '/' || path === '/index.html';
    var root = document.documentElement;
    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

    // ---------- Mode sombre (la page Bible a déjà son propre thème : « Aa » > Thème) ----------
    var dark = get('mna_dark') === '1';
    function applyDark() { root.classList.toggle('mna-dark', dark && path !== '/bible.html'); }
    applyDark();

    // ---------- Économie de données (automatique si le téléphone ou le réseau le demande) ----------
    var c = navigator.connection || {};
    var sv = get('mna_saver');
    var saver = sv === null ? !!(c.saveData || /2g$/.test(c.effectiveType || '')) : sv === '1';
    function lazyAll(scope) {
      if (!saver) return;
      var imgs = (scope || document).querySelectorAll ? (scope || document).querySelectorAll('img') : [];
      for (var i = 0; i < imgs.length; i++) {
        if (imgs[i].getAttribute('loading') !== 'lazy' && !imgs[i].closest('header, #mna-appbar, .mna-me')) imgs[i].setAttribute('loading', 'lazy');
        imgs[i].setAttribute('decoding', 'async');
      }
    }
    function applySaver() { root.classList.toggle('mna-saver', saver); lazyAll(document); }
    applySaver();

    // ---------- Boutons ronds à côté du globe ----------
    var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
    var BOLT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
    function mkBtn(icon, label, on, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'mna-tx'; b.innerHTML = icon;
      b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () { var s = fn(); b.setAttribute('aria-pressed', s ? 'true' : 'false'); });
      return b;
    }
    var n = 0;
    var iv = setInterval(function () {
      var band = document.querySelector('.mna-tr');
      if (band && !band.querySelector('.mna-tx')) {
        band.appendChild(mkBtn(MOON, 'Mode sombre', dark, function () { dark = !dark; put('mna_dark', dark ? '1' : '0'); applyDark(); return dark; }));
        band.appendChild(mkBtn(BOLT, 'Économie de données', saver, function () {
          saver = !saver; put('mna_saver', saver ? '1' : '0'); applySaver();
          if (!saver) location.reload();   // les images retenues reviennent
          return saver;
        }));
        clearInterval(iv);
      } else if (++n > 24) clearInterval(iv);
    }, 250);

    // ---------- Chargement fluide ----------
    var LOADING = /^(chargement|loading)/i;
    var pending = false;
    function scan() {
      pending = false;
      var done = document.querySelectorAll('.mna-skel');
      for (var i = 0; i < done.length; i++) if (!LOADING.test((done[i].textContent || '').trim())) done[i].classList.remove('mna-skel');
      var els = document.querySelectorAll('div, p, td, li');
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (el.children.length || el.classList.contains('mna-skel')) continue;
        var t = (el.textContent || '').trim();
        if (t.length < 60 && LOADING.test(t)) el.classList.add('mna-skel');
      }
      lazyAll(document);
    }
    function queue() { if (!pending) { pending = true; (window.requestAnimationFrame || setTimeout)(scan); } }
    new MutationObserver(queue).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();


    // ---------- Bible : lecture selon le plan de 90 jours (page ouverte depuis le plan : ?plan=1) ----------
    // « Suivant » avance dans les chapitres du jour ; au dernier chapitre, « Jour terminé ✓ » valide le jour et revient au plan.
    if (path === '/bible.html' && /[?&]plan=1/.test(location.search)) {
      var PK = 'mna_plan90', flat = [], days = [], dayOf = [];
      var todayStr = function () { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); };
      var readPlan = function () { try { return Object.assign({ start: null, done: [] }, JSON.parse(get(PK) || '{}')); } catch (e) { return { start: null, done: [] }; } };
      var buildPlan = function () {
        flat = []; days = []; dayOf = [];
        state.books.forEach(function (b) { b.chapters.forEach(function (c) { flat.push({ b: b.id, c: c }); }); });
        var N = flat.length;
        for (var d = 1; d <= 90; d++) {
          var s = Math.floor((d - 1) * N / 90), e = Math.floor(d * N / 90);
          days.push([s, e]);
          for (var k = s; k < e; k++) dayOf[k] = d;
        }
      };
      var planUi = function () {
        var dt = state.data; if (!dt) return;
        var idx = -1;
        for (var i = 0; i < flat.length; i++) if (flat[i].b === dt.book.id && flat[i].c === dt.chapter) { idx = i; break; }
        var bar = document.getElementById('mna-planbar');
        if (!bar) {
          bar = document.createElement('div'); bar.id = 'mna-planbar';
          var tb = document.querySelector('.toolbar');
          tb.parentNode.insertBefore(bar, tb.nextSibling);
        }
        var day = idx >= 0 ? dayOf[idx] : 0;
        if (!day) { bar.innerHTML = '<span>Ce chapitre n\u2019est pas dans le plan.</span><a href="/plan-90-jours.html">Le plan</a>'; return; }
        var r = days[day - 1], pos = idx - r[0] + 1, tot = r[1] - r[0];
        bar.innerHTML = '<span>\uD83D\uDCC5 Jour <b>' + day + '</b> sur 90 \u00b7 chapitre ' + pos + ' sur ' + tot + '</span><a href="/plan-90-jours.html">Le plan</a>';
        var nx = document.getElementById('btn-next'), pv = document.getElementById('btn-prev');
        pv.disabled = pos <= 1; pv.textContent = '\u2039 Pr\u00e9c\u00e9dent';
        pv.onclick = function () { if (pos > 1) loadChapter(flat[idx - 1].b, flat[idx - 1].c); };
        nx.disabled = false;
        if (pos < tot) {
          nx.textContent = 'Suivant \u203a';
          nx.onclick = function () { loadChapter(flat[idx + 1].b, flat[idx + 1].c); };
        } else {
          nx.textContent = 'Jour termin\u00e9 \u2713';
          nx.onclick = function () {
            var p = readPlan();
            if (!p.start) p.start = todayStr();
            if (p.done.indexOf(day) < 0) p.done.push(day);
            put(PK, JSON.stringify(p));
            location.href = '/plan-90-jours.html';
          };
        }
      };
      var pt = 0, pw = setInterval(function () {
        if (typeof state !== 'undefined' && state.books && state.books.length && state.data) {
          clearInterval(pw); buildPlan();
          var orig = window.loadChapter;
          window.loadChapter = function () { var r = orig.apply(this, arguments); return Promise.resolve(r).then(planUi); };
          planUi();
        } else if (++pt > 80) clearInterval(pw);
      }, 250);
    }

    // ---------- Accueil : section « Pour vous » ----------
    if (home) {

      // Boutons en double : un bouton de l'accueil qui fait déjà ce que fait le menu (ou la rangée du haut) est masqué
      var MENU = ['/', '/bible.html', '/catalogue.html', '/espace-etude.html', '/actualites.html', '/assistant.html', '/a-propos.html', '/audio.html', '/login.html'];
      var dn = 0;
      var dv = setInterval(function () {
        var btns = document.querySelectorAll('.hero a.btn, .hero .actions a');
        for (var i = 0; i < btns.length; i++) {
          var p = '';
          try { p = new URL(btns[i].getAttribute('href') || '', location.origin).pathname; } catch (e) {}
          if (p && p !== '/index.html' && MENU.indexOf(p) !== -1 && !btns[i].closest('.lsm-account, .mna-cards')) btns[i].classList.add('mna-hide');
        }
        // « Installer » : déjà présent dans la barre d'onglets du téléphone
        if (document.querySelector('#mna-appbar .mna-tab-install')) {
          var ib = document.getElementById('install-btn'), ih = document.getElementById('ios-install-hint');
          if (ib) ib.classList.add('mna-hide');
          if (ih) ih.classList.add('mna-hide');
        }
        if (++dn > 30) clearInterval(dv);
      }, 400);
      var tries = 0;
      (function mount() {
        var hero = document.querySelector('.hero');
        if (document.getElementById('mna-sec')) return;
        if (!hero || (!hero.querySelector('.lsm-carousel') && tries++ < 20)) return setTimeout(mount, 250);
        var last = null;
        try { last = JSON.parse(get('bible_last') || 'null'); } catch (e) {}
        function card(href, ic, title, sub, cls) {
          return '<a class="mna-c' + (cls ? ' ' + cls : '') + '" href="' + href + '"><span class="mna-ic" aria-hidden="true">' + ic + '</span><b>' + title + '</b><i>' + sub + '</i></a>';
        }
        var sec = document.createElement('section');
        sec.className = 'section mna-sec'; sec.id = 'mna-sec';
        sec.innerHTML = '<div class="container"><h2>Pour vous</h2><div class="mna-cards">' +
          (last && last.book && last.chapter ? card('/bible.html?livre=' + last.book + '&chapitre=' + last.chapter, '▶️', 'Reprendre ma lecture', 'Là où vous vous êtes arrêté dans la Bible', 'wide') : '') +
          card('/plan-90-jours.html', '📅', 'La Bible en 90 jours', 'Un plan simple, jour après jour') +
          card('/soutien.html', '🤝', 'Soutenir et agenda', 'Dons et événements à venir') +
          '</div></div>';
        hero.parentNode.insertBefore(sec, hero.nextSibling);
      })();
    }
  } catch (e) { /* ne jamais empêcher le site de fonctionner */ }
})();
