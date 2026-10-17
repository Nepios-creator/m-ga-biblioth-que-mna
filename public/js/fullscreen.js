// Plein écran permanent : une fois activé, il reste actif sur TOUTES les pages, jusqu'à ce que vous le désactiviez.
//
// Pourquoi ce n'était pas le cas : les navigateurs quittent automatiquement le plein écran à chaque changement de page.
// Solution : au moment d'activer le plein écran, la page ouverte devient une « coque » qui contient le site dans un cadre
// plein écran. Les pages changent à l'intérieur du cadre ; la coque, elle, ne change jamais, donc le plein écran reste.
// Le réglage est mémorisé : si le navigateur l'interrompt (retour arrière, rechargement), il reprend au prochain toucher.
(function () {
  'use strict';
  try {
    var KEY = 'mna_fullscreen';
    var T = window, framed = false;
    try { if (window.top !== window) { void window.top.document.body; T = window.top; framed = true; } } catch (e) { T = window; framed = false; }
    var D = T.document, root = D.documentElement;

    function supported() { return !!(root.requestFullscreen || root.webkitRequestFullscreen); }
    function isFS() { return !!(D.fullscreenElement || D.webkitFullscreenElement); }
    function request() { var f = root.requestFullscreen || root.webkitRequestFullscreen; return f ? f.call(root) : null; }
    function leave() {
      var f = D.exitFullscreen || D.webkitExitFullscreen;
      if (f && isFS()) { try { var p = f.call(D); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
    }
    function flagOn() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
    function setFlag(on) { try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch (e) {} }
    function shell() { return D.getElementById('mna-shell'); }

    // ---------- La coque : un cadre plein écran qui ne se recharge jamais ----------
    function ensureShell(url) {
      var f = shell();
      if (f) { if (url) f.src = url; return f; }
      var st = D.createElement('style');
      st.id = 'mna-shell-css';
      st.textContent =
        'html.mna-shell-on,html.mna-shell-on body{overflow:hidden !important;height:100% !important;margin:0 !important;padding:0 !important}' +
        'html.mna-shell-on body > *:not(#mna-shell){display:none !important}' +
        '#mna-shell{position:fixed;top:0;left:0;width:100%;height:100%;border:0;background:#faf6ee;z-index:2147483000;display:block !important}';
      D.head.appendChild(st);
      f = D.createElement('iframe');
      f.id = 'mna-shell';
      f.title = 'Bibliothèque MNA';
      f.setAttribute('allow', 'fullscreen; clipboard-write; web-share');
      f.setAttribute('allowfullscreen', '');
      f.src = url || location.href;
      f.addEventListener('load', function () {
        // L'adresse et le titre de la coque suivent la page affichée : un rechargement rouvre la bonne page
        try {
          var w = f.contentWindow;
          T.history.replaceState(null, '', w.location.pathname + w.location.search + w.location.hash);
          if (w.document.title) D.title = w.document.title;
        } catch (e) {}
      });
      D.body.appendChild(f);
      root.classList.add('mna-shell-on');
      return f;
    }
    function currentUrl() {
      if (framed) return window.location.href;
      var f = shell();
      try { if (f && f.contentWindow) return f.contentWindow.location.href; } catch (e) {}
      return location.href;
    }

    // ---------- Activer / désactiver (seulement sur votre demande) ----------
    function enable(go) {
      setFlag(true);
      var p = null;
      try { p = request(); } catch (e) {}
      if (p && p.catch) p.catch(function () {});
      if (!framed) ensureShell(go);
      labels();
    }
    function disable() {
      setFlag(false);
      root.setAttribute('data-mna-leaving', '1');
      var hadShell = !!shell();
      var cur = currentUrl();
      leave();
      if (hadShell) { T.location.replace(cur); return; } // on revient à la page normale, au même endroit
      setTimeout(function () { root.removeAttribute('data-mna-leaving'); }, 600);
      labels();
    }
    function toggle() { if (flagOn()) disable(); else enable(); }

    // ---------- Textes des boutons ----------
    function labels() {
      var on = flagOn() && supported();
      var heads = document.querySelectorAll('.card h3');
      for (var i = 0; i < heads.length; i++) {
        if (heads[i].textContent.trim() !== 'Plein écran') continue;
        var l = heads[i].parentNode.querySelector('.try-link');
        if (l) l.textContent = on ? 'Quitter le plein écran ✕' : 'Passer en plein écran →';
      }
      var rb = document.getElementById('btn-fullscreen');
      if (rb) rb.textContent = on ? '✕ Quitter le plein écran' : '⛶ Plein écran';
      var t = document.querySelector('#mna-appbar .mna-tab-fs');
      if (t) t.lastChild.textContent = on ? 'Quitter le plein écran' : 'Plein écran';
    }
    function fsCard(target) {
      // Bouton « Plein écran » du lecteur de livres
      var btn = target && target.closest ? target.closest('#btn-fullscreen') : null;
      if (btn) return btn;
      var c = target && target.closest ? target.closest('.card') : null;
      if (!c) return null;
      var h = c.querySelector('h3');
      return h && h.textContent.trim() === 'Plein écran' ? c : null;
    }

    // ---------- Gestes ----------
    function onClick(e) {
      // La carte « Plein écran » de l'accueil pilote ce mode permanent
      if (supported() && fsCard(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggle();
        return;
      }
      // Plein écran interrompu par le navigateur : il reprend au premier toucher
      if (e.target && e.target.closest && e.target.closest('.mna-tab-fs')) return;
      if (!flagOn() || !supported() || isFS()) return;
      var go = null;
      if (!framed && !shell()) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        var h = a ? a.getAttribute('href') : '';
        if (a && h && h.charAt(0) !== '#' && a.origin === location.origin && !a.target && !a.hasAttribute('download') && !/^(mailto|tel):/i.test(h)) {
          e.preventDefault(); e.stopPropagation();
          go = a.href;
        }
      }
      enable(go);
    }
    function onKey(e) {
      if ((e.key === 'Enter' || e.key === ' ') && supported() && fsCard(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggle();
      }
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);

    // Le navigateur a quitté le plein écran (la coque, elle, reste en place)
    if (!framed) {
      var onChange = function () {
        if (isFS()) { labels(); return; }
        if (!flagOn() || root.hasAttribute('data-mna-leaving')) { labels(); return; }
        // Sur ordinateur, Échap est une décision de votre part : le mode se désactive.
        // Sur téléphone (retour arrière, geste système) il reste actif et reprend au prochain toucher.
        var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (!touch) { disable(); return; }
        labels();
      };
      D.addEventListener('fullscreenchange', onChange);
      D.addEventListener('webkitfullscreenchange', onChange);
    }
    document.addEventListener('fullscreenchange', function () { setTimeout(labels, 0); });

    // ---------- Onglet « Plein écran » dans la barre mobile (accessible sur toutes les pages) ----------
    function addTab() {
      if (!supported()) return true;
      var tabs = document.querySelector('#mna-appbar .mna-tabs');
      if (!tabs) return false;
      if (tabs.querySelector('.mna-tab-fs')) return true;
      var a = document.createElement('a');
      a.className = 'mna-tab mna-tab-fs';
      a.href = '#plein-ecran';
      a.innerHTML = '<span class="mna-ic" aria-hidden="true">⛶</span><span></span>';
      a.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
      var inst = tabs.querySelector('.mna-tab-install');
      tabs.insertBefore(a, inst || null);
      labels();
      return true;
    }
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (addTab() || tries > 40) clearInterval(timer);
    }, 250);

    // La page d'accueil crée ses boutons un peu après le chargement : on remet les textes à jour
    [0, 400, 1200, 2500].forEach(function (ms) { setTimeout(labels, ms); });
  } catch (err) { /* ne jamais empêcher le site de fonctionner */ }
})();
