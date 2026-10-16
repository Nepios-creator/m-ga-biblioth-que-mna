// Lanceur du serveur AVEC le module « Actualités chrétiennes ».
// Il démarre server/index.js sans le modifier : le module se branche au moment où l'application Express est créée.
// Utilisation : commande de démarrage Render  →  node server/start-actualites.js
// Retour en arrière : remettre la commande de démarrage sur  node server/index.js
require('dotenv').config();
const path = require('path');
const express = require('express');

let mount = null;
try {
  mount = require('./actualites/mount');
} catch (err) {
  console.error('[actualités] module non chargé :', err.message);
}

let mounted = false;
const patched = new Proxy(express, {
  apply(target, thisArg, args) {
    const app = Reflect.apply(target, thisArg, args);
    if (mount && !mounted) {
      mounted = true;
      try { mount(app, express, path.join(__dirname, '..', 'public')); }
      catch (err) { console.error('[actualités] module non démarré :', err.message); }
    }
    return app;
  },
});

require.cache[require.resolve('express')].exports = patched;
require('./index.js');
