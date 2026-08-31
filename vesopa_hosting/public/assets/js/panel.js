/**
 * The panel's browser half.
 *
 * Loaded on every signed-in page, after app.js. Everything here is progressive:
 * remove this file and the panel still works, because each piece enhances
 * markup that was already correct on its own. A checklist is a list, a fold is
 * a <details>, a "check now" button is a form submit, and the live channel only
 * ever REPLACES text the server already rendered.
 *
 * That is not tidiness for its own sake. This panel is used on hotel wifi and
 * on phones with one bar, and a control panel whose status display depends on a
 * socket is a control panel that shows nothing at all on a bad connection.
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /* =======================================================================
     Bottom sheet — the phone's "More"
     ======================================================================= */
  function closeSheet(sheet) {
    if (!sheet) return;
    sheet.classList.remove('is-open');
    // Wait for the slide-down before hiding, or it vanishes instead of leaving.
    setTimeout(() => { if (!sheet.classList.contains('is-open')) sheet.hidden = true; }, 200);
    document.body.style.overflow = '';
  }

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-sheet-open]');
    if (opener) {
      const sheet = document.getElementById('sheet-' + opener.dataset.sheetOpen);
      if (sheet) {
        sheet.hidden = false;
        // A frame between unhiding and adding the class, or the transition has
        // nothing to animate from.
        requestAnimationFrame(() => sheet.classList.add('is-open'));
        document.body.style.overflow = 'hidden';
      }
      return;
    }
    const closer = e.target.closest('[data-sheet-close]');
    if (closer) closeSheet(closer.closest('.sheet'));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.sheet.is-open').forEach(closeSheet);
  });

  /* =======================================================================
     Hints — one sentence, on demand
     -----------------------------------------------------------------------
     Not a tour and not a help centre. The panel's problem was never too little
     explanation; it was explanation everywhere at once, so none of it was read.
     ======================================================================= */
  function closeQmarks(except) {
    $$('.qmark-pop').forEach((pop) => { if (pop !== except) pop.remove(); });
    $$('.qmark > button[aria-expanded="true"]').forEach((b) => {
      if (!except || b.parentNode !== except.parentNode) b.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.qmark > button');
    if (!btn) { closeQmarks(); return; }
    const wrap = btn.parentNode;
    const open = wrap.querySelector('.qmark-pop');
    if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
    closeQmarks();
    const pop = document.createElement('span');
    pop.className = 'qmark-pop';
    pop.setAttribute('role', 'tooltip');
    pop.textContent = btn.dataset.hint || '';
    wrap.appendChild(pop);
    btn.setAttribute('aria-expanded', 'true');
  });

  /* =======================================================================
     Usage rings
     -----------------------------------------------------------------------
     Drawn from a data attribute rather than an inline style so the server does
     not have to know the circumference of a circle. One hue, no gradient: the
     ring answers "how full", and a second colour would imply a second series.
     ======================================================================= */
  $$('[data-ring]').forEach((el) => {
    const pct = Math.max(0, Math.min(100, Number(el.dataset.ring) || 0));
    const fill = $('.ring-fill', el);
    if (!fill) return;
    const r = Number(fill.getAttribute('r'));
    const c = 2 * Math.PI * r;
    fill.style.strokeDasharray = String(c);
    fill.style.strokeDashoffset = String(c);
    if (pct >= 90) el.classList.add('is-full');
    else if (pct >= 75) el.classList.add('is-high');
    // Next frame, so the transition runs and the ring fills rather than
    // appearing full. Skipped entirely for anybody who asked for less motion.
    const settle = () => { fill.style.strokeDashoffset = String(c - (c * pct) / 100); };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) settle();
    else requestAnimationFrame(() => requestAnimationFrame(settle));
  });

  /* =======================================================================
     Busy buttons
     -----------------------------------------------------------------------
     A form that posts to the node can take four or five seconds. Without this
     the page looks dead and people press the button again, which is how a
     domain gets two certificate requests and a rate limit.
     ======================================================================= */
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.noBusy !== undefined) return;
    const btn = form.querySelector('button[type="submit"]:not([data-no-busy]), button:not([type]):not([data-no-busy])');
    if (!btn || btn.classList.contains('is-working')) return;
    // Fixed width first, or the button collapses when its label is hidden.
    btn.style.minWidth = btn.offsetWidth + 'px';
    btn.classList.add('is-working');
    btn.disabled = true;
    // A form that fails validation never navigates, so the button must come
    // back or the page is stuck. Belt and braces: this also covers a
    // back-forward-cache restore.
    setTimeout(() => { btn.classList.remove('is-working'); btn.disabled = false; }, 20000);
  });
  window.addEventListener('pageshow', () => {
    $$('.is-working').forEach((b) => { b.classList.remove('is-working'); b.disabled = false; });
  });

  /* =======================================================================
     Instant DNS check
     -----------------------------------------------------------------------
     The old "Check now" was a form post: five seconds of a blank page, then a
     full reload, and if it had not propagated yet you did it all again. It is
     a fetch now, it answers in place, and it says what the DNS actually
     returned rather than just failing.
     ======================================================================= */
  $$('[data-check]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const out = document.getElementById(btn.dataset.checkOut || '');
      btn.style.minWidth = btn.offsetWidth + 'px';
      btn.classList.add('is-working');
      btn.disabled = true;
      if (out) {
        out.hidden = false;
        out.className = 'tip';
        out.innerHTML = '<span class="tip-ic"></span><span>Asking the public DNS…</span>';
      }
      try {
        const res = await fetch(btn.dataset.check, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': btn.dataset.csrf || '' },
          body: '{}',
        });
        const data = await res.json();
        if (out) {
          out.className = 'tip ' + (data.ok ? 'tip-ok' : 'tip-warn');
          const bits = document.createElement('span');
          bits.textContent = data.message || (data.ok ? 'Verified.' : 'Not visible yet.');
          out.innerHTML = '<span class="tip-ic"></span>';
          out.appendChild(bits);
        }
        // Verified is a page-shape change — the instructions fold away — so the
        // honest thing is to re-render rather than patch six places by hand.
        if (data.ok) setTimeout(() => window.location.reload(), 900);
      } catch (err) {
        if (out) {
          out.className = 'tip tip-warn';
          out.innerHTML = '<span class="tip-ic"></span><span>Could not run the check. Try again in a moment.</span>';
        }
      } finally {
        btn.classList.remove('is-working');
        btn.disabled = false;
      }
    });
  });

  /* =======================================================================
     The live channel
     -----------------------------------------------------------------------
     One socket for the page. It watches the objects this page is showing —
     named in `data-live` attributes the server rendered — and swaps their
     status state and status line when the server says they changed.

     It never inserts markup from the wire as HTML. Everything it writes goes
     in through textContent or a class name off a fixed list, because the
     alternative is a stored-XSS hole with a domain name as the payload.
     ======================================================================= */
  const TONES = { green: 'state-green', amber: 'state-amber', red: 'state-red', blue: 'state-blue', grey: 'state-grey' };

  function watchKeys() {
    const keys = new Set();
    $$('[data-live]').forEach((el) => keys.add(el.dataset.live));
    return [...keys];
  }

  function paint(key, value) {
    $$('[data-live="' + key.replace(/"/g, '') + '"]').forEach((el) => {
      const badge = $('[data-live-chip]', el);
      if (badge && value.label) {
        // Rebuilt from parts rather than assigned as HTML. `value` came off a
        // socket, and a domain name is attacker-controlled text — innerHTML
        // here would be a stored-XSS hole with a hostname as the payload.
        badge.textContent = '';
        badge.appendChild(document.createElement('i'));
        badge.appendChild(document.createTextNode(value.label));
        // The tone is looked up in a fixed table, never concatenated, so the
        // wire cannot name a class of its own choosing either.
        badge.className = 'state ' + (TONES[value.tone] || TONES.grey);
      }
      const line = $('[data-live-line]', el);
      if (line && value.line) line.textContent = value.line;

      /*
       * A site finishing provisioning changes what the page OFFERS, not just
       * what it says — the tools light up, the setup steps tick over. Patching
       * that in the browser would mean keeping a second copy of the page's
       * logic here, which would drift. One reload, once, on the transition.
       */
      if (el.dataset.liveReloadOn && String(value.key || value.status) === el.dataset.liveReloadOn) {
        if (!el.dataset.liveReloaded) {
          el.dataset.liveReloaded = '1';
          setTimeout(() => window.location.reload(), 600);
        }
      }
    });
  }

  (function connect() {
    const keys = watchKeys();
    if (!keys.length || !('WebSocket' in window)) return;

    const dot = $('[data-live-dot]');
    const text = $('[data-live-text]');
    let ws = null;
    let attempt = 0;
    let closed = false;

    function setState(on, label) {
      if (!dot) return;
      dot.hidden = false;
      dot.classList.toggle('is-off', !on);
      if (text) text.textContent = label;
    }

    function open() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try { ws = new WebSocket(proto + '//' + location.host + '/panel/live'); }
      catch { return; }

      ws.onopen = () => {
        attempt = 0;
        setState(true, 'Live');
        ws.send(JSON.stringify({ type: 'watch', keys: watchKeys() }));
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'state' && msg.state) {
          Object.keys(msg.state).forEach((k) => paint(k, msg.state[k]));
        } else if (msg.type === 'bye') {
          // Signed out in another tab, or the password changed. Reconnecting
          // would loop forever; the page is stale and should say so.
          closed = true;
          setState(false, 'Signed out');
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setState(false, 'Reconnecting');
        // Backing off to 30s: a server restart must not be met with a thousand
        // tabs reconnecting every second.
        attempt += 1;
        setTimeout(open, Math.min(30000, 1000 * Math.pow(1.7, attempt)));
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already gone */ } };
    }

    open();

    // A backgrounded tab's socket is often killed by the browser. Coming back
    // to a panel that stopped updating an hour ago is worse than no panel.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ws && ws.readyState > 1) { attempt = 0; open(); }
    });
  }());

  /* =======================================================================
     Reveal a password without a round trip
     ======================================================================= */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-reveal]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.reveal);
    if (!target) return;
    const shown = target.dataset.shown === '1';
    target.dataset.shown = shown ? '0' : '1';
    target.textContent = shown ? '••••••••••••' : (target.dataset.value || '');
    btn.textContent = shown ? 'Show' : 'Hide';
  });
}());
