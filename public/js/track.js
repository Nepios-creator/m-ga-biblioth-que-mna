// Comptage anonyme des visites (alimente les statistiques de l'administration).
// Aucune donnée personnelle : un identifiant aléatoire par appareil, la page ouverte et la provenance.
(function () {
  try {
    if (window.__mnaTracked) return;
    window.__mnaTracked = true;
    var path = location.pathname;
    if (/^\/admin/i.test(path)) return; // l'administration n'est jamais comptée
    if (navigator.onLine === false) return;

    function gen() {
      var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));
      return id.length >= 8 ? id : id + 'xxxxxxxx';
    }
    var vid, sid;
    try { vid = localStorage.getItem('mna_vid'); if (!vid) { vid = gen(); localStorage.setItem('mna_vid', vid); } } catch (e) { vid = gen(); }
    try { sid = sessionStorage.getItem('mna_sid'); if (!sid) { sid = gen(); sessionStorage.setItem('mna_sid', sid); } } catch (e) { sid = gen(); }

    var standalone = false;
    try {
      standalone = (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches)) || window.navigator.standalone === true;
    } catch (e) {}

    var headers = { 'Content-Type': 'application/json' };
    try { var tk = localStorage.getItem('mna_token'); if (tk) headers.Authorization = 'Bearer ' + tk; } catch (e) {}

    fetch('/api/track', {
      method: 'POST',
      headers: headers,
      keepalive: true,
      body: JSON.stringify({ vid: vid, sid: sid, path: path, ref: document.referrer || '', standalone: standalone })
    }).catch(function () {});
  } catch (e) { /* le comptage ne doit jamais gêner la page */ }
})();
