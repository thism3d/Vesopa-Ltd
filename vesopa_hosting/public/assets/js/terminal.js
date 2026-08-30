/**
 * The web terminal, browser side.
 *
 * Loaded after xterm.js and the fit addon, which are vendored in
 * /assets/vendor/xterm/ rather than pulled from a CDN — this site's CSP is
 * `script-src 'self'` and it loads nothing from a third-party origin.
 *
 * The two things that make a terminal usable on a phone, and which most web
 * terminals get wrong:
 *
 *   the keys that are not on the keyboard   A phone keyboard has no Esc, no
 *       Tab, no Ctrl and no arrows, and those are most of what a shell needs.
 *       There is a key bar for them, and Ctrl is a sticky modifier rather than
 *       a chord, because you cannot hold two soft keys at once.
 *
 *   the keyboard changing the window size   On a phone the keyboard covers the
 *       viewport without resizing it, so a terminal sized to `window` puts its
 *       prompt underneath the keyboard. visualViewport is the thing that
 *       actually reports the visible area, and it is what this listens to.
 */
(function () {
  'use strict';

  var mount = document.getElementById('terminal');
  if (!mount || typeof Terminal === 'undefined') return;

  var statusEl = document.getElementById('term-status');
  var barEl = document.getElementById('term-keys');
  var reconnectEl = document.getElementById('term-reconnect');
  var shell = document.querySelector('.term-shell');

  var socket = null;
  var closedByUs = false;
  var ctrlSticky = false;
  var encoder = new TextEncoder();

  var term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontSize: window.innerWidth < 700 ? 12 : 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    scrollback: 5000,
    // A phone cannot show 80 columns at a readable size; xterm reflows to
    // whatever fit() works out, and the pty is told the same number.
    theme: {
      background: '#10130A',
      foreground: '#E6EDD5',
      cursor: '#A5C715',
      selectionBackground: 'rgba(165,199,21,.35)',
    },
  });

  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(mount);

  function status(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'term-status' + (kind ? ' is-' + kind : '');
  }

  /**
   * Resize the terminal to the space actually visible, and tell the shell.
   *
   * The pty has to be told, or a full-screen program (vi, top, less) draws to
   * the size it was given at start and the display tears the moment the window
   * changes. `fit()` can throw while the element is hidden — a tab switch, or
   * the page still laying out — and that must not take the session down.
   */
  function resize() {
    try {
      fit.fit();
    } catch (e) {
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }

  /**
   * On a phone the keyboard overlays the page rather than resizing it, so
   * `window.innerHeight` still reports the full screen and the prompt ends up
   * behind the keyboard. visualViewport reports what can actually be seen.
   */
  function applyViewport() {
    if (!shell || !window.visualViewport) return;
    var vv = window.visualViewport;
    var top = shell.getBoundingClientRect().top;
    var available = vv.height - top - 8;
    if (available > 140) shell.style.height = available + 'px';
    resize();
  }

  function connect() {
    closedByUs = false;
    status('Connecting…', 'busy');
    if (reconnectEl) reconnectEl.hidden = true;

    var scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(scheme + '//' + window.location.host + '/panel/terminal/ws');
    socket.binaryType = 'arraybuffer';

    socket.onopen = function () {
      status('Connected', 'ok');
      resize();
      term.focus();
    };

    socket.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        // Text frames are control messages, never shell output.
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && msg.type === 'notice') {
          term.write('\r\n\x1b[33m' + msg.text + '\x1b[0m\r\n');
          status(msg.text, 'warn');
        }
        return;
      }
      term.write(new Uint8Array(ev.data));
    };

    socket.onclose = function () {
      if (!closedByUs) {
        term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
        status('Disconnected', 'warn');
        if (reconnectEl) reconnectEl.hidden = false;
      }
    };

    socket.onerror = function () {
      status('Connection problem', 'warn');
    };
  }

  // ---- keyboard ------------------------------------------------------------

  term.onData(function (data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Binary, matching what the server expects for keystrokes; text frames are
    // reserved for control messages in both directions.
    socket.send(encoder.encode(data));
  });

  function send(text) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encoder.encode(text));
    term.focus();
  }

  /**
   * Ctrl as a sticky modifier.
   *
   * You cannot hold Ctrl and press C on a touch screen, so the bar's Ctrl key
   * arms the next keystroke instead. Handled here rather than in onData because
   * by then the key has already been encoded as its plain character, and the
   * control code has to be derived from the letter itself.
   */
  term.attachCustomKeyEventHandler(function (ev) {
    if (!ctrlSticky || ev.type !== 'keydown') return true;
    if (ev.key.length !== 1) return true;
    var code = ev.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      send(String.fromCharCode(code - 64));
      setCtrl(false);
      return false;
    }
    setCtrl(false);
    return true;
  });

  function setCtrl(on) {
    ctrlSticky = on;
    var btn = barEl && barEl.querySelector('[data-ctrl]');
    if (btn) btn.classList.toggle('is-on', on);
  }

  if (barEl) {
    barEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (!btn) return;
      ev.preventDefault();

      if (btn.hasAttribute('data-ctrl')) { setCtrl(!ctrlSticky); return; }

      var seq = btn.getAttribute('data-send');
      if (seq !== null) {
        // Written as escapes in the HTML so the markup stays readable.
        send(seq.replace(/\\x1b/g, '\x1b').replace(/\\t/g, '\t').replace(/\\r/g, '\r'));
        return;
      }

      var zoom = btn.getAttribute('data-zoom');
      if (zoom) {
        var next = term.options.fontSize + (zoom === 'in' ? 1 : -1);
        term.options.fontSize = Math.max(9, Math.min(24, next));
        resize();
      }
    });
  }

  if (reconnectEl) {
    reconnectEl.addEventListener('click', function (ev) {
      ev.preventDefault();
      term.reset();
      connect();
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  window.addEventListener('resize', applyViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyViewport);
    window.visualViewport.addEventListener('scroll', applyViewport);
  }

  // A close on unload rather than letting it time out: the broker holds a shell
  // open for the idle timeout otherwise, and a customer refreshing a few times
  // would hit the concurrent-session cap against their own dead sessions.
  window.addEventListener('pagehide', function () {
    closedByUs = true;
    if (socket) socket.close();
  });

  applyViewport();
  connect();
}());
