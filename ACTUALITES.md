# Module « Actualités chrétiennes »

Ce module est ajouté **sans modifier aucun fichier existant** : tous ses fichiers sont nouveaux.

## Contenu
- **Espace public** : `/actualites.html` (liste structurée, filtres par catégorie, région, langue, recherche) et `/actualite.html?id=…` (lecture complète : texte, images, vidéo, contacts, source, partage WhatsApp).
- **Administration** : `/admin-actualites.html` (administrateurs uniquement)
  - Propositions du jour : chaque jour, le site cherche les nouveautés des sites officiels ; l'administrateur les publie telles quelles, les modifie avant publication, ou les ignore.
  - Publier par lien : coller le lien d'une publication ; le site lit le titre, le texte, l'image et la source.
  - Rédiger / modifier : formulaire complet (titre, résumé, catégorie, région, pays, langue, date, auteur, source, texte mis en forme, image de couverture, autres images avec légendes, contacts, vidéo YouTube/Vimeo, mots-clés, mise à la une, brouillon).
  - Publiées : modifier, masquer, mettre à la une, supprimer.
  - Sources : ajouter, désactiver ou retirer les sites officiels consultés chaque jour.
- Le lien « Actualités » est ajouté automatiquement au menu des pages existantes, avec une section « Dernières actualités » sur l'accueil et un raccourci dans le panneau admin.

## Activation (une seule fois, dans Render)
Le serveur existant (`server/index.js`) n'est pas modifié. Pour brancher le module, changer la **commande de démarrage** :

1. Render → votre service web → **Settings** → **Start Command**
2. Remplacer `node server/index.js` (ou `npm start`) par : `node server/start-actualites.js`
3. Enregistrer : Render redémarre le site. Les tables nécessaires sont créées automatiquement.

**Retour en arrière** : remettre l'ancienne commande de démarrage.

## Options
- `MISTRAL_API_KEY` (déjà utilisée par le site) : active le bouton « Traduire en français » dans l'éditeur.
- Offre gratuite Render : le site s'endort sans visite ; la recherche quotidienne a lieu à son réveil (ou via « Chercher maintenant »).
