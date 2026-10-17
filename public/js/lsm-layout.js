// Habillage « publications en ligne » : petits ajouts d'affichage uniquement.
// Ce script n'enlève et ne modifie aucun contenu, aucun bouton et aucune fonction du site :
//   1. rangée « accueil / Créer un compte / Se connecter » sous le titre du ministère ;
//   2. page de connexion : le lien « Créer un compte » ouvre directement le formulaire d'inscription ;
//   3. page ouverte repérée en doré dans le menu ;
//   4. bouton « retour en haut » au-dessus du pied de page ;
//   5. téléphone : la barre d'onglets se place sous le titre, puis reste collée en haut en défilant.
(function () {
  'use strict';
  try {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    // Le lecteur de livre et la page de vérification gardent leur propre affichage
    if (path === '/lecture.html' || path === '/verification.html') return;

    var doc = document.documentElement;
    var header = document.querySelector('body > header');

    var HOME_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.6 1.8 11.7a1 1 0 0 0 .7 1.7H5V21a1 1 0 0 0 1 1h4.2v-6h3.6v6H18a1 1 0 0 0 1-1v-7.6h2.5a1 1 0 0 0 .7-1.7L12 2.6z"/></svg>';
    var UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 15l7-7 7 7"/></svg>';

    function hasToken() {
      try { return !!localStorage.getItem('mna_token'); } catch (e) { return false; }
    }

    // 1. Rangée de compte (pas sur la page de connexion elle-même)
    if (header && path !== '/login.html' && !header.querySelector('.lsm-account')) {
      var row = document.createElement('div');
      row.className = 'lsm-account';
      row.innerHTML =
        '<a class="lsm-home" href="/" aria-label="Accueil">' + HOME_SVG + '</a>' +
        (hasToken()
          ? '<a class="btn btn-primary" href="/login.html">Mon compte</a>'
          : '<a class="btn btn-ghost" href="/login.html#inscription">Créer un compte</a>' +
            '<a class="btn btn-primary" href="/login.html">Se connecter</a>');
      var brand = header.querySelector('.brand');
      if (brand && brand.parentNode === header) header.insertBefore(row, brand.nextSibling);
      else header.insertBefore(row, header.firstChild);
    }

    // 2. Connexion : « #inscription » ouvre le formulaire de création de compte
    if (path === '/login.html' && location.hash === '#inscription') {
      var toRegister = document.getElementById('to-register');
      if (toRegister) toRegister.click();
    }

    // 3. Menu : page ouverte en doré (les liens « Bible », « Actualités »… arrivent un peu plus tard)
    function markNav() {
      var links = document.querySelectorAll('header nav a');
      for (var i = 0; i < links.length; i++) {
        var h = (links[i].getAttribute('href') || '').replace(/\/+$/, '') || '/';
        var on = h === path || (h === '/' && path === '/index.html') || (h === '/actualites.html' && path === '/actualite.html');
        links[i].classList.toggle('on', on);
        if (on) links[i].setAttribute('aria-current', 'page');
      }
    }
    markNav();
    setTimeout(markNav, 1500);

    // 4. Retour en haut
    var footer = document.querySelector('body > footer');
    if (footer && !document.querySelector('.lsm-top')) {
      var up = document.createElement('a');
      up.className = 'lsm-top';
      up.href = '#';
      up.setAttribute('aria-label', 'Retour en haut de la page');
      up.innerHTML = UP_SVG;
      up.addEventListener('click', function (e) {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      footer.parentNode.insertBefore(up, footer);
    }

    // 5. Téléphone : barre d'onglets sous le titre, collée en haut pendant le défilement
    function overflowOk(el) {
      var s = getComputedStyle(el);
      return s.overflowX === 'visible' && s.overflowY === 'visible';
    }
    function recenter(bar) {
      requestAnimationFrame(function () {
        var box = bar.querySelector('.mna-tabs');
        var on = bar.querySelector('.mna-tab.on');
        if (box && on) box.scrollLeft = on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2;
      });
    }
    function placeBar() {
      var bar = document.getElementById('mna-appbar');
      if (!bar) return false;
      if (!header || header.parentNode !== document.body) return true;      // on garde la barre fixe d'origine
      if (!overflowOk(doc) || !overflowOk(document.body)) return true;       // sinon le collage en haut ne marcherait pas
      if (bar.previousElementSibling !== header) {
        header.parentNode.insertBefore(bar, header.nextSibling);
        recenter(bar);
      }
      doc.classList.add('lsm-sticky');
      return true;
    }
    if (window.matchMedia && window.matchMedia('(max-width: 820px)').matches && !placeBar()) {
      var mo = new MutationObserver(function () { if (placeBar()) mo.disconnect(); });
      mo.observe(document.body, { childList: true });
      setTimeout(function () { mo.disconnect(); }, 15000);
    }
  } catch (e) { /* ne jamais empêcher le site de fonctionner */ }
})();
