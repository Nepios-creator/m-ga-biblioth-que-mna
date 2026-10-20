// Affichage de la préface de la Bible : reproduit fidèlement la mise en forme du fichier Word
// (alignement, tailles, couleurs, gras, italique, espacements, listes, sauts de page).
// Utilisé par bible.html (lecteurs) et admin-preface.html (aperçu).
(function () {
  var esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var FONTS = {
    g: "'EB Garamond','Cormorant Garamond',Garamond,Georgia,serif",
    t: "Georgia,'Times New Roman',Times,serif",
    s: "Inter,Arial,Helvetica,sans-serif",
    m: "Consolas,'Courier New',monospace"
  };

  // Les couleurs foncées du document (ex. or sombre) restent lisibles sur fond sombre
  function lum(h) { return (0.2126 * parseInt(h.substr(0, 2), 16) + 0.7152 * parseInt(h.substr(2, 2), 16) + 0.0722 * parseInt(h.substr(4, 2), 16)) / 255; }
  function adapt(hex, theme) {
    if (theme === 'dark' && lum(hex) < 0.5) {
      var out = '#';
      for (var i = 0; i < 6; i += 2) { var v = parseInt(hex.substr(i, 2), 16); out += ('0' + Math.round(v + (255 - v) * 0.5).toString(16)).slice(-2); }
      return out;
    }
    return '#' + hex;
  }

  function renderDoc(d, theme) {
    var html = '<div class="pf-doc"' + (d.bf && FONTS[d.bf] ? ' style="font-family:' + FONTS[d.bf] + '"' : '') + '>';
    (d.paras || []).forEach(function (p) {
      if (p.pb) { html += '<div class="pf-pb" aria-hidden="true"></div>'; return; }
      var st = 'text-align:' + (p.a || 'left') + ';margin:' + (p.b || 0) + 'em 0 ' + (p.f || 0) + 'em;line-height:' + (p.l || 1.45);
      if (p.il) st += ';margin-left:' + p.il + 'em';
      if (p.fi) st += ';text-indent:' + p.fi + 'em';
      if (p.e) { html += '<p style="' + st + (p.s ? ';font-size:' + p.s + 'em' : '') + '"><br></p>'; return; }
      var inner = p.m ? '<span class="pf-m">' + esc(p.m) + '</span> ' : '';
      (p.r || []).forEach(function (r) {
        var s = '';
        if (r.b) s += 'font-weight:700;';
        if (r.i) s += 'font-style:italic;';
        if (r.u) s += 'text-decoration:underline;';
        if (r.k) s += 'text-transform:uppercase;';
        if (r.sc) s += 'font-variant:small-caps;';
        if (r.c) s += 'color:' + adapt(r.c, theme) + ';';
        if (r.s) s += 'font-size:' + r.s + 'em;';
        if (r.ls) s += 'letter-spacing:' + r.ls + 'em;';
        if (r.f && FONTS[r.f]) s += 'font-family:' + FONTS[r.f] + ';';
        var t = esc(r.t).replace(/\n/g, '<br>');
        if (r.va === 'sup') t = '<sup>' + t + '</sup>'; else if (r.va === 'sub') t = '<sub>' + t + '</sub>';
        inner += s ? '<span style="' + s + '">' + t + '</span>' : t;
      });
      html += '<p style="' + st + '">' + inner + '</p>';
    });
    return html + '</div>';
  }

  // Ancien format (texte simple) : « # » titre, « ## » intertitre, **gras**, *italique*, « - » puces
  function inline(s) { return esc(s).replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+?)\*/g, '<em>$1</em>'); }
  function renderLegacy(body) {
    return String(body || '').split(/\n{2,}/).map(function (b) { return b.trim(); }).filter(Boolean).map(function (b) {
      var h = b.match(/^(#{1,3})\s+([\s\S]+)$/);
      if (h) return '<h' + (h[1].length + 1) + ' class="pf-h' + h[1].length + '">' + inline(h[2].replace(/\n/g, ' ').trim()) + '</h' + (h[1].length + 1) + '>';
      var lines = b.split('\n');
      if (lines.every(function (l) { return /^[-•]\s+/.test(l); })) return '<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^[-•]\s+/, '')) + '</li>'; }).join('') + '</ul>';
      return '<p>' + inline(b).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  window.renderPreface = function (body, theme) {
    var s = String(body || '');
    if (s.trim().charAt(0) === '{') {
      try { var d = JSON.parse(s); if (d && d.v === 2 && Array.isArray(d.paras)) return renderDoc(d, theme || 'light'); } catch (e) {}
    }
    return renderLegacy(s);
  };
})();
