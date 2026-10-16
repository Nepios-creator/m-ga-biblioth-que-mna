// Bible — notes de compréhension personnelles
// Toucher un verset puis « Ma note » ouvre une zone d'écriture sous le verset.
// La touche Entrée passe à la ligne (nouveau paragraphe) : elle n'enregistre pas.
// L'enregistrement est automatique ; si la connexion manque, la note est gardée sur le téléphone puis envoyée plus tard.
(function () {
  'use strict';
  var btn = document.getElementById('a-note');
  if (!btn || typeof state === 'undefined' || typeof api !== 'function') return;

  // ---------- Style ----------
  var st = document.createElement('style');
  st.textContent = [
    '.uned { display: block; margin: .5em 0 1.2em; padding: 12px 14px; background: var(--b-card); border: 1px solid var(--b-line); border-left: 4px solid var(--b-accent); border-radius: 12px; font-family: "Inter", sans-serif; font-size: 15px; line-height: 1.5; color: var(--b-fg); cursor: default; }',
    '.uned .un-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }',
    '.uned .un-title { flex: 1; min-width: 0; font-weight: 700; }',
    '.uned .un-x { flex: none; width: 30px; height: 30px; border: 1px solid var(--b-line); background: transparent; color: var(--b-soft); border-radius: 999px; font-size: 14px; cursor: pointer; font-family: inherit; }',
    '.uned .un-ta { display: block; width: 100%; box-sizing: border-box; min-height: 90px; padding: 10px 12px; border: 1px solid var(--b-line); border-radius: 10px; background: var(--b-bg); color: var(--b-fg); font-family: inherit; font-size: 16px; line-height: 1.55; resize: none; overflow: hidden; }',
    '.uned .un-ta:focus { outline: 2px solid var(--b-accent); outline-offset: 1px; }',
    '.uned .un-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }',
    '.uned .un-status { flex: 1; min-width: 0; font-size: 12.5px; color: var(--b-soft); }',
    '.sheet-note, .res .note { white-space: pre-wrap; }',
    '.sheet-note { max-height: 28vh; overflow-y: auto; cursor: pointer; }'
  ].join('\n');
  document.head.appendChild(st);

  // ---------- Notes en attente (gardées sur le téléphone tant qu'elles ne sont pas enregistrées) ----------
  var PENDING_KEY = 'bible_notes_pending';
  function readPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function writePending(o) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(o)); } catch (e) {} }
  function setPending(id, text) { var p = readPending(); p[id] = text; writePending(p); }
  function clearPending(id) { var p = readPending(); delete p[id]; writePending(p); }

  function verseById(id) { return state.data && state.data.verses.find(function (v) { return v.id === id; }); }

  async function postNote(verseId, text) {
    var r = await fetch('/api/bible/marks', { method: 'POST', headers: HJ, body: JSON.stringify({ verse_id: verseId, type: 'note', note: text }) });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  function applyResult(verseId, data) {
    var v = verseById(verseId);
    if (!v) return;
    var m = state.marks.get(verseId);
    if (data && data.removed) { if (m) delete m.note; } else { setMark(verseId, data); }
    refreshVerse(v);
  }

  // ---------- Éditeur ----------
  var editor = null;

  async function persist() {
    var ed = editor;
    if (!ed) return;
    clearTimeout(ed.timer);
    if (ed.saving) { ed.again = true; return; }
    if (!ed.dirty) return;
    ed.saving = true;
    do {
      ed.again = false;
      ed.dirty = false;
      var text = ed.ta.value;
      ed.status.textContent = 'Enregistrement…';
      try {
        var data = await postNote(ed.id, text);
        applyResult(ed.id, data);
        if (ed.ta.value === text) clearPending(ed.id);
        ed.status.textContent = text.trim() ? '✓ Enregistré' : 'Note effacée';
      } catch (e) {
        setPending(ed.id, ed.ta.value);
        ed.dirty = true;
        ed.again = false;
        ed.status.textContent = 'Gardé sur ce téléphone — sera envoyé dès que la connexion revient';
      }
    } while (ed.again);
    ed.saving = false;
  }

  async function closeEditor() {
    var ed = editor;
    if (!ed) return;
    clearTimeout(ed.timer);
    if (ed.dirty) await persist();
    while (ed.saving) await new Promise(function (r) { setTimeout(r, 50); });
    if (ed.card.parentNode) ed.card.remove();
    if (editor === ed) editor = null;
  }

  async function openEditor(v) {
    await closeEditor();
    var el = document.querySelector('.v[data-id="' + v.id + '"]');
    if (!el) return;
    var anchor = document.querySelector('.nslot[data-v="' + v.id + '"]') || el;
    var m = state.marks.get(v.id) || {};
    var pend = readPending();
    var initial = pend[v.id] !== undefined ? pend[v.id] : (m.note ? m.note.note : '');

    var card = document.createElement('div');
    card.className = 'uned';
    card.innerHTML = '<div class="un-head"><span class="un-title"></span><button type="button" class="un-x" aria-label="Fermer la note">✕</button></div>' +
      '<textarea class="un-ta" rows="3" enterkeyhint="enter" placeholder="Écrivez ici ce que vous comprenez de ce verset…"></textarea>' +
      '<div class="un-foot"><span class="un-status"></span><button type="button" class="act un-del">Effacer</button></div>';
    card.querySelector('.un-title').textContent = '💬 Ma note — ' + refLabel([v]);
    var ta = card.querySelector('.un-ta');
    ta.value = initial;
    anchor.parentNode.insertBefore(card, anchor.nextSibling);

    var ed = { id: v.id, card: card, ta: ta, status: card.querySelector('.un-status'), timer: null, saving: false, again: false, dirty: false };
    editor = ed;

    function grow() { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, 90) + 'px'; }
    // Entrée n'est volontairement pas interceptée : dans la zone de note, elle crée un nouveau paragraphe.
    ta.addEventListener('input', function () {
      grow();
      ed.dirty = true;
      setPending(ed.id, ta.value);
      ed.status.textContent = 'Modification…';
      clearTimeout(ed.timer);
      ed.timer = setTimeout(persist, 800);
    });
    ta.addEventListener('blur', function () { if (ed.dirty) persist(); });
    card.querySelector('.un-x').addEventListener('click', closeEditor);
    card.querySelector('.un-del').addEventListener('click', function () {
      if (ta.value && !confirm('Effacer cette note ?')) return;
      ta.value = '';
      grow();
      ed.dirty = true;
      setPending(ed.id, '');
      persist();
    });

    grow();
    if (pend[v.id] !== undefined) ed.status.textContent = 'Brouillon repris';
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // ---------- Branchements ----------
  btn.textContent = '💬 Ma note';
  btn.onclick = function () {
    var vs = selectedVerses();
    if (vs.length !== 1) { alert('Sélectionnez un seul verset pour écrire une note.'); return; }
    var v = vs[0];
    clearSelection();
    openEditor(v);
  };
  var sn = document.getElementById('sheet-note');
  if (sn) sn.addEventListener('click', function () { btn.click(); });

  // Avant de changer de chapitre, la note en cours est enregistrée
  var origLoad = window.loadChapter;
  if (typeof origLoad === 'function') {
    window.loadChapter = async function () {
      await closeEditor();
      return origLoad.apply(this, arguments);
    };
  }

  // Envoi des notes gardées sur le téléphone (connexion revenue, ou page rouverte)
  async function flushPending() {
    var p = readPending();
    var ids = Object.keys(p);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (editor && String(editor.id) === id) continue;
      try {
        var data = await postNote(Number(id), p[id]);
        applyResult(Number(id), data);
        var cur = readPending();
        if (cur[id] === p[id]) clearPending(id);
      } catch (e) { break; }
    }
  }
  window.addEventListener('online', flushPending);
  flushPending();
})();
