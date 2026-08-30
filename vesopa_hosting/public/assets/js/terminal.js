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
   * Size the terminal to what is actually visible.
   *
   * ---------------------------------------------------------------------------
   * THE BUG THIS FIXES: "terminal scrolling on the iPad goes infinity scroll"
   * ---------------------------------------------------------------------------
   * The old version was `vv.height - shell.getBoundingClientRect().top - 8`,
   * and that is a feedback loop. `top` is measured RELATIVE TO THE VIEWPORT, so
   * scrolling down makes it negative; a negative `top` makes `available` bigger
   * than the screen; the shell grows; the page grows; there is now more to
   * scroll, so `top` goes further negative — and this ran on every
   * visualViewport `scroll` event. On a desktop you never scroll far enough to
   * notice. On an iPad, where the address bar collapsing fires the same event,
   * it runs away and the page grows without limit.
   *
   * Two changes stop it dead:
   *
   *   `top` is CLAMPED AT ZERO. An element scrolled above the viewport
   *   contributes nothing, rather than contributing negative height.
   *
   *   the result can never exceed the viewport. Whatever the arithmetic says,
   *   the terminal is at most one screen tall, so growing it can never create
   *   more page to scroll. The loop has no way to feed itself.
   *
   * It also returns early when the height has not actually changed, because
   * writing an identical `style.height` still invalidates layout, and this runs
   * on every scroll event.
   */
  var lastHeight = 0;

  function applyViewport() {
    if (!shell || !window.visualViewport) return;
    var vv = window.visualViewport;
    var top = Math.max(0, shell.getBoundingClientRect().top);
    var available = Math.min(vv.height - 8, vv.height - top - 8);
    if (available < 140) return;
    var next = Math.round(available);
    if (next === lastHeight) return;
    lastHeight = next;
    shell.style.height = next + 'px';
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

      /*
       * Scrolling the buffer is a CLIENT-side act: it moves the view over
       * output the shell has already produced, and the shell must never see it.
       * Sending PageUp as an escape sequence instead — which is the obvious
       * thing to try — types into whatever program is running, so in `less` it
       * pages the file and at a prompt it inserts junk.
       */
      var scroll = btn.getAttribute('data-scroll');
      if (scroll) {
        if (scroll === 'end') term.scrollToBottom();
        else term.scrollPages(scroll === 'up' ? -1 : 1);
        updateJump();
        term.focus();
        return;
      }

      var zoom = btn.getAttribute('data-zoom');
      if (zoom) {
        var next = term.options.fontSize + (zoom === 'in' ? 1 : -1);
        term.options.fontSize = Math.max(9, Math.min(24, next));
        // The row height changed, so the gesture's own measurement is stale.
        touch.carried = 0;
        resize();
      }
    });
  }

  // ---- scrolling the buffer, on a touch screen -----------------------------
  //
  // A shell's history is the thing you most need on a phone and the thing a
  // touch screen is worst at reaching. xterm's own touch handling scrolls the
  // PAGE, not the buffer, so `less` and a long build log were both unreadable:
  // you swiped and the panel moved instead of the output.
  //
  // TWO FINGERS SCROLL THE BUFFER. One finger is left alone deliberately —
  // that is how you place the cursor and how you select text, and stealing it
  // would break both. Two fingers is unambiguous, it is the gesture a trackpad
  // already uses for exactly this, and nothing else on the page wants it.

  var touch = { active: false, y: 0, carried: 0 };

  // The height of one row, so a drag moves the text under the finger rather
  // than by some arbitrary multiple. Measured from the real DOM: xterm's
  // rendered row height is the font size times its line-height, and hard-coding
  // either makes the gesture wrong at every zoom level but one.
  function rowHeight() {
    var row = mount.querySelector('.xterm-rows > div');
    var h = row ? row.getBoundingClientRect().height : 0;
    return h > 4 ? h : Math.max(10, term.options.fontSize * 1.2);
  }

  mount.addEventListener('touchstart', function (ev) {
    if (ev.touches.length !== 2) { touch.active = false; return; }
    touch.active = true;
    touch.carried = 0;
    touch.y = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
  }, { passive: true });

  mount.addEventListener('touchmove', function (ev) {
    if (!touch.active || ev.touches.length !== 2) return;
    // Not passive: the whole point is to stop the page scrolling underneath.
    ev.preventDefault();
    var y = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
    // Fractions are CARRIED rather than dropped. Rounding each event
    // independently loses a little every frame, and a slow drag then moves
    // nothing at all while the finger travels half the screen.
    var moved = (touch.y - y) / rowHeight() + touch.carried;
    var lines = moved > 0 ? Math.floor(moved) : Math.ceil(moved);
    touch.carried = moved - lines;
    touch.y = y;
    if (lines) term.scrollLines(lines);
  }, { passive: false });

  mount.addEventListener('touchend', function () { touch.active = false; }, { passive: true });

  /**
   * "Jump to latest", shown only while the view is scrolled away from the end.
   *
   * Scrolling up in a shell and then losing the prompt is the moment people
   * assume the terminal has hung. A button that is only there when it is needed
   * answers that without adding permanent furniture.
   */
  var jumpEl = document.getElementById('term-jump');

  function updateJump() {
    if (!jumpEl) return;
    var buf = term.buffer.active;
    var atEnd = buf.viewportY >= buf.baseY;
    jumpEl.hidden = atEnd;
  }

  term.onScroll(updateJump);
  term.onLineFeed(updateJump);
  if (jumpEl) {
    jumpEl.addEventListener('click', function (ev) {
      ev.preventDefault();
      term.scrollToBottom();
      updateJump();
      term.focus();
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
