// Ajouts du site (fichier nouveau) :
//   1. bandeau « Traduire » (traduction de toute la page, Bible et livres lus dans la page compris) ;
//   2. carte de profil sur l'accueil : nom, adresse e-mail, photo de profil ;
//   3. œil « voir le mot de passe » sur les formulaires de connexion et d'inscription.
// Ce script n'enlève et ne modifie aucun contenu existant. Les styles sont dans /css/mna-plus.css.
(function () {
  'use strict';
  try {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var home = path === '/' || path === '/index.html';

    // Sécurité : si la feuille de style n'a pas été chargée par pwa.js, on la charge ici
    if (!document.querySelector('link[href="/css/mna-plus.css"]')) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/css/mna-plus.css';
      document.head.appendChild(css);
    }

    // =====================================================================
    // 1. TRADUCTION (Google Traduction, chargé seulement si une langue est choisie)
    // =====================================================================
    var LANGS = [
      ['fr', 'Français (langue d\u2019origine)'],
      ['en', 'English — anglais'], ['es', 'Español — espagnol'], ['pt', 'Português — portugais'],
      ['it', 'Italiano — italien'], ['de', 'Deutsch — allemand'], ['nl', 'Nederlands — néerlandais'],
      ['sw', 'Kiswahili — swahili'], ['ln', 'Lingála — lingala'], ['rw', 'Kinyarwanda'],
      ['ar', 'العربية — arabe'], ['zh-CN', '中文 — chinois'], ['ja', '日本語 — japonais'], ['ko', '한국어 — coréen'],
      ['hi', 'हिन्दी — hindi'], ['ru', 'Русский — russe'], ['tr', 'Türkçe — turc'], ['pl', 'Polski — polonais'],
      ['ro', 'Română — roumain'], ['uk', 'Українська — ukrainien'], ['el', 'Ελληνικά — grec'], ['iw', 'עברית — hébreu'],
      ['vi', 'Tiếng Việt — vietnamien'], ['id', 'Bahasa Indonesia — indonésien'], ['th', 'ไทย — thaï'],
      ['sv', 'Svenska — suédois'], ['da', 'Dansk — danois'], ['no', 'Norsk — norvégien'], ['fi', 'Suomi — finnois'],
      ['cs', 'Čeština — tchèque'], ['hu', 'Magyar — hongrois'], ['bg', 'Български — bulgare'],
      ['ht', 'Kreyòl ayisyen — créole haïtien'], ['mg', 'Malagasy — malgache'], ['yo', 'Yorùbá'], ['ig', 'Igbo'],
      ['ha', 'Hausa'], ['zu', 'isiZulu — zoulou'], ['xh', 'isiXhosa — xhosa'], ['am', 'አማርኛ — amharique'],
      ['so', 'Soomaali — somali'], ['af', 'Afrikaans'], ['sn', 'chiShona — shona'], ['ny', 'Chichewa'],
      ['st', 'Sesotho'], ['tl', 'Filipino'], ['bn', 'বাংলা — bengali'], ['ur', 'اردو — ourdou'], ['fa', 'فارسی — persan']
    ];

    function getCookie(name) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }
    function currentLang() {
      var m = getCookie('googtrans').match(/^\/[^\/]+\/(.+)$/);
      return m ? m[1] : 'fr';
    }
    function setLang(code) {
      var host = location.hostname;
      if (code === 'fr') {
        ['', '; domain=' + host, '; domain=.' + host].forEach(function (d) {
          document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d;
        });
      } else {
        var v = '/fr/' + code;
        document.cookie = 'googtrans=' + v + '; path=/';
        document.cookie = 'googtrans=' + v + '; path=/; domain=' + host;
      }
      location.reload();
    }

    // Le moteur de traduction n'est chargé que si une langue autre que le français est active
    function loadTranslator() {
      if (window.__mnaTranslator) return;
      window.__mnaTranslator = true;
      var holder = document.createElement('div');
      holder.id = 'mna_gt_el';
      holder.className = 'notranslate';
      holder.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
      document.body.appendChild(holder);
      window.mnaTranslatorInit = function () {
        try { new window.google.translate.TranslateElement({ pageLanguage: 'fr', autoDisplay: false }, 'mna_gt_el'); } catch (e) {}
      };
      var s = document.createElement('script');
      s.src = 'https://translate.google.com/translate_a/element.js?cb=mnaTranslatorInit';
      s.async = true;
      document.body.appendChild(s);
    }
    if (currentLang() !== 'fr') loadTranslator();

    var GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.7 4 6 4 9.5s-1.4 6.8-4 9.5c-2.6-2.7-4-6-4-9.5s1.4-6.8 4-9.5z"/></svg>';

    function buildBand() {
      var band = document.createElement('div');
      band.className = 'mna-tr notranslate';
      band.setAttribute('translate', 'no');
      var cur = currentLang();
      var opts = LANGS.map(function (l) {
        return '<option value="' + l[0] + '"' + (l[0] === cur ? ' selected' : '') + '>' + l[1] + '</option>';
      }).join('');
      band.innerHTML = '<label>' + GLOBE + '<span>Traduire</span>' +
        '<select aria-label="Traduire la page dans une autre langue">' + opts + '</select></label>';
      band.querySelector('select').addEventListener('change', function (e) { setLang(e.target.value); });
      return band;
    }

    // Le bandeau se place sous la rangée « accueil / Se connecter » (ajoutée par lsm-layout.js)
    // Pas sur le lecteur de livre ni sur la page de vérification : ils gardent leur propre affichage.
    if (path !== '/lecture.html' && path !== '/verification.html') {
      var header = document.querySelector('body > header');
      if (header) {
        var mountBand = function () {
          if (header.querySelector('.mna-tr')) return;
          var band = buildBand();
          var row = header.querySelector('.lsm-account');
          if (row) row.parentNode.insertBefore(band, row.nextSibling);
          else {
            var brand = header.querySelector('.brand');
            header.insertBefore(band, brand ? brand.nextSibling : header.firstChild);
          }
        };
        var tries = 0;
        (function wait() {
          if (header.querySelector('.lsm-account') || path === '/login.html' || tries++ > 12) mountBand();
          else setTimeout(wait, 250);
        })();
      }
    }

    // =====================================================================
    // 2. CARTE DE PROFIL SUR L'ACCUEIL
    // =====================================================================
    function buildProfile() {
      var token = '', user = null;
      try { token = localStorage.getItem('mna_token') || ''; user = JSON.parse(localStorage.getItem('mna_user') || 'null'); } catch (e) {}
      if (!token || !user) return;
      var hero = document.querySelector('.hero');
      if (!hero || document.querySelector('.mna-profile')) return;

      var key = 'mna_avatar_' + (user.id || user.email || 'membre');
      var name = user.full_name || (user.email ? String(user.email).split('@')[0] : 'Membre');
      var photo = '';
      try { photo = localStorage.getItem(key) || ''; } catch (e) {}

      var sec = document.createElement('section');
      sec.className = 'mna-profile notranslate';
      sec.setAttribute('translate', 'no');
      sec.innerHTML =
        '<div class="mna-profile-card">' +
          '<div class="mna-avatar" id="mna-avatar"></div>' +
          '<div class="mna-p-info">' +
            '<div class="mna-p-name" id="mna-p-name"></div>' +
            '<div class="mna-p-mail" id="mna-p-mail"></div>' +
            '<div class="mna-p-actions">' +
              '<button type="button" class="mna-p-btn" id="mna-p-add"></button>' +
              '<button type="button" class="mna-p-btn plain" id="mna-p-del">Retirer la photo</button>' +
            '</div>' +
            '<div class="mna-p-note">La photo est gardée sur cet appareil.</div>' +
            '<div class="mna-p-err" id="mna-p-err" hidden></div>' +
            '<input type="file" id="mna-p-file" accept="image/*" hidden>' +
          '</div>' +
        '</div>';
      hero.parentNode.insertBefore(sec, hero.nextSibling);

      var av = sec.querySelector('#mna-avatar');
      var addBtn = sec.querySelector('#mna-p-add');
      var delBtn = sec.querySelector('#mna-p-del');
      var err = sec.querySelector('#mna-p-err');
      var file = sec.querySelector('#mna-p-file');
      sec.querySelector('#mna-p-name').textContent = name;
      sec.querySelector('#mna-p-mail').textContent = user.email || '';

      function paint() {
        av.textContent = '';
        if (photo) {
          var img = document.createElement('img');
          img.src = photo; img.alt = 'Photo de profil';
          av.appendChild(img);
        } else {
          av.textContent = (name.trim().charAt(0) || '?').toUpperCase();
        }
        addBtn.textContent = photo ? 'Changer ma photo' : 'Ajouter ma photo';
        delBtn.hidden = !photo;
      }
      function showErr(t) { err.textContent = t; err.hidden = !t; }
      paint();

      addBtn.addEventListener('click', function () { showErr(''); file.click(); });
      delBtn.addEventListener('click', function () {
        photo = '';
        try { localStorage.removeItem(key); } catch (e) {}
        showErr(''); paint();
      });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        file.value = '';
        if (!f) return;
        if (!/^image\//.test(f.type)) return showErr('Choisissez une image (JPG, PNG…).');
        var url = URL.createObjectURL(f);
        var im = new Image();
        im.onload = function () {
          // Recadrage carré et réduction (256 px) : photo légère, bien cadrée
          var S = 256, c = document.createElement('canvas');
          c.width = S; c.height = S;
          var side = Math.min(im.width, im.height);
          c.getContext('2d').drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, S, S);
          URL.revokeObjectURL(url);
          var data = c.toDataURL('image/jpeg', 0.85);
          try { localStorage.setItem(key, data); photo = data; showErr(''); }
          catch (e) { showErr('Impossible d\u2019enregistrer la photo (espace de stockage plein).'); }
          paint();
        };
        im.onerror = function () { URL.revokeObjectURL(url); showErr('Cette image n\u2019a pas pu être lue.'); };
        im.src = url;
      });
    }
    if (home) buildProfile();

    // =====================================================================
    // 3. ŒIL « VOIR LE MOT DE PASSE »
    // =====================================================================
    var EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    var EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.8 10.8 0 0 1 12 19.5C5.5 19.5 1.5 12 1.5 12a19 19 0 0 1 4.6-5.6M9.9 4.7A9.7 9.7 0 0 1 12 4.5c6.5 0 10.5 7.5 10.5 7.5a19 19 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/></svg>';

    function addEyes() {
      var inputs = document.querySelectorAll('input[type="password"]');
      for (var i = 0; i < inputs.length; i++) {
        (function (inp) {
          if (inp.getAttribute('data-mna-eye')) return;
          // On ne touche qu'aux champs des formulaires de connexion / d'inscription
          if (path !== '/login.html' && !inp.closest('.field')) return;
          inp.setAttribute('data-mna-eye', '1');
          var wrap = document.createElement('span');
          wrap.className = 'mna-pw';
          inp.parentNode.insertBefore(wrap, inp);
          wrap.appendChild(inp);
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'mna-pw-btn';
          btn.setAttribute('aria-label', 'Afficher le mot de passe');
          btn.innerHTML = EYE;
          btn.addEventListener('click', function () {
            var show = inp.type === 'password';
            inp.type = show ? 'text' : 'password';
            btn.innerHTML = show ? EYE_OFF : EYE;
            btn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
          });
          wrap.appendChild(btn);
        })(inputs[i]);
      }
    }
    addEyes();
    setTimeout(addEyes, 800);
  } catch (e) { /* ne jamais empêcher le site de fonctionner */ }
})();
