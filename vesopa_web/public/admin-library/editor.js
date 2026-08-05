/*
 * A mail-composer-style WYSIWYG editor for blog bodies.
 *
 * Modelled on Roundcube's HTML composer (which is TinyMCE): a grouped toolbar
 * over a white document surface, styles/font/size dropdowns, colour and
 * highlight pickers, alignment, indent, lists, link/image/table, and a source
 * view. You format the text, and the page shows what you formatted.
 *
 * Why not TinyMCE itself
 * ----------------------
 * The body is rebuilt from an allowlist on the way out — see
 * src/admin/sanitise.js. TinyMCE does not know that allowlist, so it would
 * happily produce markup the server then discards, and the author would find
 * formatting missing from the published post with nothing to explain it. This
 * editor's toolbar and that allowlist were written against each other: every
 * button here emits something `safeStyle` keeps, and there is a round-trip
 * test covering exactly that. It also keeps deploy.sh's promise of no build
 * step and no dependency tree.
 *
 * execCommand is deprecated and has no replacement. Every browser still
 * implements it. Where its output is wrong for us it is normalised in `clean`,
 * which has to exist for pasted content anyway.
 */
(function () {
  'use strict';

  // Mirrors ALLOWED in src/admin/sanitise.js. Anything absent is unwrapped
  // rather than deleted, so the words survive even when the markup does not —
  // a paste from Word should degrade to plain text, never to an empty editor.
  var ALLOWED = {
    P: ['style'], BR: [], STRONG: ['style'], B: ['style'], EM: ['style'],
    I: ['style'], U: ['style'], S: ['style'], SPAN: ['style'],
    H2: ['style'], H3: ['style'], H4: ['style'],
    UL: ['style'], OL: ['style'], LI: ['style'],
    BLOCKQUOTE: ['style'], PRE: ['style'], CODE: ['style'],
    HR: [],
    A: ['href', 'title', 'target', 'rel', 'style'],
    IMG: ['src', 'alt', 'title', 'width', 'height', 'loading', 'style'],
    FIGURE: ['style'], FIGCAPTION: ['style'],
    TABLE: ['style'], THEAD: [], TBODY: [], TR: ['style'],
    TH: ['colspan', 'rowspan', 'style'], TD: ['colspan', 'rowspan', 'style'],
  };

  // Browser output that means the same as something we keep. Mapped rather
  // than dropped: execCommand emits DIV for a new line in some engines, and
  // dropping those would run every paragraph together. FONT is the legacy
  // colour tag — converted to a styled SPAN rather than lost.
  var RENAME = {
    DIV: 'P', SECTION: 'P', ARTICLE: 'P',
    H1: 'H2', H5: 'H4', H6: 'H4',
    FONT: 'SPAN', STRIKE: 'S', DEL: 'S', INS: 'U', MARK: 'SPAN',
  };

  // Same properties safeStyle() accepts. Kept in step by the round-trip test.
  var STYLE_PROPS = [
    'color', 'background-color', 'text-align', 'font-family', 'font-size',
    'font-weight', 'font-style', 'text-decoration', 'margin-left', 'padding-left',
  ];

  var BLOCKS = [
    { v: 'p', label: 'Paragraph' },
    { v: 'h2', label: 'Heading' },
    { v: 'h3', label: 'Subheading' },
    { v: 'h4', label: 'Small heading' },
    { v: 'blockquote', label: 'Quote' },
    { v: 'pre', label: 'Preformatted' },
  ];

  var FONTS = [
    ['', 'Default'],
    ['Arial, Helvetica, sans-serif', 'Arial'],
    ['Georgia, serif', 'Georgia'],
    ['"Helvetica Neue", Helvetica, Arial, sans-serif', 'Helvetica'],
    ['"Times New Roman", Times, serif', 'Times New Roman'],
    ['Tahoma, Geneva, sans-serif', 'Tahoma'],
    ['Verdana, Geneva, sans-serif', 'Verdana'],
    ['"Courier New", Courier, monospace', 'Courier New'],
  ];

  var SIZES = ['', '11px', '13px', '14px', '16px', '18px', '24px', '32px'];

  /** One press of the indent button. Roughly one tab stop. */
  var INDENT_STEP = 40;

  // Roundcube's palette shape: greyscale row then hues, light to dark.
  var SWATCHES = [
    '#000000', '#444444', '#666666', '#999999', '#cccccc', '#eeeeee', '#ffffff',
    '#b91c1c', '#c2410c', '#a16207', '#4d7c0f', '#047857', '#0e7490', '#1d4ed8',
    '#6d28d9', '#a21caf', '#be185d', '#78350f', '#1f2937', '#334155', '#0f172a',
    '#ef4444', '#f97316', '#eab308', '#84cc16', '#10b981', '#06b6d4', '#3b82f6',
    '#8b5cf6', '#d946ef', '#ec4899', '#f59e0b', '#6b7280', '#94a3b8', '#a5c715',
  ];

  /**
   * Rebuild a DOM subtree, keeping only allowed tags, attributes and style
   * declarations. The mirror of the server's sanitiser, so what the author
   * sees is what survives. Runs on paste and before every save.
   */
  // Elements whose content goes with them, matching RAW_TEXT in the server's
  // sanitiser. Unwrapping these instead would keep their text — and the "text"
  // inside a <script> is source code, so a paste containing one would print
  // JavaScript into the composer as if the author had typed it.
  var DROP_WHOLE = 'script,style,noscript,iframe,template,svg,math,object,embed';

  function clean(root) {
    Array.prototype.forEach.call(root.querySelectorAll(DROP_WHOLE), function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    var all = [];
    var node;
    while ((node = walker.nextNode())) all.push(node);

    all.forEach(function (el) {
      if (!el.parentNode) return; // detached by an earlier unwrap
      var tag = el.tagName;

      if (Object.prototype.hasOwnProperty.call(RENAME, tag)) {
        var from = el;
        el = rename(el, RENAME[tag]);
        // <font color=red> carries its colour in attributes, not style.
        if (tag === 'FONT') carryFontAttrs(from, el);
        tag = el.tagName;
      }

      if (!Object.prototype.hasOwnProperty.call(ALLOWED, tag)) return unwrap(el);

      var keep = ALLOWED[tag];
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (keep.indexOf(name) === -1) return el.removeAttribute(attr.name);

        if (name === 'style') {
          var css = filterStyle(el);
          if (css) el.setAttribute('style', css);
          else el.removeAttribute('style');
          return;
        }

        if (name === 'href' || name === 'src') {
          // Same rule as safeUrl() on the server. Control characters stripped
          // first: "java\nscript:" is how a scheme check gets walked past.
          var v = attr.value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
          var ok =
            /^(https?:|mailto:|tel:)/i.test(v) ||
            (v.charAt(0) === '/' && v.charAt(1) !== '/') ||
            v.charAt(0) === '#' ||
            (name === 'src' && /^data:image\//i.test(v));
          if (!ok) el.removeAttribute(attr.name);
          else el.setAttribute(name, v);
        }
      });

      // A span with nothing left to say is just noise in the source view.
      if (tag === 'SPAN' && !el.getAttribute('style')) unwrap(el);
    });

    /*
     * A <p> can only hold phrasing content, but execCommand and pasted markup
     * both produce <p><ul>…</ul></p>. Every browser silently re-parses that as
     * <p></p><ul>…</ul>, so the structure shown in the source view is not the
     * structure that renders — and an author editing the HTML by hand would be
     * editing something that does not exist. Unwrap so the two agree.
     */
    Array.prototype.forEach.call(root.querySelectorAll('p'), function (p) {
      if (p.querySelector('ul,ol,table,blockquote,figure,pre,h2,h3,h4,hr')) unwrap(p);
    });
  }

  /**
   * Read back only the properties the server keeps.
   *
   * Via el.style rather than a regex over the attribute text: the browser has
   * already parsed and normalised the declarations, so shorthand, casing and
   * whitespace are all resolved before anything is compared.
   */
  function filterStyle(el) {
    var out = [];
    STYLE_PROPS.forEach(function (prop) {
      var v = el.style.getPropertyValue(prop);
      if (v && !/url\s*\(|expression\s*\(/i.test(v)) out.push(prop + ': ' + v.trim());
    });
    return out.join('; ');
  }

  /** <font color size face> → inline style on the replacement span. */
  function carryFontAttrs(from, to) {
    var color = from.getAttribute('color');
    var face = from.getAttribute('face');
    if (color) to.style.color = color;
    if (face) to.style.fontFamily = face;
  }

  function rename(el, tag) {
    var out = document.createElement(tag);
    if (el.getAttribute('style')) out.setAttribute('style', el.getAttribute('style'));
    while (el.firstChild) out.appendChild(el.firstChild);
    el.parentNode.replaceChild(out, el);
    return out;
  }

  function unwrap(el) {
    var parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  /** One block-level element per line, for the source view. */
  function format(html) {
    return String(html)
      .replace(/></g, '>\n<')
      .replace(/\n<\/(strong|b|em|i|u|s|a|code|span)>/g, '</$1>')
      .replace(/\n(<(?:strong|b|em|i|u|s|a|code|span)\b)/g, '$1')
      .trim();
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function icon(name) {
    return '<span class="material-icons">' + name + '</span>';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function build(textarea) {
    var wrap = el('div', 'we');
    var bar = el('div', 'we-bar');
    var sheet = el('div', 'we-sheet');
    var area = el('div', 'we-area');
    var status = el('div', 'we-status');

    area.contentEditable = 'true';
    area.spellcheck = true;
    area.setAttribute('role', 'textbox');
    area.setAttribute('aria-multiline', 'true');
    area.setAttribute('aria-label', 'Post body');
    area.innerHTML = textarea.value || '<p><br></p>';
    clean(area);

    sheet.appendChild(area);
    wrap.appendChild(bar);
    wrap.appendChild(sheet);
    wrap.appendChild(status);
    textarea.parentNode.insertBefore(wrap, textarea);
    textarea.classList.add('we-source');
    wrap.appendChild(textarea);

    var sourceMode = false;
    var buttons = [];

    // ---- toolbar ----------------------------------------------------------

    function group() {
      var g = el('div', 'we-group');
      bar.appendChild(g);
      return g;
    }

    function sep() {
      bar.appendChild(el('span', 'we-sep'));
    }

    function button(parent, opts) {
      var b = el('button', 'we-btn' + (opts.wide ? ' we-btn-wide' : ''),
        opts.icon ? icon(opts.icon) : escapeHtml(opts.text));
      b.type = 'button';
      b.title = opts.title;
      b.setAttribute('aria-label', opts.title);
      if (opts.cmd) b.dataset.cmd = opts.cmd;
      // mousedown, not click: the button must not take focus, or the selection
      // in the editable area is gone before the command runs.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { e.preventDefault(); opts.run(b); });
      if (!opts.keepEnabled) buttons.push(b);
      parent.appendChild(b);
      return b;
    }

    function select(parent, opts) {
      var s = el('select', 'we-select');
      s.title = opts.title;
      s.setAttribute('aria-label', opts.title);
      opts.options.forEach(function (o) {
        var op = el('option');
        op.value = o[0];
        op.textContent = o[1];
        if (o[0] && opts.preview) op.style.fontFamily = o[0];
        s.appendChild(op);
      });
      s.addEventListener('mousedown', function () { remember(); });
      s.addEventListener('change', function () {
        restore();
        opts.run(s.value);
        s.selectedIndex = 0;
      });
      buttons.push(s);
      parent.appendChild(s);
      return s;
    }

    // Selection has to be captured before a <select> steals focus and dropped
    // back afterwards, or the command applies to nothing.
    var saved = null;
    function remember() {
      var sel = window.getSelection();
      if (sel.rangeCount && area.contains(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
    }
    function restore() {
      if (!saved) return;
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(saved);
      area.focus();
    }

    var g1 = group();
    var blockSel = select(g1, {
      title: 'Paragraph style',
      options: [['', 'Styles']].concat(BLOCKS.map(function (b) { return [b.v, b.label]; })),
      run: function (v) { if (v) setBlock(v); },
    });
    select(g1, {
      title: 'Font',
      preview: true,
      options: FONTS.map(function (f) { return [f[0], f[1]]; }).slice(0),
      run: function (v) { exec('fontName', v || 'inherit'); },
    });
    select(g1, {
      title: 'Size',
      options: SIZES.map(function (s) { return [s, s || 'Size']; }),
      run: function (v) { if (v) applyStyle('font-size', v); },
    });

    sep();
    var g2 = group();
    [['bold', 'format_bold', 'Bold  (Ctrl+B)'],
     ['italic', 'format_italic', 'Italic  (Ctrl+I)'],
     ['underline', 'format_underlined', 'Underline  (Ctrl+U)'],
     ['strikeThrough', 'format_strikethrough', 'Strikethrough']]
      .forEach(function (c) {
        button(g2, { cmd: c[0], icon: c[1], title: c[2], run: function () { exec(c[0]); } });
      });

    sep();
    var g3 = group();
    button(g3, {
      icon: 'format_color_text', title: 'Text colour',
      run: function (b) { openPalette(b, 'foreColor'); },
    });
    button(g3, {
      icon: 'format_color_fill', title: 'Highlight',
      run: function (b) { openPalette(b, 'hiliteColor'); },
    });

    sep();
    var g4 = group();
    [['justifyLeft', 'format_align_left', 'Align left'],
     ['justifyCenter', 'format_align_center', 'Centre'],
     ['justifyRight', 'format_align_right', 'Align right'],
     ['justifyFull', 'format_align_justify', 'Justify']]
      .forEach(function (c) {
        button(g4, { cmd: c[0], icon: c[1], title: c[2], run: function () { exec(c[0]); } });
      });

    sep();
    var g5 = group();
    [['insertUnorderedList', 'format_list_bulleted', 'Bulleted list'],
     ['insertOrderedList', 'format_list_numbered', 'Numbered list']]
      .forEach(function (c) {
        button(g5, { cmd: c[0], icon: c[1], title: c[2], run: function () { exec(c[0]); } });
      });
    button(g5, {
      icon: 'format_indent_decrease', title: 'Decrease indent',
      run: function () { step(-INDENT_STEP); },
    });
    button(g5, {
      icon: 'format_indent_increase', title: 'Increase indent',
      run: function () { step(INDENT_STEP); },
    });

    sep();
    var g6 = group();
    button(g6, { icon: 'link', title: 'Insert link  (Ctrl+K)', run: insertLink });
    button(g6, { icon: 'link_off', title: 'Remove link', run: function () { exec('unlink'); } });
    button(g6, { icon: 'image', title: 'Insert image', run: insertImage });
    button(g6, { icon: 'grid_on', title: 'Insert table', run: function (b) { openTableGrid(b); } });
    button(g6, { icon: 'horizontal_rule', title: 'Divider', run: function () { exec('insertHorizontalRule'); } });

    sep();
    var g7 = group();
    button(g7, { icon: 'format_clear', title: 'Clear formatting', run: clearFormat });
    button(g7, { icon: 'undo', title: 'Undo', run: function () { exec('undo'); } });
    button(g7, { icon: 'redo', title: 'Redo', run: function () { exec('redo'); } });

    var g8 = group();
    g8.className = 'we-group we-group-end';
    var sourceBtn = button(g8, {
      icon: 'code', title: 'Edit HTML source', keepEnabled: true,
      run: toggleSource,
    });

    // ---- commands ---------------------------------------------------------

    function exec(cmd, value) {
      area.focus();
      document.execCommand(cmd, false, value == null ? null : value);
      sync();
      refreshState();
    }

    /**
     * styleWithCSS, so execCommand emits <span style="color:…"> instead of the
     * ancient <font color>. The server's allowlist keeps the former; the
     * latter would be converted anyway, but this keeps the source view honest
     * about what is actually stored.
     */
    function withCss(fn) {
      try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* older engines */ }
      fn();
      try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* ignore */ }
    }

    function setBlock(tag) {
      area.focus();
      // Toggle off: pressing Heading inside a heading returns to a paragraph,
      // which every editor does and execCommand does not.
      var cur = blockTag();
      var target = cur === tag.toUpperCase() ? 'p' : tag;
      document.execCommand('formatBlock', false, '<' + target + '>');
      sync();
      refreshState();
    }

    /** Wrap the selection in a span carrying one declaration. */
    function applyStyle(prop, value) {
      area.focus();
      var sel = window.getSelection();
      if (!sel.rangeCount) return;
      var range = sel.getRangeAt(0);
      if (range.collapsed) return;

      var span = document.createElement('span');
      span.style.setProperty(prop, value);
      try {
        span.appendChild(range.extractContents());
        range.insertNode(span);
        // Leave the newly styled run selected, so a second choice from the
        // dropdown applies to the same text rather than to nothing.
        sel.removeAllRanges();
        var r = document.createRange();
        r.selectNodeContents(span);
        sel.addRange(r);
      } catch (e) {
        // Ranges that straddle block boundaries can refuse to surround; the
        // text is untouched, which is better than a half-applied style.
      }
      sync();
    }

    /**
     * Indent by stepping the block's margin-left.
     *
     * Not execCommand('indent'), which is what this used to call: Chrome
     * implements it by wrapping the paragraph in a <blockquote>. That survives
     * the sanitiser intact and then renders on the published page with the
     * quote treatment — a lime left rule and italics — so pressing "increase
     * indent" silently turned a paragraph into a pull quote.
     *
     * Capped at 200px because safeStyle() rejects px lengths above that; going
     * further would produce a value the server drops, which is exactly the
     * silent-loss failure this editor exists to avoid.
     */
    function step(delta) {
      area.focus();
      var node = currentBlock();
      if (!node) return;
      var now = parseInt(node.style.marginLeft, 10) || 0;
      var next = Math.max(0, Math.min(200, now + delta));
      if (next) node.style.marginLeft = next + 'px';
      else node.style.removeProperty('margin-left');
      sync();
    }

    /** The nearest block-level ancestor of the caret, within the editor. */
    function currentBlock() {
      var node = window.getSelection().anchorNode;
      while (node && node !== area) {
        if (node.nodeType === 1 && /^(P|H2|H3|H4|BLOCKQUOTE|PRE|LI|UL|OL|FIGURE|TABLE)$/.test(node.tagName)) {
          return node;
        }
        node = node.parentNode;
      }
      return null;
    }

    function blockTag() {
      var node = window.getSelection().anchorNode;
      while (node && node !== area) {
        if (node.nodeType === 1 && /^(P|H2|H3|H4|BLOCKQUOTE|PRE|LI)$/.test(node.tagName)) {
          return node.tagName;
        }
        node = node.parentNode;
      }
      return '';
    }

    function clearFormat() {
      area.focus();
      document.execCommand('removeFormat');
      // removeFormat leaves block-level alignment and indent alone, which is
      // not what "clear formatting" means to anyone using it.
      var node = window.getSelection().anchorNode;
      while (node && node !== area) {
        if (node.nodeType === 1) {
          node.style.removeProperty('text-align');
          node.style.removeProperty('margin-left');
          node.style.removeProperty('padding-left');
        }
        node = node.parentNode;
      }
      sync();
      refreshState();
    }

    // ---- colour palette ---------------------------------------------------

    var pop = null;

    function closePop() {
      if (pop) { pop.remove(); pop = null; }
      document.removeEventListener('mousedown', onOutside, true);
    }

    function onOutside(e) {
      if (pop && !pop.contains(e.target)) closePop();
    }

    function openPop(anchor, node) {
      closePop();
      pop = el('div', 'we-pop');
      pop.appendChild(node);
      wrap.appendChild(pop);
      var a = anchor.getBoundingClientRect();
      var w = wrap.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(a.left - w.left, w.width - 232)) + 'px';
      pop.style.top = (a.bottom - w.top + 4) + 'px';
      setTimeout(function () { document.addEventListener('mousedown', onOutside, true); }, 0);
    }

    function openPalette(anchor, cmd) {
      remember();
      var box = el('div', 'we-pal');
      SWATCHES.forEach(function (c) {
        var s = el('button', 'we-sw');
        s.type = 'button';
        s.style.background = c;
        s.title = c;
        s.addEventListener('mousedown', function (e) { e.preventDefault(); });
        s.addEventListener('click', function () {
          restore();
          withCss(function () { document.execCommand(cmd, false, c); });
          sync();
          closePop();
        });
        box.appendChild(s);
      });

      var clear = el('button', 'we-pop-clear', 'Remove colour');
      clear.type = 'button';
      clear.addEventListener('mousedown', function (e) { e.preventDefault(); });
      clear.addEventListener('click', function () {
        restore();
        withCss(function () {
          document.execCommand(cmd, false, cmd === 'hiliteColor' ? 'transparent' : 'inherit');
        });
        sync();
        closePop();
      });

      var holder = el('div');
      holder.appendChild(box);
      holder.appendChild(clear);
      openPop(anchor, holder);
    }

    // ---- table grid -------------------------------------------------------

    function openTableGrid(anchor) {
      remember();
      var ROWS = 7, COLS = 8;
      var holder = el('div');
      var grid = el('div', 'we-tablegrid');
      var label = el('div', 'we-pop-label', 'Pick a size');
      var cells = [];

      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var cell = el('i');
          cell.dataset.r = r + 1;
          cell.dataset.c = c + 1;
          grid.appendChild(cell);
          cells.push(cell);
        }
      }

      grid.addEventListener('mousemove', function (e) {
        if (e.target.tagName !== 'I') return;
        var rr = +e.target.dataset.r, cc = +e.target.dataset.c;
        cells.forEach(function (x) {
          x.classList.toggle('is-on', +x.dataset.r <= rr && +x.dataset.c <= cc);
        });
        label.textContent = cc + ' × ' + rr;
      });
      grid.addEventListener('mousedown', function (e) { e.preventDefault(); });
      grid.addEventListener('click', function (e) {
        if (e.target.tagName !== 'I') return;
        restore();
        insertTable(+e.target.dataset.c, +e.target.dataset.r);
        closePop();
      });

      holder.appendChild(grid);
      holder.appendChild(label);
      openPop(anchor, holder);
    }

    function insertTable(cols, rows) {
      var html = '<table><thead><tr>';
      for (var c = 0; c < cols; c++) html += '<th>Heading</th>';
      html += '</tr></thead><tbody>';
      for (var r = 0; r < rows; r++) {
        html += '<tr>';
        for (var c2 = 0; c2 < cols; c2++) html += '<td>&nbsp;</td>';
        html += '</tr>';
      }
      html += '</tbody></table><p><br></p>';
      area.focus();
      document.execCommand('insertHTML', false, html);
      sync();
    }

    // ---- link and image ---------------------------------------------------

    function insertLink() {
      var selected = String(window.getSelection());
      var url = window.prompt('Link address', 'https://');
      if (!url) return;
      if (!/^(https?:|mailto:|tel:|\/|#)/i.test(url)) url = 'https://' + url;
      area.focus();
      if (selected) {
        document.execCommand('createLink', false, url);
      } else {
        document.execCommand('insertHTML', false,
          '<a href="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a>');
      }
      sync();
    }

    function insertImage() {
      // The file manager's images are already on the page; reuse that rather
      // than asking the author to copy a URL out of another tab.
      var picker = document.getElementById('bodyImagePicker');
      if (picker) {
        picker.hidden = false;
        picker.scrollIntoView({ block: 'nearest' });
        return;
      }
      var url = window.prompt('Image address', '/uploads/');
      if (url) putImage(url, '');
    }

    function putImage(url, alt) {
      area.focus();
      var html =
        '<figure><img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt || '') +
        '" loading="lazy">' +
        (alt ? '<figcaption>' + escapeHtml(alt) + '</figcaption>' : '') +
        '</figure><p><br></p>';
      document.execCommand('insertHTML', false, html);
      sync();
    }

    // ---- state, sync, source ---------------------------------------------

    function refreshState() {
      buttons.forEach(function (b) {
        if (!b.dataset || !b.dataset.cmd) return;
        var on = false;
        try { on = document.queryCommandState(b.dataset.cmd); } catch (e) { /* unsupported */ }
        b.classList.toggle('is-on', !!on);
      });
      var t = blockTag().toLowerCase();
      for (var i = 0; i < blockSel.options.length; i++) {
        if (blockSel.options[i].value === t) { blockSel.selectedIndex = i; return; }
      }
      blockSel.selectedIndex = 0;
    }

    function sync() {
      if (sourceMode) return;
      clean(area);
      textarea.value = area.innerHTML === '<p><br></p>' ? '' : area.innerHTML;
      count();
    }

    function count() {
      var text = (sourceMode ? textarea.value.replace(/<[^>]*>/g, ' ') : area.innerText) || '';
      var words = text.trim() ? text.trim().split(/\s+/).length : 0;
      // 220wpm is the usual figure for web copy.
      var mins = Math.max(1, Math.round(words / 220));
      status.textContent =
        words + (words === 1 ? ' word' : ' words') + ' · about ' + mins + ' min read';
    }

    function toggleSource() {
      closePop();
      if (sourceMode) {
        area.innerHTML = textarea.value || '<p><br></p>';
        clean(area);
        sourceMode = false;
        wrap.classList.remove('is-source');
        sync();
      } else {
        clean(area);
        textarea.value = format(area.innerHTML);
        sourceMode = true;
        wrap.classList.add('is-source');
        textarea.focus();
        count();
      }
      sourceBtn.classList.toggle('is-on', sourceMode);
      // Formatting controls do nothing against raw HTML, so they are disabled
      // rather than left looking live.
      buttons.forEach(function (b) { b.disabled = sourceMode; });
    }

    // Paste as clean HTML. Without this a paste from Word or Google Docs
    // arrives as hundreds of lines of <span style> the server then discards,
    // and the author's formatting vanishes at publish time.
    area.addEventListener('paste', function (e) {
      var data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      var html = data.getData('text/html');
      if (html) {
        var holder = document.createElement('div');
        holder.innerHTML = html;
        clean(holder);
        document.execCommand('insertHTML', false, holder.innerHTML);
      } else {
        document.execCommand('insertText', false, data.getData('text/plain'));
      }
      sync();
    });

    area.addEventListener('input', sync);
    area.addEventListener('blur', sync);
    area.addEventListener('keyup', refreshState);
    area.addEventListener('mouseup', refreshState);
    textarea.addEventListener('input', count);

    area.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); insertLink(); }
    });

    // The form must never post a stale textarea: the editable div is the truth
    // in WYSIWYG mode and only sync() copies it across.
    if (textarea.form) textarea.form.addEventListener('submit', sync);

    count();
    refreshState();

    return { putImage: putImage, sync: sync };
  }

  function init() {
    var textarea = document.querySelector('[data-editor]');
    if (!textarea) return;
    window.vesopaEditor = build(textarea);
  }

  /*
   * Immediately when the DOM is already parsed, which it is: this file loads
   * with defer. Not simply DOMContentLoaded, because the page's own inline
   * script registers its listener while the document is still parsing and so
   * runs *before* one registered here would — and it needs window.vesopaEditor
   * to exist, since the image picker calls putImage on it.
   */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
