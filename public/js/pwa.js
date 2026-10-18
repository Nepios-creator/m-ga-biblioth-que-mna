if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Ajouts communs (menu, raccourcis admin) sur toutes les pages
(function () {
  // Téléphone : onglets fixes, confort de lecture, installation (sans effet sur ordinateur)
  // Utilisation sans connexion (Bible téléchargée, message hors connexion)
  const offline = document.createElement('script');
  offline.src = '/js/offline.js';
  document.body.appendChild(offline);

  // Zoom à deux doigts partout + taille du texte pendant la lecture des livres
  const tools = document.createElement('script');
  tools.src = '/js/reader-tools.js';
  document.body.appendChild(tools);

  // Plein écran permanent sur toutes les pages (tant que vous ne le désactivez pas)
  const fs = document.createElement('script');
  fs.src = '/js/fullscreen.js';
  document.body.appendChild(fs);

  const mobile = document.createElement('script');
  mobile.src = '/js/mobile-app.js';
  document.body.appendChild(mobile);

  const extras = document.createElement('script');
  extras.src = '/js/site-extras.js';
  document.body.appendChild(extras);

  // Habillage « publications en ligne » : rangée de compte, menu doré, retour en haut, barre collée en haut
  const lsm = document.createElement('script');
  lsm.src = '/js/lsm-layout.js';
  document.body.appendChild(lsm);

  // Comptage anonyme des visites (statistiques de l'administration)
  const track = document.createElement('script');
  track.src = '/js/track.js';
  document.body.appendChild(track);

  // Page d'accueil : cadres interactifs, section Bible et ajustement des citations
  if (location.pathname === '/' || location.pathname === '/index.html') {
    const home = document.createElement('script');
    home.src = '/js/home.js';
    document.body.appendChild(home);

    // Bouton « Écrire au ministère » (message envoyé comme depuis l'espace d'étude)
    const contact = document.createElement('script');
    contact.src = '/js/home-contact.js';
    document.body.appendChild(contact);
  }
})();
