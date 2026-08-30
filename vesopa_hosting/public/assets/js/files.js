/**
 * The file manager, browser side.
 *
 * No framework and no build step, for the same reason the terminal vendors
 * xterm rather than fetching it: the site's CSP is `script-src 'self'` and this
 * app ships nothing from a third-party origin. That constraint is why the
 * editor below draws its own syntax highlighting instead of loading CodeMirror.
 *
 * THE THINGS THAT ARE EASY TO GET WRONG ON A PHONE, AND WHAT IS DONE HERE:
 *
 *   the table            Five columns do not fit on 360px. The same rows are
 *                        re-laid-out by CSS into a name plus a meta line, so
 *                        selection, menus and every action keep working — there
 *                        is one list, not a desktop one and a mobile one.
 *
 *   the editor           A canvas-drawn editor loses the caret, the selection
 *                        handles and the keyboard's arrow keys. This is a real
 *                        <textarea> with transparent text over a highlighted
 *                        <pre>, so every native behaviour survives.
 *
 *   the selection bar    Pinned to the bottom on a phone. Actions at the top of
 *                        a long list are actions you cannot reach without
 *                        scrolling, and scrolling is where a selection gets
 *                        lost to a mistap.
 *
 *   uploads              One request per file, streamed, with real progress.
 *                        A multipart batch gives you one progress bar for
 *                        twelve files and loses all twelve when one fails.
 */
