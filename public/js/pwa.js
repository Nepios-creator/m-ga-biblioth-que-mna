if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Ajouts communs (menu, raccourcis admin) sur toutes les pages
(function () {
  const extras = document.createElement('script');
  extras.src = '/js/site-extras.js';
  document.body.appendChild(extras);

  // Page d'accueil : cadres interactifs, section Bible et ajustement des citations
  if (location.pathname === '/' || location.pathname === '/index.html') {
    const home = document.createElement('script');
    home.src = '/js/home.js';
    document.body.appendChild(home);
  }
})();
