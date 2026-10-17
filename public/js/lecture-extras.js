// Lecteur de livres — confort de lecture
// 1) Taille du texte (A− / A+)   2) Thèmes Clair / Sépia / Sombre   3) Barre de progression du chapitre
// 4) Carte « Chapitre suivant » en fin de chapitre.  Les choix sont gardés sur l'appareil.
(function () {
  'use strict';
  if (!document.getElementById('read-panel')) return;

  var PREF_KEY = 'mna_reader_prefs';
  var SIZES = [20, 22, 24, 26, 28, 30, 32, 34];
  var prefs = { size: 26, theme: 'light' };
  try { var saved = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); if (saved) { prefs.size = saved.size || 26; prefs.theme = saved.theme || 'light'; } } catch (e) {}
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // ---------- Style ----------
  var css = [
    '.ebook-text { font-size: var(--rd-size, 26px) !important; }',
    '.rd-bar { position: fixed; top: 0; left: 0; height: 4px; width: 0; background: #c9a24b; z-index: 60; transition: width .12s linear; display: none; }',
    '.rd-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 14px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: rgba(247,241,227,.6); }',
    '.rd-tools .rd-group { display: flex; align-items: center; gap: 6px; }',
    '.rd-tools button { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 8px; padding: 7px 11px; font: inherit; font-size: 13.5px; cursor: pointer; line-height: 1; }',
    '.rd-tools button[aria-pressed="true"] { background: #c9a24b; border-color: #c9a24b; color: #16130f; font-weight: 700; }',
    '.rd-tools .rd-pct { margin-left: auto; font-size: 12.5px; opacity: .75; }',
    '.rd-next { margin: 26px 0 8px; padding: 18px; border: 1px solid var(--line); border-left: 5px solid #c9a24b; border-radius: 12px; background: rgba(247,241,227,.6); }',
    '.rd-next .rd-next-k { font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin-bottom: 4px; }',
    '.rd-next .rd-next-t { font-family: "Fraunces", Georgia, serif; font-size: 20px; line-height: 1.35; margin-bottom: 12px; }',
    '.rd-next .btn { width: 100%; }',

    /* Sépia */
    'body.rd-sepia { background: #efe3c6; }',
    '.rd-sepia .panel { background: #f8f0dc; border-color: #dccfaa; }',
    '.rd-sepia .ebook-text { color: #3b2f1c; }',
    '.rd-sepia .ebook-text h2 { color: #2a2012; }',
    '.rd-sepia .part-nav, .rd-sepia .sel-bar, .rd-sepia .rd-tools, .rd-sepia .rd-next { background: #efe2c0; border-color: #dccfaa; }',
    '.rd-sepia .part-nav select { background: #f8f0dc; }',

    /* Sombre */
    'body.rd-dark { background: #14110d; }',
    '.rd-dark .panel { background: #1d1913; border-color: #3a3226; color: #e9e0cd; }',
    '.rd-dark .panel h2, .rd-dark .panel h3 { color: #f1e8d4; }',
    '.rd-dark .panel p { color: #cdbfa3; }',
    '.rd-dark .ebook-text, .rd-dark .ebook-text p { color: #e9e0cd; }',
    '.rd-dark .ebook-text h2 { color: #f5ecd8; }',
    '.rd-dark .ebook-text h3 { color: #d9c9a6; }',
    '.rd-dark .ebook-text mark.hl { background: #6b5a1f; color: #fff; }',
    '.rd-dark .ebook-text mark.note { background: #1f4a73; color: #fff; }',
    '.rd-dark .part-nav, .rd-dark .sel-bar, .rd-dark .rd-tools, .rd-dark .rd-next { background: #26211a; border-color: #3a3226; color: #e9e0cd; }',
    '.rd-dark .part-nav select { background: #1d1913; color: #e9e0cd; border-color: #3a3226; }',
    '.rd-dark .sel-bar .sel-text, .rd-dark .part-count { color: #b9aa8c; }',
    '.rd-dark .toc-list { border-color: #3a3226; }',
    '.rd-dark .toc-group { background: #26211a; color: #e9e0cd; border-color: #3a3226; }',
    '.rd-dark .toc-item { background: #1d1913; color: #e9d9b0; border-color: #3a3226; }',
    '.rd-dark .toc-item:hover { background: #26211a; }',
    '.rd-dark .btn-ghost { color: #e9e0cd; border-color: #4a4032; background: transparent; }',
    '.rd-dark .anno-item { border-color: #3a3226; }',
    '.rd-dark .anno-item .q { color: #e9e0cd; }',
    '.rd-dark .anno-item .a-actions button { color: #e9d9b0; }'
  ].join('\n');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var bar = document.createElement('div');
  bar.className = 'rd-bar';
  document.body.appendChild(bar);

  // ---------- Application des préférences ----------
  function apply() {
    document.documentElement.style.setProperty('--rd-size', prefs.size + 'px');
    document.body.classList.remove('rd-sepia', 'rd-dark');
    if (prefs.theme === 'sepia') document.body.classList.add('rd-sepia');
    if (prefs.theme === 'dark') document.body.classList.add('rd-dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', prefs.theme === 'dark' ? '#14110d' : '#16130f');
    var tools = document.getElementById('rd-tools');
    if (tools) {
      tools.querySelectorAll('[data-theme]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.theme === prefs.theme)); });
      var dec = tools.querySelector('[data-size="-1"]'), inc = tools.querySelector('[data-size="1"]');
      if (dec) dec.disabled = prefs.size <= SIZES[0];
      if (inc) inc.disabled = prefs.size >= SIZES[SIZES.length - 1];
    }
  }

  function stepSize(dir) {
    var i = SIZES.indexOf(prefs.size);
    if (i < 0) i = SIZES.indexOf(26);
    i = Math.max(0, Math.min(SIZES.length - 1, i + dir));
    prefs.size = SIZES[i];
    savePrefs();
    apply();
    updateProgress();
  }

  // ---------- Barre d'outils et carte « chapitre suivant » ----------
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function ensureTools() {
    var view = document.getElementById('reader-view');
    var navWrap = document.getElementById('part-nav-wrap');
    if (!view || !navWrap || document.getElementById('rd-tools')) return;
    var tools = document.createElement('div');
    tools.id = 'rd-tools';
    tools.className = 'rd-tools';
    tools.innerHTML =
      '<div class="rd-group"><button type="button" data-size="-1" aria-label="Réduire le texte">A−</button><button type="button" data-size="1" aria-label="Agrandir le texte">A+</button></div>' +
      '<div class="rd-group"><button type="button" data-theme="light" aria-pressed="false">☀️ Clair</button><button type="button" data-theme="sepia" aria-pressed="false">📜 Sépia</button><button type="button" data-theme="dark" aria-pressed="false">🌙 Sombre</button></div>' +
      '<span class="rd-pct" id="rd-pct"></span>';
    navWrap.parentNode.insertBefore(tools, navWrap.nextSibling);
    tools.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.size) stepSize(Number(b.dataset.size));
      else if (b.dataset.theme) { prefs.theme = b.dataset.theme; savePrefs(); apply(); }
    });
    apply();
  }

  function renderNext() {
    var bottom = document.getElementById('part-nav-bottom');
    if (!bottom || typeof readerState === 'undefined' || !readerState || !readerState.parts) return;
    var box = document.getElementById('rd-next');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rd-next';
      box.className = 'rd-next';
      bottom.parentNode.insertBefore(box, bottom);
      box.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.go) { if (typeof gotoPart === 'function') gotoPart(Number(b.dataset.go)); }
        else if (b.dataset.toc) { if (typeof showToc === 'function') showToc(); }
      });
    }
    var st2 = readerState, parts = st2.parts, i = st2.partIdx;
    if (!parts || parts.length < 2) { box.style.display = 'none'; return; }
    box.style.display = '';
    if (i < parts.length - 1) {
      box.innerHTML = '<div class="rd-next-k">Chapitre suivant</div><div class="rd-next-t">' + esc(parts[i + 1].label) + '</div><button type="button" class="btn btn-primary" data-go="' + (i + 1) + '">Continuer la lecture ›</button>';
    } else {
      box.innerHTML = '<div class="rd-next-k">Fin du livre</div><div class="rd-next-t">Vous avez terminé ce livre. Que le Seigneur vous bénisse.</div><button type="button" class="btn btn-primary" data-toc="1">☰ Revenir à la table des matières</button>';
    }
  }

  function enhance() { ensureTools(); renderNext(); apply(); updateProgress(); }

  // ---------- Progression dans le chapitre ----------
  var ticking = false;
  function updateProgress() {
    var view = document.getElementById('reader-view');
    var text = document.getElementById('ebook-text');
    var pct = document.getElementById('rd-pct');
    if (!view || view.classList.contains('hidden') || !text) { bar.style.display = 'none'; if (pct) pct.textContent = ''; return; }
    var rect = text.getBoundingClientRect();
    var total = rect.height - window.innerHeight * 0.6;
    var done = -rect.top + window.innerHeight * 0.2;
    var p = total <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    bar.style.display = 'block';
    bar.style.width = p + '%';
    if (pct) pct.textContent = 'Lu : ' + p + ' %';
  }
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; updateProgress(); });
  }, { passive: true });
  window.addEventListener('resize', updateProgress);

  // ---------- Branchement sur le lecteur existant ----------
  function wrap(name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var r = orig.apply(this, arguments);
      try { enhance(); } catch (e) {}
      return r;
    };
  }
  wrap('renderPartNav');
  wrap('showToc');
  wrap('showReader');
  apply();
  enhance();
  // Le livre peut encore être en chargement : on réessaie dès que le lecteur apparaît
  new MutationObserver(function () { if (document.getElementById('part-nav-wrap') && !document.getElementById('rd-tools')) enhance(); })
    .observe(document.getElementById('read-panel'), { childList: true, subtree: false });
})();
