// Améliorations de la page d'accueil : les quatre cadres « Lecture » deviennent des raccourcis qui font vivre l'expérience.
(function () {
  const style = document.createElement('style');
  style.textContent = `
    .card.try-card { cursor: pointer; transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; position: relative; }
    .card.try-card:hover, .card.try-card:focus-visible { transform: translateY(-3px); border-color: var(--gold); box-shadow: 0 6px 18px rgba(0,0,0,0.08); outline: none; }
    .card.try-card:active { transform: translateY(0); }
    .card .try-link { display: inline-block; margin-top: 12px; font-size: 13px; font-weight: 600; color: var(--blue-deep); }
    .quote-poster .quote-text.q-medium { font-size: 21px; line-height: 1.55; }
    .quote-poster .quote-text.q-long { font-size: 18.5px; line-height: 1.6; }
    .device-overlay { position: fixed; inset: 0; background: rgba(22,19,15,0.92); z-index: 1000; display: flex; flex-direction: column; align-items: center; padding: 14px 12px 18px; overflow: auto; }
    .device-overlay .bar { width: 100%; max-width: 640px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: center; margin-bottom: 12px; }
    .device-overlay .bar button { border: 1.5px solid rgba(255,255,255,0.35); background: transparent; color: #f4ede0; padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
    .device-overlay .bar button.on { background: var(--gold); border-color: var(--gold); color: #16130f; }
    .device-overlay .bar button.close { background: #f4ede0; color: #16130f; border-color: #f4ede0; }
    .device-overlay .hint { color: #d8cbb0; font-size: 12.5px; margin-bottom: 12px; text-align: center; }
    .device-overlay .frame-wrap { background: #fff; border-radius: 14px; overflow: hidden; border: 6px solid #2a241b; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
    .device-overlay iframe { border: 0; display: block; transform-origin: top left; background: #fff; }
  `;
  document.head.appendChild(style);

  // --- Taille de la citation selon sa longueur (les réflexions sont plus longues qu'une simple phrase) ---
  const quoteEl = document.getElementById('quote-text');
  function fitQuote() {
    if (!quoteEl) return;
    const n = (quoteEl.textContent || '').length;
    quoteEl.classList.toggle('q-medium', n > 170 && n <= 300);
    quoteEl.classList.toggle('q-long', n > 300);
  }
  if (quoteEl) {
    new MutationObserver(fitQuote).observe(quoteEl, { childList: true, characterData: true, subtree: true });
    fitQuote();
  }

  // --- Section « Bible — Parole pure » ajoutée sur l'accueil, avant « À propos » ---
  (function addBibleSection() {
    const anchor = document.getElementById('a-propos');
    if (!anchor || document.getElementById('bible-section')) return;
    const sec = document.createElement('section');
    sec.id = 'bible-section';
    sec.className = 'section';
    sec.innerHTML = `
      <div class="container" style="text-align:center;">
        <h2 style="font-family:'Fraunces',serif;margin-bottom:10px;">La Bible — version « Parole pure »</h2>
        <p style="max-width:560px;margin:0 auto 22px;color:var(--ink-soft);">Notre propre version de la Bible, présentée pour une lecture paisible : grand texte, surlignage, notes, favoris et partage de versets.</p>
        <a href="/bible.html" class="btn btn-primary">Ouvrir la Bible</a>
      </div>`;
    anchor.parentNode.insertBefore(sec, anchor);
  })();

  // --- Les quatre cadres ---
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const canFullscreen = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  function makeCard(title, handler, labelFn) {
    const h3 = Array.from(document.querySelectorAll('.card h3')).find((el) => el.textContent.trim() === title);
    if (!h3) return null;
    const card = h3.closest('.card');
    card.classList.add('try-card');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    const link = document.createElement('span');
    link.className = 'try-link';
    link.textContent = labelFn ? labelFn() : 'Essayer →';
    card.appendChild(link);
    const run = (e) => { e.preventDefault(); handler(link); };
    card.addEventListener('click', run);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') run(e); });
    return link;
  }

  // 📖 Lecture en ligne → le catalogue, où chaque livre s'ouvre directement dans le site
  makeCard('Lecture en ligne', () => { window.location.href = '/catalogue.html'; }, () => 'Ouvrir le catalogue →');

  // 🎧 Lecture audio → la page des livres audio (si elle est déjà en ligne)
  makeCard('Lecture audio', () => {
    fetch('/audio.html', { method: 'HEAD' })
      .then((r) => { if (r.ok) window.location.href = '/audio.html'; else alert('Les livres audio arrivent bientôt.'); })
      .catch(() => alert('Les livres audio arrivent bientôt.'));
  }, () => 'Écouter un livre →');

  // 🖥️ Plein écran → active réellement le mode immersif
  const fsLink = makeCard('Plein écran', (link) => {
    if (!canFullscreen) {
      alert(isIOS
        ? 'Sur iPhone, le plein écran passe par l\'application : appuyez sur Partager ⬆️ puis « Sur l\'écran d\'accueil », et ouvrez la bibliothèque depuis cette icône.'
        : 'Votre navigateur ne permet pas le plein écran sur cette page.');
      return;
    }
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    }
  }, () => (isFullscreen() ? 'Quitter le plein écran' : 'Passer en plein écran →'));
  function refreshFsLabel() { if (fsLink) fsLink.textContent = isFullscreen() ? 'Quitter le plein écran ✕' : 'Passer en plein écran →'; }
  document.addEventListener('fullscreenchange', refreshFsLabel);
  document.addEventListener('webkitfullscreenchange', refreshFsLabel);

  // 📱 Responsive → aperçu réel du site sur téléphone, tablette et ordinateur
  makeCard('Responsive', openDevicePreview, () => 'Voir sur chaque écran →');

  function openDevicePreview() {
    const devices = [
      { id: 'phone', label: '📱 Téléphone', w: 390, h: 760 },
      { id: 'tablet', label: '📟 Tablette', w: 768, h: 900 },
      { id: 'desktop', label: '💻 Ordinateur', w: 1200, h: 800 },
    ];
    const overlay = document.createElement('div');
    overlay.className = 'device-overlay';
    overlay.innerHTML = `
      <div class="bar">
        ${devices.map((d) => `<button data-d="${d.id}">${d.label}</button>`).join('')}
        <button class="close">✕ Fermer</button>
      </div>
      <div class="hint">Le catalogue s'adapte à chaque taille d'écran. Choisissez un appareil pour le voir.</div>
      <div class="frame-wrap" id="frame-wrap"><iframe src="/catalogue.html" title="Aperçu du site"></iframe></div>
    `;
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const wrap = overlay.querySelector('#frame-wrap');
    const frame = overlay.querySelector('iframe');
    function show(id) {
      const d = devices.find((x) => x.id === id);
      const available = Math.min(window.innerWidth - 36, 1200);
      const scale = Math.min(1, available / d.w);
      frame.style.width = d.w + 'px';
      frame.style.height = d.h + 'px';
      frame.style.transform = `scale(${scale})`;
      wrap.style.width = Math.round(d.w * scale) + 'px';
      wrap.style.height = Math.round(d.h * scale) + 'px';
      overlay.querySelectorAll('.bar button[data-d]').forEach((b) => b.classList.toggle('on', b.dataset.d === id));
    }
    overlay.querySelectorAll('.bar button[data-d]').forEach((b) => b.addEventListener('click', () => show(b.dataset.d)));
    function close() { overlay.remove(); document.body.style.overflow = prevOverflow; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    overlay.querySelector('.close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    show(window.innerWidth < 500 ? 'phone' : 'tablet');
  }
})();
