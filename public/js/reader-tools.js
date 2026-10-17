// Confort commun à toute l'application :
//  1) zoom à deux doigts (agrandir jusqu'à 5 fois) sur toutes les pages, en plein écran ou non ;
//     la page ne se dézoome JAMAIS toute seule : elle remplit toujours la largeur de l'écran, comme une application ;
//  2) pendant la lecture d'un livre : boutons A− / A+ pour changer la taille du texte, comme dans la Bible.
(function () {
  'use strict';
  try {
    // ---------- 1) Affichage « application » + zoom à deux doigts ----------
    // minimum-scale=1 : le navigateur ne peut plus réduire la page pour la faire tenir (aspect « ordinateur »)
    var VIEWPORT = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover';
    var vp = document.querySelector('meta[name="viewport"]');
    if (!vp) { vp = document.createElement('meta'); vp.name = 'viewport'; document.head.appendChild(vp); }
    if (vp.getAttribute('content') !== VIEWPORT) vp.setAttribute('content', VIEWPORT);
    var zs = document.createElement('style');
    zs.id = 'mna-zoom-css';
    zs.textContent =
      'html,body{touch-action:pan-x pan-y pinch-zoom}' +
      // Aucun élément ne peut déborder de l'écran : la page garde la largeur du téléphone
      'html,body{max-width:100%;overflow-x:hidden}' +
      'img,video,canvas,svg,iframe:not(#mna-shell){max-width:100%}';
    document.head.appendChild(zs);

    // ---------- 2) Taille du texte des livres ----------
    var KEY = 'mna_book_size', MIN = 16, MAX = 48, STEP = 2;
    var pill = null, valEl = null, sizeStyle = null;

    function stored() {
      try { var v = parseInt(localStorage.getItem(KEY), 10); return v >= MIN && v <= MAX ? v : null; } catch (e) { return null; }
    }
    function textEl() { return document.getElementById('ebook-text') || document.querySelector('.ebook-text'); }
    function current() {
      var el = textEl();
      return el ? Math.round(parseFloat(window.getComputedStyle(el).fontSize)) || 26 : 26;
    }
    function apply(px) {
      if (!sizeStyle) {
        sizeStyle = document.createElement('style');
        sizeStyle.id = 'mna-read-css';
        document.head.appendChild(sizeStyle);
      }
      sizeStyle.textContent = px ? '.ebook-text{font-size:' + px + 'px !important}' : '';
    }
    function setSize(px) {
      px = Math.max(MIN, Math.min(MAX, px));
      try { localStorage.setItem(KEY, String(px)); } catch (e) {}
      apply(px);
      showValue();
    }
    function resetSize() {
      try { localStorage.removeItem(KEY); } catch (e) {}
      apply(null);
      showValue();
    }
    function showValue() { if (valEl) valEl.textContent = String(stored() || current()); }

    var saved = stored();
    if (saved) apply(saved);

    function build() {
      var css = document.createElement('style');
      css.textContent =
        '#mna-textsize{display:none;position:fixed;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:35;align-items:center;' +
        'background:#16130f;border:1.5px solid #c9a24b;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.35);overflow:hidden}' +
        '#mna-textsize.show{display:flex}' +
        '#mna-textsize button{min-width:48px;height:48px;border:0;background:transparent;color:#f6eedb;font:700 18px "Inter",system-ui,sans-serif;cursor:pointer;touch-action:manipulation}' +
        '#mna-textsize button:active{background:rgba(201,162,75,.35)}' +
        '#mna-textsize .mna-ts-val{min-width:42px;font-size:14px;color:#e8c978;border-left:1px solid rgba(255,255,255,.18);border-right:1px solid rgba(255,255,255,.18)}';
      document.head.appendChild(css);
      pill = document.createElement('div');
      pill.id = 'mna-textsize';
      pill.setAttribute('role', 'group');
      pill.setAttribute('aria-label', 'Taille du texte');
      pill.innerHTML =
        '<button type="button" data-d="-1" aria-label="Réduire le texte">A−</button>' +
        '<button type="button" class="mna-ts-val" aria-label="Revenir à la taille normale"></button>' +
        '<button type="button" data-d="1" aria-label="Agrandir le texte">A+</button>';
      valEl = pill.querySelector('.mna-ts-val');
      pill.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button');
        if (!b) return;
        if (b.classList.contains('mna-ts-val')) { resetSize(); return; }
        setSize((stored() || current()) + Number(b.getAttribute('data-d')) * STEP);
      });
      document.body.appendChild(pill);
    }

    // Les boutons apparaissent dès qu'un livre est affiché (pas sur la table des matières)
    function update() {
      var el = textEl();
      var visible = !!(el && el.offsetParent !== null);
      if (visible && !pill) build();
      if (pill) {
        pill.classList.toggle('show', visible);
        if (visible) showValue();
      }
    }
    setInterval(update, 600);
    update();
  } catch (err) { /* ne jamais empêcher le site de fonctionner */ }
})();
