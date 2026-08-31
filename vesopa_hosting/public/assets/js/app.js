/* ===========================================================================
   Vesopa Hosting — front-end behaviour
   ---------------------------------------------------------------------------
   No framework and no build step, matching vesopa_web. Everything here is
   progressive: the site works with this file blocked, it just stops being
   animated. Every effect is transform/opacity only so nothing forces layout,
   and everything checks prefers-reduced-motion.
   =========================================================================== */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Money -------------------------------------------------------------
     The active currency is stamped on <body> by the server, so a total worked
     out in the browser is rendered exactly the way the server would render it.
     A hard-coded '£' lived here and printed a pound sign in front of a dollar
     amount for every visitor outside the UK. */
  const CUR = {
    symbol: document.body.dataset.curSymbol || '£',
    locale: document.body.dataset.curLocale || 'en-GB',
  };
  function money(minor) {
    return CUR.symbol + (Number(minor || 0) / 100).toLocaleString(CUR.locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /* ---- Currency switcher -------------------------------------------------
     The <details> opens and closes on its own; this only closes it when the
     click lands elsewhere, which is the one behaviour the element does not
     give you and the one people expect from a dropdown. */
  document.addEventListener('click', (e) => {
    $$('.cur-pick[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $$('.cur-pick[open]').forEach((d) => d.removeAttribute('open'));
  });

  /* ---- Header ------------------------------------------------------------ */
  const nav = $('[data-nav]');
  if (nav) {
    /*
     * One scroll listener, two jobs: the shadow under an ordinary bar, and the
     * point at which a transparent over-the-hero bar turns solid. Both are the
     * same `.is-stuck` class, so they can never disagree about where the
     * threshold is.
     *
     * On a page with an overlaid header the threshold is most of the hero,
     * not 8px — turning white the instant somebody nudges the wheel would
     * flicker the bar on and off over a hero that is still filling the screen.
     */
    const over = nav.classList.contains('nav-over');
    let stuck = null;
    const threshold = () => {
      if (!over) return 8;
      const hero = $('.hero');
      return hero ? Math.max(80, hero.offsetHeight - nav.offsetHeight * 1.6) : 8;
    };
    let mark = threshold();
    const onScroll = () => {
      const should = window.scrollY > mark;
      if (should !== stuck) {
        stuck = should;
        nav.classList.toggle('is-stuck', stuck);
      }
    };
    // passive: this runs on every scroll frame and must never block it.
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => { mark = threshold(); onScroll(); }, { passive: true });
    onScroll();

    /* ---- The full-screen sheet -------------------------------------------- */
    const toggle = $('[data-nav-toggle]');
    const sheet = $('[data-nav-sheet]');

    if (toggle && sheet) {
      let lastFocus = null;

      const setOpen = (open) => {
        document.body.classList.toggle('nav-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        // `hidden` is the accessibility state — CSS keeps it painted so it can
        // animate out. Removing it a frame early lets the transition start.
        if (open) sheet.removeAttribute('hidden');
        else setTimeout(() => { if (!document.body.classList.contains('nav-open')) sheet.hidden = true; }, 280);

        /*
         * The scroll position is pinned rather than just `overflow: hidden`.
         * On iOS, hiding overflow alone still lets the page behind scroll
         * under the sheet, so closing the menu drops you somewhere else on the
         * page than where you opened it.
         */
        if (open) {
          lastFocus = document.activeElement;
          const y = window.scrollY;
          document.body.dataset.scrollLock = String(y);
          document.body.style.position = 'fixed';
          document.body.style.top = `-${y}px`;
          document.body.style.width = '100%';
          // First link, so a keyboard lands inside the sheet rather than
          // continuing through the page behind it.
          const first = $('.nav-sheet-link', sheet);
          if (first) setTimeout(() => first.focus({ preventScroll: true }), 60);
        } else {
          const y = Number(document.body.dataset.scrollLock || 0);
          document.body.style.position = '';
          document.body.style.top = '';
          document.body.style.width = '';
          window.scrollTo(0, y);
          if (lastFocus) lastFocus.focus({ preventScroll: true });
        }
      };

      toggle.addEventListener('click', () =>
        setOpen(!document.body.classList.contains('nav-open')));

      // A tap on a link closes it, so the sheet is never left open over the
      // page it just navigated to when the target is an anchor on this page.
      $$('a', sheet).forEach((a) => a.addEventListener('click', () => setOpen(false)));

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setOpen(false);
      });

      /*
       * Keep the tab ring inside the sheet while it is open. Without this,
       * tabbing past the last button walks invisibly through the whole page
       * underneath — the classic modal-without-a-trap bug, and the reason a
       * keyboard user cannot tell where they are.
       */
      sheet.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const focusable = $$('a[href], button:not([disabled])', sheet)
          .filter((el) => el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });

      // Growing past the breakpoint with the sheet open would leave the page
      // scroll-locked behind a bar that no longer has a burger to close it.
      window.addEventListener('resize', () => {
        if (window.innerWidth > 1140 && document.body.classList.contains('nav-open')) setOpen(false);
      }, { passive: true });
    }
  }

  /* ---- Scroll reveal ---------------------------------------------------- */
  const revealables = $$('[data-reveal]');
  if (revealables.length) {
    if (reduced || !('IntersectionObserver' in window)) {
      revealables.forEach((el) => el.classList.add('is-in'));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            // Stagger by position within the parent, so a grid ripples in
            // rather than all landing at once.
            const delay = Number(entry.target.dataset.reveal) || 0;
            entry.target.style.transitionDelay = `${delay}ms`;
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
      );
      revealables.forEach((el) => io.observe(el));
    }
  }

  /* ---- Count-up --------------------------------------------------------- */
  $$('[data-count]').forEach((el) => {
    const target = parseFloat(el.dataset.count);
    const suffix = el.dataset.countSuffix || '';
    const decimals = Number(el.dataset.countDecimals || 0);
    if (Number.isNaN(target)) return;

    if (reduced || !('IntersectionObserver' in window)) {
      el.textContent = target.toFixed(decimals) + suffix;
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const dur = 1500;
        const tick = (now) => {
          const t = Math.min(1, (now - start) / dur);
          // easeOutExpo — fast then settling, which reads as "counting up".
          const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
          el.textContent = (target * eased).toFixed(decimals) + suffix;
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
  });

  /* ---- Accordions ------------------------------------------------------- */
  $$('.acc').forEach((acc) => {
    const q = $('.acc-q', acc);
    const a = $('.acc-a', acc);
    if (!q || !a) return;

    const setOpen = (open) => {
      acc.classList.toggle('is-open', open);
      q.setAttribute('aria-expanded', String(open));
      // Animate to the measured height, then release to auto so the panel
      // reflows correctly if the window is resized while it is open.
      a.style.height = open ? `${a.scrollHeight}px` : '0px';
      if (open) {
        a.addEventListener(
          'transitionend',
          () => {
            if (acc.classList.contains('is-open')) a.style.height = 'auto';
          },
          { once: true },
        );
      }
    };

    q.addEventListener('click', () => {
      const open = !acc.classList.contains('is-open');
      if (open) {
        // Collapse siblings — one answer at a time reads better than a wall.
        const group = acc.closest('[data-acc-group]');
        if (group) {
          $$('.acc.is-open', group).forEach((other) => {
            if (other === acc) return;
            other.classList.remove('is-open');
            const oa = $('.acc-a', other);
            const oq = $('.acc-q', other);
            if (oa) {
              oa.style.height = `${oa.scrollHeight}px`;
              requestAnimationFrame(() => { oa.style.height = '0px'; });
            }
            if (oq) oq.setAttribute('aria-expanded', 'false');
          });
        }
        a.style.height = '0px';
        requestAnimationFrame(() => setOpen(true));
      } else {
        a.style.height = `${a.scrollHeight}px`;
        requestAnimationFrame(() => setOpen(false));
      }
    });
  });

  /* ---- Pricing term toggle ---------------------------------------------- */
  const toggle = $('[data-term-toggle]');
  if (toggle) {
    const pill = $('.term-pill', toggle);
    const buttons = $$('.term-btn', toggle);

    const movePill = (btn) => {
      if (!pill) return;
      // Below 620px the four terms wrap to a 2×2 grid and the CSS hides the
      // pill, using a plain background on the active button instead. A hidden
      // element has a null offsetParent; positioning it there would compute
      // against a single-row layout that no longer exists and, if it were ever
      // shown again, place it under the wrong button.
      if (pill.offsetParent === null) return;
      // The toggle is position:relative, so a button's offsetParent IS the
      // toggle and offsetLeft is already relative to it. Subtracting the
      // toggle's own offsetLeft — which is measured against the *page* — threw
      // the pill hundreds of pixels off to the left. The 5 is the toggle's
      // padding, which the pill's `left: 5px` already accounts for.
      pill.style.width = `${btn.offsetWidth}px`;
      pill.style.transform = `translateX(${btn.offsetLeft - 5}px)`;
    };

    const select = (months) => {
      buttons.forEach((b) => {
        const on = b.dataset.term === String(months);
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
        if (on) movePill(b);
      });
      // Every price on the page carries all four terms, so switching is
      // instant and needs no request.
      $$('[data-price-for]').forEach((el) => {
        el.hidden = el.dataset.priceFor !== String(months);
      });
      $$('[data-buy-link]').forEach((el) => {
        const url = new URL(el.href, window.location.origin);
        url.searchParams.set('term', months);
        el.href = url.pathname + url.search;
      });
    };

    buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.term)));

    const initial = buttons.find((b) => b.classList.contains('is-active')) || buttons[0];
    if (initial) {
      select(initial.dataset.term);
      // The pill is positioned from measured widths, which are 0 until layout
      // has run and the webfont has settled.
      requestAnimationFrame(() => movePill(initial));
      window.addEventListener('load', () => movePill($('.term-btn.is-active', toggle) || initial));
    }
    window.addEventListener('resize', () => {
      const active = $('.term-btn.is-active', toggle);
      if (active) movePill(active);
    });
  }


  /* ---- Password strength ------------------------------------------------ */
  // Scored against the same three rules the server enforces, so the meter and
  // the error message can never disagree.
  $$('[data-pw-meter]').forEach((input) => {
    const meter = input.parentElement.querySelector('.pw-meter');
    if (!meter) return;
    input.addEventListener('input', () => {
      const v = input.value;
      let score = 0;
      if (v.length >= 10) score++;
      if (/[0-9]/.test(v) && /[a-z]/i.test(v)) score++;
      if (v.length >= 14 && /[^a-z0-9]/i.test(v)) score++;
      meter.className = 'pw-meter' + (v ? ' is-' + score : '');
    });
  });

  /* ---- Toasts ----------------------------------------------------------- */
  const ICONS = {
    ok: '<path d="M20 6L9 17l-5-5"/>',
    error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/>',
  };

  function toast(message, kind) {
    let wrap = $('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-live', 'polite');
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = `toast${kind === 'error' ? ' toast-error' : ''}`;
    el.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ` +
      `stroke-linecap="round" stroke-linejoin="round">${ICONS[kind === 'error' ? 'error' : 'ok']}</svg>` +
      `<span></span>`;
    // textContent, not innerHTML — this is called with server strings.
    $('span', el).textContent = message;
    wrap.appendChild(el);

    setTimeout(() => {
      el.classList.add('is-out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, 4200);
  }
  window.vhToast = toast;

  /* ---- Copy to clipboard ------------------------------------------------ */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Safari refuses the async API outside a user gesture chain in some
      // versions; the textarea fallback still works there.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.classList.add('is-copied');
    const original = btn.dataset.copyLabel || btn.textContent;
    btn.dataset.copyLabel = original;
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.textContent = original;
    }, 1600);
  });

  /* ---- Double-submit guard ---------------------------------------------- */
  // A slow provision or a slow SMTP send is exactly when an impatient customer
  // clicks twice, and two clicks is two orders.
  /*
   * ONE BUSY TREATMENT, SHARED WITH panel.js.
   *
   * This used to replace the button's innerHTML with `<span class="spinner">`
   * plus the busy label, while panel.js independently added `.is-working` to
   * the same button. Both fired, and the result was a button nobody could read:
   * `.is-working` sets `color: transparent !important`, which hid the label AND
   * blanked this spinner's `border-top-color: currentColor`, leaving an
   * invisible 17px box shoving a second, centred `::after` spinner off centre.
   * That is the "the button is broken by design" report, and it affected every
   * data-guard form in the product.
   *
   * So both now do the same thing: fix the width, add the class, let CSS draw
   * one spinner. panel.js bails out if the class is already present, so the two
   * listeners cannot double up.
   *
   * The label is NOT replaced — `data-busy` is read by CSS via a content
   * attribute below, so the DOM is left alone and there is nothing to restore.
   */
  $$('form[data-guard]').forEach((form) => {
    form.addEventListener('submit', () => {
      const btn = $('[type=submit]', form);
      if (!btn || btn.disabled || btn.classList.contains('is-working')) return;
      // Fixed width first, or the button collapses once its label is hidden.
      btn.style.minWidth = btn.offsetWidth + 'px';
      btn.classList.add('is-working');
      btn.disabled = true;
      // A form that fails validation never navigates, so the button has to come
      // back or the page is stuck. Also covers a bfcache restore.
      setTimeout(() => {
        btn.classList.remove('is-working');
        btn.disabled = false;
      }, 25_000);
    });
  });

  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    $$('.is-working').forEach((btn) => {
      btn.classList.remove('is-working');
      btn.disabled = false;
    });
  });

  /* ---- Confirm before destructive actions ------------------------------- */
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const message = form.dataset.confirm;
    if (message && !window.confirm(message)) e.preventDefault();
  });

  /* ---- Email family tabs (business / marketing) -------------------------- */
  $$('[data-email-tabs]').forEach((tabs) => {
    const buttons = $$('.efam-btn', tabs);
    // The panels are siblings of the tab strip's *section*, not of the strip
    // itself, so scope the lookup to the section rather than the parent.
    const scope = tabs.closest('section') || document;

    const select = (family) => {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.efam === family)));
      $$('[data-efam-panel]', scope).forEach((p) => {
        p.hidden = p.dataset.efamPanel !== family;
      });
      // Cards inside a hidden panel never intersected, so their reveal never
      // fired and they would appear blank when the tab is switched to.
      $$('[data-efam-panel]:not([hidden]) [data-reveal]', scope).forEach((el) => el.classList.add('is-in'));
    };

    buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.efam)));
  });

  /* ---- Mailbox / contact-block stepper ----------------------------------- */
  $$('[data-units]').forEach((wrap) => {
    const input = $('.units-input', wrap);
    const dec = $('[data-units-dec]', wrap);
    const inc = $('[data-units-inc]', wrap);
    if (!input) return;

    const min = Number(input.min || 1);
    const max = Number(input.max || 500);

    const sync = () => {
      let v = Math.round(Number(input.value) || min);
      if (!Number.isFinite(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      input.value = v;
      if (dec) dec.disabled = v <= min;
      if (inc) inc.disabled = v >= max;

      // Keep the buy link and the running total honest as the count changes.
      const unit = Number(wrap.dataset.unitPence || 0);
      const total = $('[data-units-total]', wrap.closest('.eplan') || wrap);
      if (total && unit) {
        total.textContent = money(unit * v);
      }
      const link = $('[data-units-link]', wrap.closest('.eplan') || wrap);
      if (link) {
        const url = new URL(link.href, window.location.origin);
        url.searchParams.set('units', v);
        link.href = url.pathname + url.search;
      }
    };

    if (dec) dec.addEventListener('click', () => { input.value = Number(input.value) - 1; sync(); });
    if (inc) inc.addEventListener('click', () => { input.value = Number(input.value) + 1; sync(); });
    input.addEventListener('input', sync);
    input.addEventListener('blur', sync);
    sync();
  });

  /* ---- Hero ---------------------------------------------------------------
     Two touches, both deliberately small. A hero that lurches when the mouse
     moves is a gimmick; one that drifts a few pixels reads as depth. */
  const hero = $('[data-hero]');
  if (hero) {
    const auras = $$('[data-aura]', hero);
    const net = $('.hero-net', hero);
    const spot = $('[data-hero-spot]', hero);
    const fine = window.matchMedia('(pointer: fine)').matches;

    /*
     * POINTER. Three things move together — the two auroras, the network, and
     * the spotlight — at different depths, which is what turns a flat backdrop
     * into something with layers behind the text.
     *
     * All of it is skipped on a coarse pointer: there is no hover on a phone,
     * and a touch would jerk everything to wherever the finger happened to
     * land. Touch gets its own acknowledgement further down instead.
     */
    if (fine && !reduced) {
      let queued = false;
      let px = 0;
      let py = 0;

      hero.addEventListener('mousemove', (e) => {
        px = e.clientX;
        py = e.clientY;
        if (queued) return;
        queued = true;
        // One rAF per frame at most. mousemove fires far faster than the screen
        // refreshes, and doing this work per event is how a background effect
        // ends up costing more than the page it decorates.
        requestAnimationFrame(() => {
          queued = false;
          const r = hero.getBoundingClientRect();
          const x = (px - r.left) / r.width - 0.5;
          const y = (py - r.top) / r.height - 0.5;

          auras.forEach((a) => {
            const dir = Number(a.dataset.aura) || 1;
            a.style.transform = `translate3d(${x * 46 * dir}px, ${y * 34 * dir}px, 0)`;
          });
          // The mesh moves least — it is furthest away.
          if (net) {
            net.style.setProperty('--nx', `${x * -18}px`);
            net.style.setProperty('--ny', `${y * -12}px`);
          }
          // The spotlight tracks exactly, because it is the cursor.
          if (spot) {
            spot.style.transform = `translate3d(${px - r.left}px, ${py - r.top}px, 0)`;
          }
        });
      });

      // Back to where the keyframes want them, rather than frozen mid-drift.
      hero.addEventListener('mouseleave', () => {
        auras.forEach((a) => { a.style.transform = ''; });
        if (net) { net.style.setProperty('--nx', '0px'); net.style.setProperty('--ny', '0px'); }
      });
    }

    /*
     * TOUCH. One ring from where the finger landed, then it removes itself.
     * Without this the hero is completely inert on the device most people will
     * see it on.
     */
    if (!fine && !reduced) {
      hero.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (!t) return;
        const r = hero.getBoundingClientRect();
        const ring = document.createElement('span');
        ring.className = 'hero-ripple';
        ring.style.left = `${t.clientX - r.left}px`;
        ring.style.top = `${t.clientY - r.top}px`;
        hero.appendChild(ring);
        ring.addEventListener('animationend', () => ring.remove(), { once: true });
      }, { passive: true });
    }

    /*
     * SCROLL. The mesh drifts up more slowly than the page, so the hero has
     * depth as it leaves. Capped: past the fold it stops moving, because the
     * hero is gone and the work would be for nothing.
     */
    const onHeroScroll = () => {
      const y = window.scrollY;
      document.body.classList.toggle('is-scrolled', y > 40);
      if (net && !reduced && y < window.innerHeight) {
        net.style.setProperty('--sy', `${y * 0.14}px`);
      }
    };
    window.addEventListener('scroll', onHeroScroll, { passive: true });
    onHeroScroll();
  }

  /* ---- The rotating example name ------------------------------------------
     Types a name, holds, deletes, moves to the next. It demonstrates what to
     put in the search box instead of describing it.

     It stops for good the moment the field is focused or the tab is hidden —
     a placeholder that changes while somebody is reading it is worse than one
     that says nothing, and an animation running in a background tab is just a
     battery being spent on nobody. */
  const typer = $('[data-type]');
  if (typer && !reduced) {
    const words = (typer.dataset.words || '').split(',').map((w) => w.trim()).filter(Boolean);
    if (words.length) {
      let w = 0;
      let i = words[0].length;
      let deleting = false;
      let stopped = false;
      let timer = null;

      const stop = () => { stopped = true; clearTimeout(timer); };
      const step = () => {
        if (stopped) return;
        const word = words[w];
        i += deleting ? -1 : 1;
        typer.textContent = word.slice(0, i);

        let wait = deleting ? 45 : 85;
        if (!deleting && i >= word.length) { deleting = true; wait = 2100; }
        else if (deleting && i <= 0) { deleting = false; w = (w + 1) % words.length; wait = 320; }
        timer = setTimeout(step, wait);
      };
      timer = setTimeout(step, 2100);

      const field = $('.dsearch-input');
      if (field) field.addEventListener('focus', stop, { once: true });
      document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    }
  }

  /* ---- "Three. Two. Online." ----------------------------------------------
     Runs ONCE, when it scrolls into view, then holds its finished state. A
     loop would turn a demonstration into wallpaper — the second time round
     nobody is reading it, and something moving in the corner of the eye while
     they read the price above it is a cost with no benefit.

     Everything it says is already in the markup. This only reveals it in
     order, so a browser that never runs this file shows the finished article. */
  const launch = $('[data-launch]');
  if (launch) {
    const beats = $$('[data-beat]', launch);
    const steps = $$('[data-step]', launch);
    const status = $('[data-launch-status]', launch);

    const light = (n) => {
      beats.filter((b) => Number(b.dataset.beat) <= n).forEach((b) => b.classList.add('is-lit'));
      beats.forEach((b) => b.classList.toggle('is-now', Number(b.dataset.beat) === n));
      steps.filter((s) => Number(s.dataset.step) <= n).forEach((s) => s.classList.add('is-on'));
    };

    const finish = () => {
      launch.classList.add('is-running', 'is-done', 'is-secure', 'is-live');
      light(2);
      beats.forEach((b) => b.classList.remove('is-now'));
      if (status) status.textContent = 'Live';
    };

    const run = () => {
      if (reduced) return finish();
      launch.classList.add('is-running');

      const script = [
        [0, () => { light(0); if (status) status.textContent = 'Registering the domain…'; }],
        [1100, () => { light(1); if (status) status.textContent = 'Building your account…'; }],
        [2200, () => { launch.classList.add('is-secure'); if (status) status.textContent = 'Issuing your SSL certificate…'; }],
        [3100, () => { light(2); launch.classList.add('is-done'); }],
        [3500, () => { launch.classList.add('is-live'); if (status) status.textContent = 'Live'; }],
        [4200, () => beats.forEach((b) => b.classList.remove('is-now'))],
      ];
      script.forEach(([at, fn]) => setTimeout(fn, at));
    };

    if (!('IntersectionObserver' in window)) {
      finish();
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          io.disconnect();
          run();
        });
      }, { threshold: 0.35 });
      io.observe(launch);
    }
  }

  /* ---- Flash messages from the server ----------------------------------- */
  const flash = $('[data-flash]');
  if (flash) {
    toast(flash.dataset.flash, flash.dataset.flashKind);
    flash.remove();
  }
})();
