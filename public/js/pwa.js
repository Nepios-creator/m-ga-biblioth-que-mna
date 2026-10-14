if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Page d'accueil : active les cadres interactifs et l'ajustement de la taille des citations
if (location.pathname === '/' || location.pathname === '/index.html') {
  const homeScript = document.createElement('script');
  homeScript.src = '/js/home.js';
  document.body.appendChild(homeScript);
}
