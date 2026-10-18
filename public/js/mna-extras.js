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
