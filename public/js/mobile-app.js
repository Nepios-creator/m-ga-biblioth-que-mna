// Expérience « application » sur téléphone : onglets toujours visibles, installation sur l'écran d'accueil.
// Sur ordinateur (écran de plus de 820 px) ce script ne fait rien du tout.
(function () {
  'use strict';
  try {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    // Le lecteur de livre et la page de vérification gardent leur propre affichage
    if (path === '/lecture.html' || path === '/verification.html') return;

    var mq = window.matchMedia('(max-width: 820px)');
    var started = false;
    var deferredPrompt = null;
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

    if (standalone) document.documentElement.classList.add('mna-standalone');

    function start() {
      if (started || !mq.matches) return;
      started = true;
      boot();
    }
    start();
    if (mq.addEventListener) mq.addEventListener('change', start);
    else if (mq.addListener) mq.addListener(start);
  } catch (e) { /* ne jamais empêcher le site de fonctionner */ }

  // ---------------------------------------------------------------------------
  function boot() {
    addMeta('mobile-web-app-capable', 'yes');
    addMeta('apple-mobile-web-app-capable', 'yes');
    addMeta('apple-mobile-web-app-status-bar-style', 'black');
    addMeta('apple-mobile-web-app-title', 'MNA Bibliothèque');

    // L'événement d'installation peut arriver à tout moment : on l'écoute dès le départ
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      offerInstall();
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      try { localStorage.setItem('mna_installed', '1'); } catch (e) {}
      removeInstallUi();
      var old = document.getElementById('install-btn');
      if (old) old.style.display = 'none';
    });

    // On attend que les styles soient chargés avant d'afficher la barre : pas de flash
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/mobile.css';
    link.onload = build;
    link.onerror = function () { /* sans styles, on garde l'affichage d'origine */ };
    document.head.appendChild(link);
  }

  function addMeta(name, content) {
    if (document.querySelector('meta[name="' + name + '"]')) return;
    var m = document.createElement('meta');
    m.name = name; m.content = content;
    document.head.appendChild(m);
  }

  // ---------------------------------------------------------------------------
  function build() {
    if (document.getElementById('mna-appbar')) return;
    var path = location.pathname.replace(/\/+$/, '') || '/';

    var token = '', user = null;
    try { token = localStorage.getItem('mna_token') || ''; user = JSON.parse(localStorage.getItem('mna_user') || 'null'); } catch (e) {}
    var isAdmin = !!(token && user && user.role === 'admin');

    var tabs = [
      { href: '/', icon: '🏠', label: 'Accueil', pages: ['/', '/index.html'] },
      { href: '/bible.html', icon: '📖', label: 'Bible', pages: ['/bible.html'] },
      { href: '/actualites.html', icon: '📰', label: 'Actualités', pages: ['/actualites.html', '/actualite.html'] },
      { href: '/espace-etude.html', icon: '🎓', label: "Espace d'étude", pages: ['/espace-etude.html'] },
      { href: '/catalogue.html', icon: '📚', label: 'Catalogue', pages: ['/catalogue.html'] },
      { href: '/assistant.html', icon: '💬', label: 'Assistant IA', pages: ['/assistant.html'] },
      { href: '/a-propos.html', icon: 'ℹ️', label: 'À propos', pages: ['/a-propos.html'] }
    ];
    if (isAdmin) tabs.push({ href: '/admin.html', icon: '⚙️', label: 'Admin', prefix: '/admin' });
    tabs.push({ href: '/login.html', icon: '👤', label: token ? 'Mon compte' : 'Connexion', pages: ['/login.html'] });

    function isOn(t) {
      if (t.prefix) return path.indexOf(t.prefix) === 0;
      return t.pages.indexOf(path) !== -1;
    }
    var html = tabs.map(function (t) {
      var on = isOn(t);
      return '<a class="mna-tab' + (on ? ' on' : '') + '" href="' + t.href + '"' + (on ? ' aria-current="page"' : '') + '>' +
        '<span class="mna-ic" aria-hidden="true">' + t.icon + '</span><span>' + t.label + '</span></a>';
    }).join('');

    var bar = document.createElement('div');
    bar.id = 'mna-appbar';
    bar.innerHTML =
      '<a class="mna-logo" href="/" aria-label="Accueil"><img src="/icons/icon-192.png" alt="" width="40" height="40"></a>' +
      '<div class="mna-tabs" role="navigation" aria-label="Navigation principale">' + html + '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.documentElement.classList.add('mna-on');

    centerActiveTab(bar);
    offsetStickyElements();
    audioTab(bar);
    installSetup();
  }

  // La page ouverte est toujours visible au milieu de la barre
  function centerActiveTab(bar) {
    requestAnimationFrame(function () {
      var box = bar.querySelector('.mna-tabs');
      var on = bar.querySelector('.mna-tab.on');
      if (!box || !on) return;
      box.scrollLeft = on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2;
    });
  }

  // Onglet « Livres audio » seulement si la page existe (comme dans le menu ordinateur)
  function audioTab(bar) {
    function add() {
      var tabs = bar.querySelector('.mna-tabs');
      var ref = tabs && tabs.querySelector('a[href="/a-propos.html"]');
      if (!tabs || tabs.querySelector('a[href="/audio.html"]')) return;
      var a = document.createElement('a');
      var on = location.pathname === '/audio.html';
      a.className = 'mna-tab' + (on ? ' on' : '');
      a.href = '/audio.html';
      a.innerHTML = '<span class="mna-ic" aria-hidden="true">🎧</span><span>Livres audio</span>';
      tabs.insertBefore(a, ref || null);
    }
    var cached = null;
    try { cached = sessionStorage.getItem('mna_audio'); } catch (e) {}
    if (cached === '1') { add(); return; }
    if (cached === '0') return;
    fetch('/audio.html', { method: 'HEAD' }).then(function (r) {
      try { sessionStorage.setItem('mna_audio', r.ok ? '1' : '0'); } catch (e) {}
      if (r.ok) add();
    }).catch(function () {});
  }

  // Les éléments « collants » des pages (barres d'outils, etc.) se placent désormais sous la barre d'onglets
  function offsetStickyElements() {
    var out = [];
    function norm(v) { v = String(v).trim(); return /^-?0+(\.0+)?$/.test(v) ? '0px' : v; }
    function prefix(sel) {
      return sel.split(',').map(function (s) { return 'html.mna-on ' + s.trim(); }).join(',');
    }
    function visit(rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        try {
          if (r.styleSheet) { visit(r.styleSheet.cssRules); continue; } // @import
          if (r.cssRules && !r.selectorText) {                          // @media, @supports…
            if (r.media && !window.matchMedia(r.media.mediaText).matches) continue;
            visit(r.cssRules);
            continue;
          }
          if (!r.selectorText || !r.style) continue;
          var sel = r.selectorText.trim();
          if (sel === 'header' || sel.indexOf('mna-') !== -1) continue;
          var pos = r.style.position, top = r.style.top;
          if (!top || top === 'auto') continue;
          var z = parseInt(r.style.zIndex, 10) || 0;
          var sticky = pos === 'sticky';
          var fixedTop = pos === 'fixed' && !r.style.bottom && !r.style.height && !r.style.inset && z < 40;
          if (sticky || fixedTop) out.push(prefix(sel) + '{top:calc(var(--mna-bar-h) + ' + norm(top) + ') !important}');
        } catch (e) { /* feuille de style d'un autre site : ignorée */ }
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      try { visit(document.styleSheets[s].cssRules); } catch (e) {}
    }
    if (!out.length) return;
    var st = document.createElement('style');
    st.id = 'mna-offsets';
    st.textContent = '@media (max-width: 820px){' + out.join('') + '}';
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------------------
  // Installation sur l'écran d'accueil (application)
  function installedAlready() {
    try { return localStorage.getItem('mna_installed') === '1'; } catch (e) { return false; }
  }
  function isStandalone() { return document.documentElement.classList.contains('mna-standalone'); }

  function installSetup() {
    if (isStandalone() || installedAlready()) return;
    if (isIOS()) offerInstall();
    else setTimeout(offerInstall, 5000); // autres navigateurs : consignes générales si rien n'est arrivé entre-temps
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function offerInstall() {
    if (isStandalone() || installedAlready()) return;
    var tabs = document.querySelector('#mna-appbar .mna-tabs');
    if (!tabs) return;
    if (!tabs.querySelector('.mna-tab-install')) {
      var b = document.createElement('a');
      b.className = 'mna-tab mna-tab-install';
      b.href = '#installer';
      b.innerHTML = '<span class="mna-ic" aria-hidden="true">📲</span><span>Installer</span>';
      b.addEventListener('click', function (e) { e.preventDefault(); runInstall(); });
      tabs.appendChild(b);
    }
    // Invitation discrète, une seule fois par semaine, sur la page d'accueil
    var p = location.pathname.replace(/\/+$/, '') || '/';
    if (p !== '/' && p !== '/index.html') return;
    var last = 0;
    try { last = Number(localStorage.getItem('mna_install_dismissed') || 0); } catch (e) {}
    if (Date.now() - last < 7 * 86400000) return;
    if (document.getElementById('mna-install')) return;
    setTimeout(function () {
      if (isStandalone() || installedAlready() || document.getElementById('mna-install')) return;
      var box = document.createElement('div');
      box.id = 'mna-install';
      box.className = 'show';
      box.setAttribute('role', 'dialog');
      box.innerHTML =
        '<div class="mna-i-text"><strong>Installer l\'application</strong>Ouvrez la bibliothèque comme une vraie application, depuis votre écran d\'accueil.</div>' +
        '<button type="button" class="mna-i-go">Installer</button>' +
        '<button type="button" class="mna-i-x" aria-label="Plus tard">✕</button>';
      document.body.appendChild(box);
      box.querySelector('.mna-i-go').addEventListener('click', function () { removeBanner(); runInstall(); });
      box.querySelector('.mna-i-x').addEventListener('click', function () {
        try { localStorage.setItem('mna_install_dismissed', String(Date.now())); } catch (e) {}
        removeBanner();
      });
    }, 3500);
  }

  function runInstall() {
    if (deferredPrompt) {
      var ev = deferredPrompt;
      deferredPrompt = null;
      ev.prompt();
      if (ev.userChoice) ev.userChoice.then(function (c) { if (c && c.outcome === 'accepted') removeInstallUi(); });
      return;
    }
    showSheet();
  }

  function showSheet() {
    if (document.getElementById('mna-ios')) return;
    var steps = isIOS()
      ? '<li>Touchez le bouton <b>Partager</b> ⬆️ en bas de l\'écran.</li><li>Choisissez <b>« Sur l\'écran d\'accueil »</b>.</li><li>Touchez <b>Ajouter</b>.</li>'
      : '<li>Ouvrez le menu <b>⋮</b> de votre navigateur.</li><li>Choisissez <b>« Installer l\'application »</b> ou <b>« Ajouter à l\'écran d\'accueil »</b>.</li><li>Confirmez.</li>';
    var note = isIOS() ? 'Depuis Facebook ou WhatsApp, ouvrez d\'abord le site dans Safari.' : 'L\'icône apparaîtra sur votre écran d\'accueil, comme une application.';
    var s = document.createElement('div');
    s.id = 'mna-ios';
    s.className = 'show';
    s.setAttribute('role', 'dialog');
    s.setAttribute('aria-modal', 'true');
    s.innerHTML = '<div class="mna-sheet"><h3>Installer l\'application</h3><ol>' + steps + '</ol><p>' + note + '</p><button type="button">J\'ai compris</button></div>';
    document.body.appendChild(s);
    function close() { if (s.parentNode) s.parentNode.removeChild(s); }
    s.querySelector('button').addEventListener('click', close);
    s.addEventListener('click', function (e) { if (e.target === s) close(); });
  }

  function removeBanner() {
    var b = document.getElementById('mna-install');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }
  function removeInstallUi() {
    removeBanner();
    var t = document.querySelector('#mna-appbar .mna-tab-install');
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }
})();
