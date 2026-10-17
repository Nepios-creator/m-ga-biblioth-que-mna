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

    // 6. Page d'accueil : texte du haut, diaporama d'affiches, citation du jour raccourcie
    if (path === '/' || path === '/index.html') {
      var hero = document.querySelector('.hero');
      if (hero) {
        var h1 = hero.querySelector('h1');
        var intro = hero.querySelector('p');
        if (h1 && !hero.querySelector('.lsm-sub')) {
          h1.textContent = 'Lire et écouter';
          var sub = document.createElement('div');
          sub.className = 'lsm-sub';
          sub.textContent = 'le MNA';
          h1.parentNode.insertBefore(sub, h1.nextSibling);
        }
        if (intro) intro.textContent = 'Se familiariser avec les enseignements du Docteur S-J Nepios';

        // Diaporama des deux livres (images à déposer dans /img/)
        var SLIDES = [
          { src: '/img/affiche-satan.jpg', alt: 'La vraie histoire de Satan — Docteur S-J Nepios', bg: '#000c1f' },
          { src: '/img/affiche-mysteres.jpg', alt: 'Les trois mystères de Christ — Docteur S-J Nepios', bg: '#0d0f15' }
        ];
        if (!hero.querySelector('.lsm-carousel')) {
          var car = document.createElement('div');
          car.className = 'lsm-carousel';
          car.setAttribute('role', 'region');
          car.setAttribute('aria-label', 'Nos livres');
          car.innerHTML = SLIDES.map(function (sl, i) {
            return '<div class="lsm-slide' + (i === 0 ? ' on' : '') + '" style="background:' + sl.bg + '"><img src="' + sl.src + '" alt="' + sl.alt + '"' + (i === 0 ? '' : ' loading="lazy"') + '></div>';
          }).join('') +
            '<button type="button" class="lsm-arrow lsm-prev" aria-label="Livre précédent">&#8249;</button>' +
            '<button type="button" class="lsm-arrow lsm-next" aria-label="Livre suivant">&#8250;</button>';
          var dots = document.createElement('div');
          dots.className = 'lsm-dots';
          dots.innerHTML = SLIDES.map(function (sl, i) {
            return '<button type="button" aria-label="Livre ' + (i + 1) + '"' + (i === 0 ? ' class="on"' : '') + '></button>';
          }).join('');
          hero.insertBefore(car, hero.firstChild);
          hero.insertBefore(dots, car.nextSibling);

          var slides = car.querySelectorAll('.lsm-slide');
          var dotBtns = dots.querySelectorAll('button');
          var cur = 0, timer = null;
          function show(n) {
            cur = (n + slides.length) % slides.length;
            for (var i = 0; i < slides.length; i++) {
              slides[i].classList.toggle('on', i === cur);
              dotBtns[i].classList.toggle('on', i === cur);
            }
          }
          function play() {
            clearInterval(timer);
            var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (!calm) timer = setInterval(function () { show(cur + 1); }, 4500);
          }
          car.querySelector('.lsm-prev').addEventListener('click', function () { show(cur - 1); play(); });
          car.querySelector('.lsm-next').addEventListener('click', function () { show(cur + 1); play(); });
          for (var d = 0; d < dotBtns.length; d++) {
            (function (n) { dotBtns[n].addEventListener('click', function () { show(n); play(); }); })(d);
          }
          var x0 = null;
          car.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
          car.addEventListener('touchend', function (e) {
            if (x0 === null) return;
            var dx = e.changedTouches[0].clientX - x0;
            x0 = null;
            if (Math.abs(dx) > 40) { show(dx < 0 ? cur + 1 : cur - 1); play(); }
          }, { passive: true });
          play();
        }
      }
      doc.classList.add('lsm-ready');

      // Citation du jour : version courte, le texte complet reste accessible
      var qEl = document.getElementById('quote-text');
      var shareRow = document.getElementById('quote-share');
      if (qEl && shareRow) {
        var full = '', expanded = false, busy = false, more = null;
        var MAX = 190;
        var shorten = function (t) {
          if (t.length <= MAX) return t;
          var cut = t.slice(0, MAX), best = -1, re = /[.!?»”](?=\s|$)/g, m;
          while ((m = re.exec(cut))) { if (m.index > 70) best = m.index + 1; }
          if (best > 0) return cut.slice(0, best).trim();
          return cut.replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '…';
        };
        var apply = function () {
          if (busy) return;
          var cur = qEl.textContent || '';
          if (!full || (cur !== full && cur !== shorten(full))) full = cur;   // nouvelle citation reçue
          if (!full || full.indexOf('Chargement') === 0) return;
          busy = true;
          var short = shorten(full);
          var target = expanded ? full : short;
          if (qEl.textContent !== target) qEl.textContent = target;   // pas de réécriture inutile : évite toute boucle
          if (short !== full) {
            if (!more) {
              more = document.createElement('button');
              more.type = 'button';
              more.className = 'btn btn-ghost lsm-more';
              var ref = document.getElementById('share-copy');
              if (ref) more.setAttribute('style', ref.getAttribute('style') || '');
              more.addEventListener('click', function () { expanded = !expanded; busy = false; apply(); });
              shareRow.insertBefore(more, shareRow.firstChild);
            }
            more.textContent = expanded ? 'Réduire' : 'Lire la suite';
            more.style.display = '';
          } else if (more) {
            more.style.display = 'none';
          }
          setTimeout(function () { busy = false; }, 0);
        };
        new MutationObserver(function () { setTimeout(apply, 0); }).observe(qEl, { childList: true, characterData: true, subtree: true });
        apply();
      }
    }
  } catch (e) { /* ne jamais empêcher le site de fonctionner */ }
})();
