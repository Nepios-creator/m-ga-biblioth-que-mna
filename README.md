# Grande Bibliothèque numérique MNA

Site officiel de la Grande Bibliothèque numérique du ministère : catalogue de livres (lecture en ligne, téléchargement, vente), lecture audio, et un espace d'étude avec progression guidée, tests et brevets.

## Structure du projet

```
/public          → frontend (pages HTML/CSS/JS servies par le serveur)
/server          → backend Express (API, authentification, logique métier)
/server/db       → schéma et accès à la base de données PostgreSQL
```

## Installation dans le dépôt GitHub

1. Copie tous ces fichiers/dossiers à la racine de `m-ga-biblioth-que-mna`.
2. Commit + push sur la branche `main`.
3. Sur Render : crée un **Web Service** relié à ce dépôt (runtime Node, build `npm install`, start `npm start`), et une base **PostgreSQL** (plan gratuit). Ajoute la variable d'environnement `DATABASE_URL` avec l'URL de connexion interne fournie par Render.
4. Au premier démarrage, exécute le contenu de `server/db/schema.sql` sur la base pour créer les tables (via le Shell psql de Render ou un client SQL).

## Démarrage local

```bash
npm install
cp .env.example .env   # puis renseigner les variables
npm run dev
```

## Statut du projet

- [x] Phase 1 — Squelette du site (structure, page d'accueil, connexion à la base de données)
- [ ] Phase 2 — Authentification (compte lecteur / compte admin)
- [ ] Phase 3 — Catalogue de livres + lecteur en ligne
- [ ] Phase 4 — Espace d'étude (déverrouillage progressif, tests, brevets)
- [ ] Phase 5 — Vente manuelle + lecture audio + notifications email
