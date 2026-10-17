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

    // Bouton « Écrire au ministère » (message envoyé comme depuis l'espace d'étude)
    const contact = document.createElement('script');
    contact.src = '/js/home-contact.js';
    document.body.appendChild(contact);
  }

  // Page Bible : notes de compréhension écrites sous le verset (Entrée = nouveau paragraphe)
  if (location.pathname.endsWith('/bible.html')) {
    const bibleNotes = document.createElement('script');
    bibleNotes.src = '/js/bible-notes.js';
    document.body.appendChild(bibleNotes);
  }

  // Page de lecture d'un livre : taille du texte, thèmes, progression, chapitre suivant
  if (location.pathname.endsWith('/lecture.html')) {
    const lectureExtras = document.createElement('script');
    lectureExtras.src = '/js/lecture-extras.js';
    document.body.appendChild(lectureExtras);
  }
})();