(function () {
  'use strict';

  var root = document.getElementById('fm');
  if (!root) return;

  var CSRF = root.dataset.csrf;
  var MAX_EDIT = Number(root.dataset.maxEdit) || 2097152;
  var MAX_UPLOAD = Number(root.dataset.maxUpload) || 536870912;

  /* Highlighting a very large file on every keystroke is slower than the
     keystroke. Past this the editor still opens — it just shows plain text. */
  var MAX_HIGHLIGHT = 200 * 1024;

  var el = {
    crumbs: document.getElementById('fm-crumbs'),
    list: document.getElementById('fm-list'),
    body: document.getElementById('fm-body'),
    empty: document.getElementById('fm-empty'),
    loading: document.getElementById('fm-loading'),
    foot: document.getElementById('fm-foot'),
    all: document.getElementById('fm-all'),
    selbar: document.getElementById('fm-selbar'),
    selcount: document.getElementById('fm-selcount'),
    search: document.getElementById('fm-search'),
    searchClear: document.getElementById('fm-search-clear'),
    file: document.getElementById('fm-file'),
    menu: document.getElementById('fm-menu'),
    toast: document.getElementById('fm-toast'),
    uploads: document.getElementById('fm-uploads'),
    uploadsList: document.getElementById('fm-uploads-list'),
    uploadsTitle: document.getElementById('fm-uploads-title'),
    dropnote: document.getElementById('fm-dropnote')
  };

  var state = {
    path: root.dataset.start || 'web',
    entries: [],
    selected: {},      // path -> true
    hidden: false,
    grid: false,
    wrap: true,
    searching: false,
    lastIndex: -1      // for shift-click ranges
  };

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function join(dir, name) { return dir ? dir + '/' + name : name; }
  function parentOf(p) { var i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function baseOf(p) { var i = String(p).lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }

  function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'], v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function when(epoch) {
    if (!epoch) return '';
    var d = new Date(epoch * 1000), now = new Date();
    var time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    // Today reads as a time; this year drops the year; older keeps it. A column
    // of identical years is a column carrying no information.
    if (d.toDateString() === now.toDateString()) return time;
    var stamp = d.getDate() + ' ' + MONTHS[d.getMonth()];
    return d.getFullYear() === now.getFullYear() ? stamp + ', ' + time : stamp + ' ' + d.getFullYear();
  }

  var toastTimer;
  function toast(message, bad) {
    el.toast.textContent = message;
    el.toast.classList.toggle('is-bad', !!bad);
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, bad ? 6000 : 3200);
  }

  var ICON = {
    folder: '<path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="M3.5 17l5-5 3.5 3.5 3-2.5 5.5 5"/>',
    box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
    code: '<path d="M9 18l-6-6 6-6M15 6l6 6-6 6"/>',
    dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    download: '<path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/><path d="M12 4v12M7.5 11.5L12 16l4.5-4.5"/>',
    pencil: '<path d="M4 20l4.5-1 10-10a2.1 2.1 0 10-3-3l-10 10z"/><path d="M14.5 6.5l3 3"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 5.5V5a2 2 0 00-2-2H5.5a2 2 0 00-2 2v8a2 2 0 002 2H6"/>',
    scissors: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8 7.5L20 18M20 6L8 16.5"/>',
    trash: '<path d="M4 6.5h16"/><path d="M9 6.5V4.5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M6.5 6.5L7.5 20a1.5 1.5 0 001.5 1.4h6a1.5 1.5 0 001.5-1.4l1-13.5"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
    eye: '<path d="M1.8 12S5.5 5.5 12 5.5 22.2 12 22.2 12 18.5 18.5 12 18.5 1.8 12 1.8 12z"/><circle cx="12" cy="12" r="3.2"/>',
    open: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/>'
  };

  function svg(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || '') + '</svg>';
  }

  function iconFor(entry) {
    if (entry.type === 'dir') return 'folder';
    if (entry['class'] === 'image') return 'image';
    if (entry['class'] === 'archive') return 'box';
    if (entry['class'] === 'text') return 'code';
    return 'file';
  }

  // -------------------------------------------------------------------------
  // Talking to the server
  // -------------------------------------------------------------------------

  /**
   * Every call returns the parsed body, or throws an Error whose message is
   * already fit to show a customer — the server writes those sentences and this
   * never invents one of its own.
   */
  function api(url, options) {
    var opts = options || {};
    opts.headers = opts.headers || {};
    opts.headers['X-CSRF-Token'] = CSRF;
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () {
        throw new Error('The server sent something unreadable.');
      }).then(function (data) {
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || 'That did not work.');
        }
        return data;
      });
    });
  }

  function post(op, payload) {
    return api('/panel/files/api/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  var loadToken = 0;

  function load(path, opts) {
    var options = opts || {};
    if (typeof path === 'string') state.path = path;
    state.searching = false;
    el.search.value = '';
    el.searchClear.hidden = true;

    var mine = ++loadToken;
    el.loading.hidden = false;
    el.empty.hidden = true;

    return api('/panel/files/api/list?path=' + encodeURIComponent(state.path) +
      '&hidden=' + (state.hidden ? '1' : '0'))
      .then(function (data) {
        // A slow answer for a folder the customer has already left must not
        // overwrite the folder they are now looking at.
        if (mine !== loadToken) return;
        state.path = data.path;
        state.entries = data.entries || [];
        state.selected = {};
        state.lastIndex = -1;
        render(data);
        if (!options.silent) pushUrl();
      })
      .catch(function (err) {
        if (mine !== loadToken) return;
        state.entries = [];
        render(null, err.message);
      })
      .then(function () {
        if (mine === loadToken) el.loading.hidden = true;
      });
  }

  function pushUrl() {
    var url = '/panel/files?path=' + encodeURIComponent(state.path);
    if (location.pathname + location.search !== url) {
      history.pushState({ path: state.path }, '', url);
    }
  }

  window.addEventListener('popstate', function (ev) {
    var path = (ev.state && ev.state.path);
    if (path == null) {
      var m = /[?&]path=([^&]*)/.exec(location.search);
      path = m ? decodeURIComponent(m[1]) : 'web';
    }
    load(path, { silent: true });
  });

  function sortEntries(list) {
    // Folders first, then case-insensitive by name. Anything else and a folder
    // called "zzz" hides below forty files.
    return list.slice().sort(function (a, b) {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  function render(data, errorMessage) {
    renderCrumbs();
    markChips();

    if (errorMessage) {
      el.list.innerHTML = '';
      el.empty.hidden = false;
      el.empty.innerHTML = '<b>' + esc(errorMessage) + '</b>' +
        '<span>Try refreshing, or go back to a folder you can reach.</span>';
      el.foot.textContent = '';
      setWritable(false);
      syncSelection();
      return;
    }

    var rows = sortEntries(state.entries);
    var html = '';
    for (var i = 0; i < rows.length; i++) html += rowHtml(rows[i], i);
    el.list.innerHTML = html;

    var empty = rows.length === 0;
    el.empty.hidden = !empty;
    if (empty) {
      el.empty.innerHTML = state.searching
        ? '<b>Nothing matched</b><span>Try a shorter word, or use * as a wildcard.</span>'
        : '<b>This folder is empty</b><span>Upload something, or create a file or folder.</span>';
    }

    var dirs = rows.filter(function (r) { return r.type === 'dir'; }).length;
    var size = rows.reduce(function (n, r) { return n + (r.type === 'file' ? (r.size || 0) : 0); }, 0);
    var parts = [
      rows.length + ' item' + (rows.length === 1 ? '' : 's'),
      dirs + ' folder' + (dirs === 1 ? '' : 's'),
      bytes(size) + ' of files'
    ];
    if (data && data.truncated) parts.push('showing the first ' + rows.length + ' only');
    el.foot.innerHTML = '<span>' + esc(parts.join(' · ')) + '</span>';

    /*
     * Some folders are not the customer's to write to — ~/web is owned by root
     * because HestiaCP creates websites, not people. Offering "New folder"
     * there and letting it fail is a worse answer than not offering it, so the
     * three creation buttons are disabled and the reason is said out loud.
     */
    setWritable(!data || data.writable !== false);

    syncSelection();
  }

  function rowHtml(entry, index) {
    var path = state.searching ? entry.path : join(state.path, entry.name);
    var sizeText = entry.type === 'dir' ? '—' : bytes(entry.size);
    var timeText = when(entry.mtime);
    var meta = [sizeText === '—' ? 'Folder' : sizeText, timeText, entry.mode].filter(Boolean).join(' · ');

    return '<div class="fm-row' + (entry.broken ? ' is-broken' : '') + '" role="listitem"' +
      ' data-path="' + esc(path) + '"' +
      ' data-name="' + esc(entry.name) + '"' +
      ' data-type="' + esc(entry.type) + '"' +
      ' data-class="' + esc(entry['class'] || '') + '"' +
      ' data-index="' + index + '">' +
        '<label class="fm-check"><input type="checkbox" tabindex="-1" aria-label="Select ' + esc(entry.name) + '"></label>' +
        '<button type="button" class="fm-name">' +
          '<span class="fm-ico">' + svg(iconFor(entry), state.grid ? 34 : 18) + '</span>' +
          '<span class="fm-name-text">' + esc(entry.name) + '</span>' +
          (entry.link ? '<span class="fm-link-tag">LINK</span>' : '') +
          (state.searching ? '<span class="fm-meta">in /' + esc(entry.dir || '') + '</span>'
                           : '<span class="fm-meta">' + esc(meta) + '</span>') +
        '</button>' +
        '<span class="fm-size">' + esc(sizeText) + '</span>' +
        '<span class="fm-time">' + esc(timeText) + '</span>' +
        '<span class="fm-mode">' + esc(entry.mode || '') + '</span>' +
        '<span class="fm-col-menu"><button type="button" class="fm-icon-btn fm-more" aria-label="Actions for ' + esc(entry.name) + '">' + svg('dots', 17) + '</button></span>' +
      '</div>';
  }

  var CREATE_BUTTONS = ['fm-upload-btn', 'fm-newfolder', 'fm-newfile'];

  function setWritable(writable) {
    root.classList.toggle('is-readonly', !writable);
    CREATE_BUTTONS.forEach(function (id) {
      var button = document.getElementById(id);
      button.disabled = !writable;
      button.title = writable ? '' : 'This folder belongs to the server — open a site folder to add files.';
    });
    if (!writable) {
      el.foot.innerHTML += '<span class="fm-readonly">' +
        'Read only — websites are created from the Hosting page. Open a site to edit its files.</span>';
    }
  }

  function renderCrumbs() {
    var parts = state.path ? state.path.split('/') : [];
    var html = '<button type="button" class="fm-crumb" data-path="">Home</button>';
    var walk = '';
    for (var i = 0; i < parts.length; i++) {
      walk = join(walk, parts[i]);
      var last = i === parts.length - 1;
      html += '<span class="fm-crumb-sep">/</span>' +
        '<button type="button" class="fm-crumb' + (last ? ' is-last' : '') + '" data-path="' + esc(walk) + '">' +
        esc(parts[i]) + '</button>';
    }
    el.crumbs.innerHTML = html;
  }

  function markChips() {
    root.querySelectorAll('.fm-chip').forEach(function (chip) {
      chip.classList.toggle('is-active', chip.dataset.go === state.path);
    });
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  function selectedPaths() { return Object.keys(state.selected); }

  function entryFor(path) {
    for (var i = 0; i < state.entries.length; i++) {
      var e = state.entries[i];
      // In search results an entry carries its own full path; in a normal
      // listing it is a name inside the folder being shown.
      if ((state.searching ? e.path : join(state.path, e.name)) === path) return e;
    }
    return null;
  }

  function syncSelection() {
    var paths = selectedPaths();
    el.selbar.hidden = paths.length === 0;
    el.selcount.textContent = paths.length + ' selected';

    var rows = el.list.querySelectorAll('.fm-row');
    var checkedVisible = 0;
    rows.forEach(function (row) {
      var on = !!state.selected[row.dataset.path];
      row.classList.toggle('is-selected', on);
      row.querySelector('.fm-check input').checked = on;
      if (on) checkedVisible++;
    });
    el.all.checked = rows.length > 0 && checkedVisible === rows.length;
    el.all.indeterminate = checkedVisible > 0 && checkedVisible < rows.length;
  }

  function toggle(path, on) {
    if (on === undefined) on = !state.selected[path];
    if (on) state.selected[path] = true; else delete state.selected[path];
  }

  function selectRange(from, to) {
    var rows = Array.prototype.slice.call(el.list.querySelectorAll('.fm-row'));
    var lo = Math.min(from, to), hi = Math.max(from, to);
    for (var i = lo; i <= hi; i++) if (rows[i]) state.selected[rows[i].dataset.path] = true;
  }

  el.all.addEventListener('change', function () {
    var rows = el.list.querySelectorAll('.fm-row');
    if (el.all.checked) rows.forEach(function (r) { state.selected[r.dataset.path] = true; });
    else state.selected = {};
    syncSelection();
  });

  // -------------------------------------------------------------------------
  // Opening things
  // -------------------------------------------------------------------------

  function open(path, entry) {
    if (!entry) return;
    if (entry.type === 'dir') return load(path);
    if (entry['class'] === 'image') return preview(path, entry.name);
    if (entry['class'] === 'text' || (entry.size || 0) <= MAX_EDIT) return edit(path, entry);
    return download(path);
  }

  function download(path) {
    // A plain navigation, not fetch(): the browser streams it straight to disk
    // and shows its own progress. A Blob would hold the whole file in memory
    // first, which on a phone is how a 300 MB download becomes a crash.
    var a = document.createElement('a');
    a.href = '/panel/files/download?path=' + encodeURIComponent(path);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadZip(paths, name) {
    var form = document.getElementById('fm-zipform');
    document.getElementById('fm-zipname').value = name;
    var box = document.getElementById('fm-zipinputs');
    box.innerHTML = '';
    paths.forEach(function (p) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'paths';
      input.value = p;
      box.appendChild(input);
    });
    form.submit();
  }

  // -------------------------------------------------------------------------
  // Events on the listing
  // -------------------------------------------------------------------------

  el.crumbs.addEventListener('click', function (ev) {
    var b = ev.target.closest('.fm-crumb');
    if (b && !b.classList.contains('is-last')) load(b.dataset.path);
  });

  root.querySelectorAll('.fm-chip').forEach(function (chip) {
    chip.addEventListener('click', function () { load(chip.dataset.go); });
  });

  el.list.addEventListener('click', function (ev) {
    var row = ev.target.closest('.fm-row');
    if (!row) return;
    var path = row.dataset.path;
    var index = Number(row.dataset.index);

    if (ev.target.closest('.fm-more')) {
      ev.preventDefault();
      openMenu(row, ev.target.closest('.fm-more'));
      return;
    }

    if (ev.target.closest('.fm-check')) {
      // The label already toggles the checkbox; read it after the event.
      setTimeout(function () {
        toggle(path, row.querySelector('.fm-check input').checked);
        state.lastIndex = index;
        syncSelection();
      }, 0);
      return;
    }

    if (ev.target.closest('.fm-name')) {
      // Ctrl/Cmd adds to a selection, Shift extends one, a plain click opens.
      // Same three gestures as every file manager on every desktop.
      if (ev.metaKey || ev.ctrlKey) {
        toggle(path);
        state.lastIndex = index;
        syncSelection();
        return;
      }
      if (ev.shiftKey && state.lastIndex >= 0) {
        selectRange(state.lastIndex, index);
        syncSelection();
        return;
      }
      open(path, entryFor(path));
    }
  });

  /* Long-press selects, on a touch screen where there is no Ctrl to hold. */
  var pressTimer = null;
  el.list.addEventListener('touchstart', function (ev) {
    var row = ev.target.closest('.fm-row');
    if (!row) return;
    pressTimer = setTimeout(function () {
      pressTimer = null;
      toggle(row.dataset.path, true);
      state.lastIndex = Number(row.dataset.index);
      syncSelection();
      if (navigator.vibrate) navigator.vibrate(12);
    }, 480);
  }, { passive: true });

  ['touchend', 'touchmove', 'touchcancel'].forEach(function (name) {
    el.list.addEventListener(name, function () {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }, { passive: true });
  });

  // -------------------------------------------------------------------------
  // The row menu
  // -------------------------------------------------------------------------

  function menuItem(act, iconName, label, danger) {
    return '<button type="button" data-act="' + act + '"' + (danger ? ' class="fm-danger"' : '') + '>' +
      svg(iconName, 16) + '<span>' + esc(label) + '</span></button>';
  }

  var menuFor = null;

  function openMenu(row, anchor) {
    var entry = entryFor(row.dataset.path);
    if (!entry) return;
    menuFor = row.dataset.path;

    var html = '';
    if (entry.type === 'dir') html += menuItem('open', 'open', 'Open');
    else if (entry['class'] === 'image') html += menuItem('open', 'eye', 'Preview');
    else html += menuItem('open', 'pencil', 'Edit');

    html += menuItem('download', 'download', entry.type === 'dir' ? 'Download as zip' : 'Download');
    if (entry['class'] === 'archive') html += menuItem('extract', 'box', 'Unpack here');
    html += '<hr>';
    html += menuItem('rename', 'pencil', 'Rename');
    html += menuItem('copy', 'copy', 'Copy to…');
    html += menuItem('move', 'scissors', 'Move to…');
    html += menuItem('compress', 'box', 'Compress to zip');
    html += menuItem('chmod', 'lock', 'Permissions');
    html += '<hr>';
    html += menuItem('delete', 'trash', 'Delete', true);

    el.menu.innerHTML = html;
    el.menu.hidden = false;

    // Positioned against the document, then nudged back inside the viewport —
    // a menu on the last row of a list otherwise opens below the fold.
    var box = anchor.getBoundingClientRect();
    var menuBox = el.menu.getBoundingClientRect();
    var left = box.right - menuBox.width + window.scrollX;
    var top = box.bottom + 5 + window.scrollY;
    if (box.bottom + menuBox.height + 12 > window.innerHeight) {
      top = box.top - menuBox.height - 5 + window.scrollY;
    }
    el.menu.style.left = Math.max(8 + window.scrollX, left) + 'px';
    el.menu.style.top = Math.max(8 + window.scrollY, top) + 'px';
  }

  function closeMenu() { el.menu.hidden = true; menuFor = null; }

  el.menu.addEventListener('click', function (ev) {
    var button = ev.target.closest('button[data-act]');
    if (!button || !menuFor) return;
    var path = menuFor;
    closeMenu();
    act(button.dataset.act, [path]);
  });

  document.addEventListener('click', function (ev) {
    if (!el.menu.hidden && !ev.target.closest('#fm-menu') && !ev.target.closest('.fm-more')) closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  el.selbar.addEventListener('click', function (ev) {
    var button = ev.target.closest('[data-act]');
    if (!button) return;
    if (button.dataset.act === 'clear') {
      state.selected = {};
      syncSelection();
      return;
    }
    act(button.dataset.act, selectedPaths());
  });

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function refresh() { return load(state.path, { silent: true }); }

  function act(what, paths) {
    if (!paths.length) return;
    var first = paths[0];
    var entry = entryFor(first);
    var one = paths.length === 1;

    if (what === 'open') return open(first, entry);

    if (what === 'download') {
      if (one && entry && entry.type !== 'dir') return download(first);
      return downloadZip(paths, one ? baseOf(first) + '.zip' : 'files.zip');
    }

    if (what === 'rename') {
      if (!one) return toast('Rename works on one item at a time.', true);
      return ask({
        title: 'Rename',
        label: 'New name',
        value: baseOf(first),
        ok: 'Rename',
        selectStem: true,
        run: function (value) {
          return post('rename', { path: first, name: value })
            .then(function () { toast('Renamed.'); refresh(); });
        }
      });
    }

    if (what === 'delete') {
      var what_ = one ? '“' + baseOf(first) + '”' : paths.length + ' items';
      return confirmAsk({
        title: 'Delete',
        note: 'Delete ' + what_ + '? Folders are deleted with everything inside them. ' +
              'This cannot be undone — there is no recycle bin.',
        ok: 'Delete',
        run: function () {
          return post('delete', { paths: paths }).then(function (out) {
            reportBatch(out, 'Deleted');
            refresh();
          });
        }
      });
    }

    if (what === 'chmod') {
      return ask({
        title: 'Permissions',
        label: 'Mode',
        value: (entry && entry.mode) || '644',
        ok: 'Apply',
        modes: true,
        run: function (value, extra) {
          return post('chmod', { paths: paths, mode: value, recursive: extra.recursive })
            .then(function (out) { reportBatch(out, 'Permissions set on'); refresh(); });
        }
      });
    }

    if (what === 'compress') {
      return ask({
        title: 'Compress to zip',
        label: 'Zip file name',
        value: (one ? baseOf(first) : baseOf(state.path) || 'archive') + '.zip',
        ok: 'Create zip',
        selectStem: true,
        run: function (value) {
          return post('compress', { paths: paths, dest: state.path, name: value })
            .then(function (out) { toast('Created ' + out.name + '.'); refresh(); });
        }
      });
    }

    if (what === 'extract') {
      if (!one) return toast('Unpack one archive at a time.', true);
      return confirmAsk({
        title: 'Unpack',
        note: 'Unpack “' + baseOf(first) + '” into this folder? Existing files with the ' +
              'same names will be overwritten.',
        ok: 'Unpack',
        run: function () {
          return post('extract', { path: first, dest: state.path }).then(function (out) {
            toast('Unpacked ' + out.extracted + ' file' + (out.extracted === 1 ? '' : 's') +
              (out.skipped ? ', skipped ' + out.skipped + ' unsafe entr' + (out.skipped === 1 ? 'y' : 'ies') : '') + '.');
            refresh();
          });
        }
      });
    }

    if (what === 'copy' || what === 'move') {
      return pickFolder(what === 'move' ? 'Move to' : 'Copy to', function (dest) {
        return post(what, { paths: paths, dest: dest }).then(function (out) {
          reportBatch(out, what === 'move' ? 'Moved' : 'Copied');
          refresh();
        });
      });
    }
  }

  /** A batch reports per-item failures rather than one blanket "it worked". */
  function reportBatch(out, verb) {
    var done = (out.done || []).length, failed = (out.failed || []);
    if (failed.length) {
      toast(verb + ' ' + done + ', but ' + failed.length + ' failed: ' + failed[0].error, true);
    } else {
      toast(verb + ' ' + done + ' item' + (done === 1 ? '' : 's') + '.');
    }
  }

  // -------------------------------------------------------------------------
  // The one prompt dialog
  // -------------------------------------------------------------------------

  var askEls = {
    modal: document.getElementById('fm-ask'),
    form: document.getElementById('fm-ask-form'),
    title: document.getElementById('fm-ask-title'),
    note: document.getElementById('fm-ask-note'),
    field: document.getElementById('fm-ask-field'),
    label: document.getElementById('fm-ask-label'),
    input: document.getElementById('fm-ask-input'),
    modes: document.getElementById('fm-ask-modes'),
    recursive: document.getElementById('fm-ask-recursive'),
    picker: document.getElementById('fm-ask-picker'),
    error: document.getElementById('fm-ask-error'),
    ok: document.getElementById('fm-ask-ok'),
    cancel: document.getElementById('fm-ask-cancel'),
    close: document.getElementById('fm-ask-close')
  };

  var askRun = null;

  function closeAsk() {
    askEls.modal.hidden = true;
    askRun = null;
  }

  function ask(config) {
    askEls.title.textContent = config.title;
    askEls.note.textContent = config.note || '';
    askEls.note.hidden = !config.note;
    askEls.label.textContent = config.label || 'Name';
    askEls.input.value = config.value || '';
    askEls.field.hidden = config.field === false;
    askEls.modes.hidden = !config.modes;
    askEls.picker.hidden = true;
    askEls.recursive.checked = false;
    askEls.error.hidden = true;
    askEls.ok.textContent = config.ok || 'Save';
    askEls.ok.classList.toggle('btn-danger', !!config.danger);
    askEls.modal.hidden = false;
    askRun = config.run;

    if (config.modes) syncModeBoxes();

    if (config.field !== false) {
      setTimeout(function () {
        askEls.input.focus();
        // Select the stem, not the extension: renaming "logo.png" is almost
        // always about the "logo".
        var dot = config.selectStem ? askEls.input.value.lastIndexOf('.') : -1;
        if (dot > 0) askEls.input.setSelectionRange(0, dot);
        else askEls.input.select();
      }, 30);
    }
  }

  function confirmAsk(config) {
    ask({
      title: config.title,
      note: config.note,
      field: false,
      ok: config.ok,
      danger: true,
      run: config.run
    });
  }

  askEls.form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!askRun) return;
    var value = askEls.input.value.trim();
    if (!askEls.field.hidden && !value) {
      askEls.error.textContent = 'Type a name first.';
      askEls.error.hidden = false;
      return;
    }
    askEls.ok.disabled = true;
    askEls.error.hidden = true;
    var run = askRun;
    Promise.resolve(run(value, { recursive: askEls.recursive.checked }))
      .then(function () { closeAsk(); })
      .catch(function (err) {
        askEls.error.textContent = err.message;
        askEls.error.hidden = false;
      })
      .then(function () { askEls.ok.disabled = false; });
  });

  askEls.cancel.addEventListener('click', closeAsk);
  askEls.close.addEventListener('click', closeAsk);
  askEls.modal.addEventListener('click', function (ev) {
    if (ev.target === askEls.modal) closeAsk();
  });

  /* The permission checkboxes and the number are two views of one value. */
  function syncModeBoxes() {
    var mode = (askEls.input.value || '000').padStart(3, '0').slice(-3);
    var digits = [Number(mode[0]), Number(mode[1]), Number(mode[2])];
    // The boxes are in document order: owner rwx, group rwx, everyone rwx.
    askEls.modes.querySelectorAll('input[data-bit]').forEach(function (box, i) {
      var group = Math.floor(i / 3);       // 0 owner, 1 group, 2 everyone
      var bit = [4, 2, 1][i % 3];          // read, write, run
      box.checked = (digits[group] & bit) === bit;
    });
  }

  function modeFromBoxes() {
    var digits = [0, 0, 0];
    askEls.modes.querySelectorAll('input[data-bit]').forEach(function (box, i) {
      if (box.checked) digits[Math.floor(i / 3)] += [4, 2, 1][i % 3];
    });
    return digits.join('');
  }

  askEls.modes.addEventListener('change', function (ev) {
    if (ev.target.dataset.bit) askEls.input.value = modeFromBoxes();
  });
  askEls.input.addEventListener('input', function () {
    if (!askEls.modes.hidden && /^[0-7]{3}$/.test(askEls.input.value)) syncModeBoxes();
  });

  // -------------------------------------------------------------------------
  // Destination picker (move / copy)
  // -------------------------------------------------------------------------

  var pickerPath = '';

  function pickFolder(title, run) {
    pickerPath = state.path;
    ask({
      title: title,
      field: false,
      ok: 'Choose this folder',
      run: function () { return run(pickerPath); }
    });
    askEls.picker.hidden = false;
    drawPicker();
  }

  function drawPicker() {
    var crumbs = document.getElementById('fm-picker-crumbs');
    var list = document.getElementById('fm-picker-list');

    var parts = pickerPath ? pickerPath.split('/') : [];
    var html = '<button type="button" class="fm-crumb" data-pick="">Home</button>';
    var walk = '';
    parts.forEach(function (part) {
      walk = join(walk, part);
      html += '<span class="fm-crumb-sep">/</span><button type="button" class="fm-crumb" data-pick="' +
        esc(walk) + '">' + esc(part) + '</button>';
    });
    crumbs.innerHTML = html;

    list.innerHTML = '<div class="fm-picker-empty">Loading…</div>';
    api('/panel/files/api/list?path=' + encodeURIComponent(pickerPath) + '&hidden=0')
      .then(function (data) {
        var dirs = (data.entries || []).filter(function (e) { return e.type === 'dir'; });
        dirs.sort(function (a, b) { return a.name.localeCompare(b.name); });
        if (!dirs.length) {
          list.innerHTML = '<div class="fm-picker-empty">No folders in here — choose this one.</div>';
          return;
        }
        list.innerHTML = dirs.map(function (d) {
          return '<button type="button" class="fm-picker-row" data-pick="' + esc(join(pickerPath, d.name)) + '">' +
            svg('folder', 17) + '<span>' + esc(d.name) + '</span></button>';
        }).join('');
      })
      .catch(function (err) {
        list.innerHTML = '<div class="fm-picker-empty">' + esc(err.message) + '</div>';
      });
  }

  askEls.picker.addEventListener('click', function (ev) {
    var button = ev.target.closest('[data-pick]');
    if (!button) return;
    ev.preventDefault();
    pickerPath = button.dataset.pick;
    drawPicker();
  });

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  document.getElementById('fm-newfolder').addEventListener('click', function () {
    ask({
      title: 'New folder', label: 'Folder name', value: '', ok: 'Create',
      run: function (value) {
        return post('mkdir', { path: state.path, name: value })
          .then(function () { toast('Folder created.'); refresh(); });
      }
    });
  });

  document.getElementById('fm-newfile').addEventListener('click', function () {
    ask({
      title: 'New file', label: 'File name', value: '', ok: 'Create',
      run: function (value) {
        return post('touch', { path: state.path, name: value }).then(function () {
          toast('File created.');
          return refresh().then(function () { edit(join(state.path, value), { size: 0 }); });
        });
      }
    });
  });

  document.getElementById('fm-refresh').addEventListener('click', function (ev) {
    var button = ev.currentTarget;
    button.classList.add('is-spinning');
    refresh().then(function () { button.classList.remove('is-spinning'); });
  });

  document.getElementById('fm-hidden').addEventListener('click', function (ev) {
    state.hidden = !state.hidden;
    ev.currentTarget.classList.toggle('is-on', state.hidden);
    ev.currentTarget.setAttribute('aria-pressed', String(state.hidden));
    refresh();
  });

  document.getElementById('fm-view').addEventListener('click', function (ev) {
    state.grid = !state.grid;
    root.classList.toggle('is-grid', state.grid);
    ev.currentTarget.querySelector('[data-when="list"]').hidden = state.grid;
    ev.currentTarget.querySelector('[data-when="grid"]').hidden = !state.grid;
    try { localStorage.setItem('fm-view', state.grid ? 'grid' : 'list'); } catch (e) { /* private mode */ }
    render({ writable: true });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  var searchTimer;
  el.search.addEventListener('input', function () {
    var query = el.search.value.trim();
    el.searchClear.hidden = !query;
    clearTimeout(searchTimer);
    if (query.length < 2) {
      if (state.searching) load(state.path, { silent: true });
      return;
    }
    searchTimer = setTimeout(function () { runSearch(query); }, 320);
  });

  el.searchClear.addEventListener('click', function () {
    el.search.value = '';
    el.searchClear.hidden = true;
    load(state.path, { silent: true });
  });

  function runSearch(query) {
    var mine = ++loadToken;
    el.loading.hidden = false;
    api('/panel/files/api/search?path=' + encodeURIComponent(state.path) + '&q=' + encodeURIComponent(query))
      .then(function (data) {
        if (mine !== loadToken) return;
        state.searching = true;
        state.entries = data.entries || [];
        state.selected = {};
        render(data);
        el.foot.innerHTML = '<span>' + state.entries.length + ' match' +
          (state.entries.length === 1 ? '' : 'es') +
          (data.truncated ? ' — stopped early, narrow the search' : '') + '</span>';
      })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { if (mine === loadToken) el.loading.hidden = true; });
  }

  // -------------------------------------------------------------------------
  // Uploads
  // -------------------------------------------------------------------------

  document.getElementById('fm-upload-btn').addEventListener('click', function () { el.file.click(); });
  el.file.addEventListener('change', function () {
    uploadAll(Array.prototype.slice.call(el.file.files));
    el.file.value = '';
  });

  document.getElementById('fm-uploads-close').addEventListener('click', function () {
    el.uploads.hidden = true;
    el.uploadsList.innerHTML = '';
  });

  var dragDepth = 0;
  ['dragenter', 'dragover'].forEach(function (name) {
    el.body.addEventListener(name, function (ev) {
      if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') < 0) return;
      ev.preventDefault();
      if (name === 'dragenter') dragDepth++;
      root.classList.add('is-dropping');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    el.body.addEventListener(name, function (ev) {
      if (name === 'dragleave') { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth) return; }
      else { ev.preventDefault(); dragDepth = 0; }
      root.classList.remove('is-dropping');
      if (name === 'drop' && ev.dataTransfer) {
        uploadAll(Array.prototype.slice.call(ev.dataTransfer.files));
      }
    });
  });

  function uploadAll(list) {
    if (!list.length) return;
    var target = state.path;      // where they were when they dropped, not where they end up
    el.uploads.hidden = false;
    el.uploadsTitle.textContent = 'Uploading ' + list.length + ' file' + (list.length === 1 ? '' : 's');

    var queue = list.slice(), active = 0, finished = 0, failed = 0;

    function next() {
      // Three at a time. One is slow on a fast line; ten starves the connection
      // and every progress bar crawls together.
      while (active < 3 && queue.length) {
        active++;
        uploadOne(queue.shift(), target, function (ok) {
          active--;
          finished++;
          if (!ok) failed++;
          if (!queue.length && !active) {
            el.uploadsTitle.textContent = failed
              ? finished - failed + ' uploaded, ' + failed + ' failed'
              : finished + ' file' + (finished === 1 ? '' : 's') + ' uploaded';
            if (target === state.path) refresh();
          }
          next();
        });
      }
    }
    next();
  }

  function uploadOne(file, target, done) {
    var row = document.createElement('div');
    row.className = 'fm-up';
    row.innerHTML = '<div class="fm-up-name"><span>' + esc(file.name) + '</span>' +
      '<span class="fm-up-pct">0%</span></div>' +
      '<div class="fm-up-track"><div class="fm-up-fill"></div></div>';
    el.uploadsList.appendChild(row);
    var pct = row.querySelector('.fm-up-pct');
    var fill = row.querySelector('.fm-up-fill');

    if (file.size > MAX_UPLOAD) {
      row.classList.add('is-failed');
      pct.textContent = 'too large';
      return done(false);
    }

    /*
     * XMLHttpRequest rather than fetch, for one reason: upload progress.
     * `fetch` still cannot report how much of a request body has been sent, and
     * a 200 MB upload with no progress bar is indistinguishable from one that
     * has frozen.
     */
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', '/panel/files/api/upload?path=' + encodeURIComponent(target) +
      '&name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('X-CSRF-Token', CSRF);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = function (ev) {
      if (!ev.lengthComputable) return;
      var value = Math.round((ev.loaded / ev.total) * 100);
      fill.style.width = value + '%';
      pct.textContent = value + '%';
    };
    xhr.onload = function () {
      var ok = xhr.status >= 200 && xhr.status < 300;
      var message = '';
      try { message = (JSON.parse(xhr.responseText) || {}).error || ''; } catch (e) { /* not JSON */ }
      row.classList.add(ok ? 'is-done' : 'is-failed');
      pct.textContent = ok ? 'done' : (message || 'failed');
      if (ok) fill.style.width = '100%';
      done(ok);
    };
    xhr.onerror = function () {
      row.classList.add('is-failed');
      pct.textContent = 'failed';
      done(false);
    };
    xhr.send(file);
  }

  // -------------------------------------------------------------------------
  // Image preview
  // -------------------------------------------------------------------------

  var pv = {
    modal: document.getElementById('fm-preview'),
    img: document.getElementById('fm-preview-img'),
    name: document.getElementById('fm-preview-name'),
    dl: document.getElementById('fm-preview-dl')
  };

  function preview(path, name) {
    pv.name.textContent = name;
    pv.img.src = '/panel/files/download?inline=1&path=' + encodeURIComponent(path);
    pv.img.alt = name;
    pv.dl.href = '/panel/files/download?path=' + encodeURIComponent(path);
    pv.modal.hidden = false;
  }

  function closePreview() { pv.modal.hidden = true; pv.img.src = ''; }
  document.getElementById('fm-preview-close').addEventListener('click', closePreview);
  pv.modal.addEventListener('click', function (ev) { if (ev.target === pv.modal) closePreview(); });

  // -------------------------------------------------------------------------
  // Editor
  // -------------------------------------------------------------------------

  var ed = {
    modal: document.getElementById('fm-editor'),
    name: document.getElementById('fm-editor-name'),
    path: document.getElementById('fm-editor-path'),
    state: document.getElementById('fm-editor-state'),
    save: document.getElementById('fm-editor-save'),
    close: document.getElementById('fm-editor-close'),
    wrap: document.getElementById('fm-editor-wrap'),
    ta: document.getElementById('fm-ta'),
    hl: document.getElementById('fm-hl').querySelector('code'),
    hlBox: document.getElementById('fm-hl'),
    gutter: document.getElementById('fm-gutter')
  };

  var editing = { path: null, saved: '', lang: 'none', big: false };

  function edit(path, entry) {
    if (entry && entry.size > MAX_EDIT) {
      return toast('That file is too large to edit here — download it instead.', true);
    }
    editing.path = path;
    editing.lang = langFor(baseOf(path));
    ed.name.textContent = baseOf(path);
    ed.path.textContent = '/' + path;
    ed.ta.value = '';
    ed.hl.innerHTML = '';
    setEditorState('Loading…', '');
    ed.modal.hidden = false;

    fetch('/panel/files/api/read?path=' + encodeURIComponent(path), { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error(data.error || 'That file could not be opened.');
          });
        }
        return res.text();
      })
      .then(function (text) {
        editing.saved = text;
        editing.big = text.length > MAX_HIGHLIGHT;
        ed.ta.value = text;
        /*
         * Start at the top of the file, not the bottom.
         *
         * Assigning `.value` leaves the caret at the end in WebKit, and the
         * `focus()` below then scrolls to it — so opening a file showed its
         * last line, which reads as the editor having failed to load the rest.
         * The three scroll positions are reset together because the gutter and
         * the highlight layer are scrolled in step with the textarea.
         */
        ed.ta.selectionStart = ed.ta.selectionEnd = 0;
        ed.ta.scrollTop = ed.ta.scrollLeft = 0;
        ed.hlBox.scrollTop = ed.hlBox.scrollLeft = 0;
        ed.gutter.scrollTop = 0;
        paint();
        setEditorState(editing.big ? 'Large file — highlighting off' : 'Ready', '');
        if (!isTouch()) ed.ta.focus();
      })
      .catch(function (err) {
        setEditorState(err.message, 'error');
      });
  }

  function isTouch() { return window.matchMedia('(pointer: coarse)').matches; }

  function setEditorState(text, kind) {
    ed.state.textContent = text;
    ed.state.className = 'fm-editor-state' + (kind ? ' is-' + kind : '');
  }

  function closeEditor(force) {
    if (!force && ed.ta.value !== editing.saved) {
      return confirmAsk({
        title: 'Close without saving',
        note: 'You have changes in “' + baseOf(editing.path) + '” that have not been saved.',
        ok: 'Discard changes',
        run: function () { ed.modal.hidden = true; editing.path = null; }
      });
    }
    ed.modal.hidden = true;
    editing.path = null;
  }

  ed.close.addEventListener('click', function () { closeEditor(false); });

  ed.save.addEventListener('click', function () {
    if (!editing.path) return;
    var text = ed.ta.value;
    ed.save.disabled = true;
    setEditorState('Saving…', '');
    fetch('/panel/files/api/write?path=' + encodeURIComponent(editing.path), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-CSRF-Token': CSRF },
      body: text
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || data.ok === false) throw new Error(data.error || 'That could not be saved.');
          return data;
        });
      })
      .then(function () {
        editing.saved = text;
        setEditorState('Saved', 'saved');
        refresh();
      })
      .catch(function (err) { setEditorState(err.message, 'error'); })
      .then(function () { ed.save.disabled = false; });
  });

  ed.wrap.addEventListener('click', function () {
    state.wrap = !state.wrap;
    root.classList.toggle('is-wrap', state.wrap);
    ed.wrap.setAttribute('aria-pressed', String(state.wrap));
    paint();
  });

  var paintTimer;
  ed.ta.addEventListener('input', function () {
    if (ed.ta.value !== editing.saved) setEditorState('Unsaved changes', 'dirty');
    clearTimeout(paintTimer);
    // Repainting on every keystroke of a large file is slower than typing.
    paintTimer = setTimeout(paint, 90);
  });

  ed.ta.addEventListener('scroll', function () {
    ed.hlBox.scrollTop = ed.ta.scrollTop;
    ed.hlBox.scrollLeft = ed.ta.scrollLeft;
    ed.gutter.scrollTop = ed.ta.scrollTop;
  });

  /* Tab inserts a tab instead of leaving the editor. Escape is how you get out. */
  ed.ta.addEventListener('keydown', function (ev) {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      var start = ed.ta.selectionStart, end = ed.ta.selectionEnd;
      ed.ta.value = ed.ta.value.slice(0, start) + '\t' + ed.ta.value.slice(end);
      ed.ta.selectionStart = ed.ta.selectionEnd = start + 1;
      setEditorState('Unsaved changes', 'dirty');
      paint();
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      ed.save.click();
    }
  });

  function paint() {
    var text = ed.ta.value;
    ed.hl.innerHTML = editing.big ? esc(text) : highlight(text, editing.lang);
    if (!state.wrap) {
      var lines = text.split('\n').length;
      var numbers = '';
      for (var i = 1; i <= lines; i++) numbers += i + '\n';
      ed.gutter.textContent = numbers;
      ed.gutter.hidden = false;
    } else {
      // Wrapped lines and a fixed gutter cannot agree, and a gutter that
      // silently numbers the wrong rows is worse than no gutter.
      ed.gutter.hidden = true;
    }
    ed.hlBox.scrollTop = ed.ta.scrollTop;
    ed.hlBox.scrollLeft = ed.ta.scrollLeft;
  }

  // -------------------------------------------------------------------------
  // Syntax highlighting
  // -------------------------------------------------------------------------

  /*
   * Six roles, not sixty. Every rule below is written with (?: ) groups only —
   * a capturing group inside one would shift every index in the combined
   * expression and colour the wrong token.
   */
  var STR = '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`';
  var NUM = '\\b(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b';

  var LANGS = {
    js: [
      ['tk-com', '/\\*[\\s\\S]*?\\*/|//[^\\n]*'],
      ['tk-str', STR],
      ['tk-key', '\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|default|delete|void|null|undefined|true|false)\\b'],
      ['tk-num', NUM],
      ['tk-fn', '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()']
    ],
    css: [
      ['tk-com', '/\\*[\\s\\S]*?\\*/'],
      ['tk-str', STR],
      ['tk-key', '@[a-zA-Z-]+'],
      ['tk-att', '[-a-zA-Z]+(?=\\s*:)'],
      ['tk-num', '#[0-9a-fA-F]{3,8}\\b|' + NUM + '(?:px|r?em|%|vh|vw|s|ms|deg|fr)?']
    ],
    html: [
      ['tk-com', '<!--[\\s\\S]*?-->'],
      ['tk-str', STR],
      ['tk-tag', '</?[a-zA-Z][\\w:-]*|/?>'],
      ['tk-att', '\\b[a-zA-Z-][\\w:-]*(?=\\s*=)']
    ],
    php: [
      ['tk-com', '/\\*[\\s\\S]*?\\*/|//[^\\n]*|#[^\\n]*'],
      ['tk-str', STR],
      ['tk-key', '<\\?php|\\?>|\\b(?:function|return|if|else|elseif|foreach|for|while|as|new|class|public|private|protected|static|echo|print|require|require_once|include|include_once|use|namespace|try|catch|finally|throw|array|null|true|false)\\b'],
      ['tk-num', NUM],
      ['tk-att', '\\$[A-Za-z_]\\w*']
    ],
    py: [
      ['tk-com', '#[^\\n]*'],
      ['tk-str', '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + STR],
      ['tk-key', '\\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|try|except|finally|raise|with|lambda|None|True|False|pass|break|continue|global|yield|async|await)\\b'],
      ['tk-num', NUM]
    ],
    sh: [
      ['tk-com', '#[^\\n]*'],
      ['tk-str', STR],
      ['tk-key', '\\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|source|echo|exit)\\b'],
      ['tk-att', '\\$\\{?[A-Za-z_]\\w*\\}?'],
      ['tk-num', NUM]
    ],
    sql: [
      ['tk-com', '--[^\\n]*|/\\*[\\s\\S]*?\\*/'],
      ['tk-str', STR],
      ['tk-key', '\\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|ORDER|BY|LIMIT|OFFSET|AND|OR|NOT|NULL|AS|DEFAULT|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE)\\b'],
      ['tk-num', NUM]
    ],
    yaml: [
      ['tk-com', '#[^\\n]*'],
      ['tk-str', STR],
      ['tk-att', '^[ \\t]*[-\\w.]+(?=\\s*:)'],
      ['tk-num', NUM]
    ],
    md: [
      ['tk-key', '^#{1,6}[^\\n]*'],
      ['tk-str', '`[^`\\n]*`|```[\\s\\S]*?```'],
      ['tk-tag', '^\\s*[-*+](?=\\s)|^\\s*\\d+\\.(?=\\s)'],
      ['tk-fn', '\\[[^\\]\\n]*\\]\\([^)\\n]*\\)']
    ]
  };

  var EXT_LANG = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'js',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', ejs: 'html', tpl: 'html', twig: 'html',
    php: 'php',
    py: 'py',
    sh: 'sh', bash: 'sh', zsh: 'sh', env: 'sh', conf: 'sh', ini: 'sh', htaccess: 'sh',
    sql: 'sql',
    yml: 'yaml', yaml: 'yaml', toml: 'yaml',
    md: 'md', markdown: 'md'
  };

  function langFor(name) {
    var lower = name.toLowerCase();
    if (lower.charAt(0) === '.' && lower.indexOf('.', 1) < 0) return EXT_LANG[lower.slice(1)] || 'sh';
    var ext = lower.indexOf('.') >= 0 ? lower.split('.').pop() : '';
    return EXT_LANG[ext] || 'none';
  }

  var compiled = {};
  function rulesFor(lang) {
    if (compiled[lang]) return compiled[lang];
    var rules = LANGS[lang];
    if (!rules) return null;
    compiled[lang] = {
      re: new RegExp(rules.map(function (r) { return '(' + r[1] + ')'; }).join('|'), 'gm'),
      classes: rules.map(function (r) { return r[0]; })
    };
    return compiled[lang];
  }

  function highlight(code, lang) {
    var set = rulesFor(lang);
    if (!set) return esc(code);
    var out = '', last = 0, match;
    set.re.lastIndex = 0;
    while ((match = set.re.exec(code)) !== null) {
      if (match[0] === '') { set.re.lastIndex++; continue; }
      out += esc(code.slice(last, match.index));
      var which = 0;
      for (var i = 1; i < match.length; i++) {
        if (match[i] !== undefined) { which = i - 1; break; }
      }
      out += '<span class="' + set.classes[which] + '">' + esc(match[0]) + '</span>';
      last = match.index + match[0].length;
    }
    return out + esc(code.slice(last));
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (!el.menu.hidden) return closeMenu();
      if (!ed.modal.hidden) return closeEditor(false);
      if (!pv.modal.hidden) return closePreview();
      if (!askEls.modal.hidden) return closeAsk();
      if (selectedPaths().length) { state.selected = {}; syncSelection(); }
      return;
    }

    // Everything below is a shortcut for the listing, and must not fire while
    // somebody is typing a filename or editing a file.
    var tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || ev.target.isContentEditable) return;
    if (!ed.modal.hidden || !askEls.modal.hidden) return;

    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      el.all.checked = true;
      el.all.dispatchEvent(new Event('change'));
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (selectedPaths().length) { ev.preventDefault(); act('delete', selectedPaths()); }
      return;
    }
    if (ev.key === 'F2' && selectedPaths().length === 1) {
      ev.preventDefault();
      act('rename', selectedPaths());
      return;
    }
    if (ev.key === '/' ) { ev.preventDefault(); el.search.focus(); }
  });

  /* A tab closed with unsaved work in the editor should say so. */
  window.addEventListener('beforeunload', function (ev) {
    if (editing.path && ed.ta.value !== editing.saved) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  try {
    if (localStorage.getItem('fm-view') === 'grid') {
      state.grid = true;
      root.classList.add('is-grid');
      var viewBtn = document.getElementById('fm-view');
      viewBtn.querySelector('[data-when="list"]').hidden = true;
      viewBtn.querySelector('[data-when="grid"]').hidden = false;
    }
  } catch (e) { /* private browsing: the default view is fine */ }

  root.classList.toggle('is-wrap', state.wrap);
  history.replaceState({ path: state.path }, '', '/panel/files?path=' + encodeURIComponent(state.path));
  load(state.path, { silent: true });
})();
