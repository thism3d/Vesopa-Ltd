/* The stage: what fills the screen behind the words, and the screenshots.
 *
 * Two mechanisms, both driven from one scroll listener because they have to
 * agree with each other — the backdrop and the screenshot on screen at any
 * moment belong to the same section, and running them off separate observers
 * lets them disagree for a frame at every boundary.
 *
 *   VideoBackdrop   one clip filling the viewport, at the very back of the
 *                   page, cross-fading as sections change.
 *   Showcase        a screenshot pinned in the middle of a tall section,
 *                   stepping through the app's screens as you scroll past.
 */

import { saveData, slowLink, videoBudget, onStrain } from "./device.js";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ------------------------------------------------------------------ *
 * The backdrop
 * ------------------------------------------------------------------ */

/**
 * One <video> per clip, and only as many alive at once as the device can hold.
 *
 * The obvious build is one element per section, mounted up front. Eight
 * simultaneous H.264 decoders is fine on a desktop and comfortably enough to
 * stall a phone — browsers cap concurrent decoders and older iOS simply
 * refuses to start the next one, which shows up as "some of the videos don't
 * work" on exactly the devices you cannot debug on.
 *
 * So elements are built on demand, evicted as soon as they are outside the
 * decoder budget in device.js, and on a phone that budget is one. The poster
 * underneath means an evicted slot, a refused autoplay and a clip still on its
 * way all show the right frame rather than a black rectangle.
 */
export function createBackdrop(root) {
  const live = new Map();          // slug -> rec, one per declared clip
  let order = [];                  // slugs in page order, for adjacency
  let clips = new Map();
  let current = null;
  let budget = videoBudget;

  /* Reduced motion is deliberately not consulted here.
   *
   * It used to be: `reduced` was part of this flag, so a browser reporting
   * the preference got no <video> element at all. What made that wrong is
   * what actually sets it. iPadOS reports `prefers-reduced-motion: reduce`
   * for Low Power Mode as well as for the accessibility switch, so a tablet
   * at 20% battery was handed the treatment meant for someone who had asked
   * for a still page — and got posters for the rest of the visit with nothing
   * able to bring the footage back. That is the bug this file was opened for.
   *
   * The rest of the page still honours the preference in full: no parallax,
   * no star field, no reveal animations, instant transitions. The backdrop is
   * the one thing that no longer does, by decision.
   *
   * Save-Data and a 2g link do still stop it, because those are about what the
   * visitor is paying to download, which is not a matter of design intent. */
  let posterOnly = saveData || slowLink;

  /* ---------- autoplay refusal ---------- */

  /* Muted inline video is supposed to start without asking. iOS in Low Power
   * Mode refuses anyway, and there is no API that admits to it: `play()`
   * simply rejects. The refusal is only ever lifted by a real gesture, so one
   * is waited for — several kinds, because a visitor who scrolls with a
   * finger and never taps must lift it too. */
  const GESTURES = ["pointerdown", "touchstart", "touchend", "keydown", "click"];
  let waiting = false;

  function armUnblock() {
    if (waiting) return;
    waiting = true;
    const lift = () => {
      if (!waiting) return;
      waiting = false;
      for (const type of GESTURES) removeEventListener(type, lift, true);
      resume();
    };
    for (const type of GESTURES) {
      addEventListener(type, lift, { capture: true, passive: true });
    }
  }

  /** Try the current clip again — after a gesture, a tab switch, or a retry. */
  function resume() {
    const rec = current && live.get(current);
    if (rec) start(rec);
  }

  /* Coming back to a backgrounded tab, iOS has usually torn the decoder down
   * and left the element paused. Nothing else notices, so the page comes back
   * to a frozen frame that looks exactly like a clip that never loaded. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resume();
  });

  /* ---------- strain ---------- */

  /* If the frame loop reports the machine is struggling, the backdrop is the
   * most expensive thing on the page nobody is looking at directly — but it is
   * also the thing the page is largely made of, so level 2 now sheds the
   * clips that are merely resident rather than the one on screen. Dropping to
   * a poster wholesale was too blunt: one bad second during the opening, when
   * the field is still building, used to cost the visitor every clip. */
  onStrain((level) => {
    if (level < 2) return;
    budget = 1;
    for (const rec of live.values()) {
      if (rec.slug !== current) detach(rec);
    }
  });

  /* ---------- elements ---------- */

  /* The wrapper — and with it the poster — is built once and kept for the life
   * of the page. Only the <video> comes and goes.
   *
   * This used to remove the whole wrapper on eviction and build it again on
   * return, which on any device whose budget is one meant every section change
   * destroyed and recreated the element. iOS is slow to release a decoder, so
   * scrolling back and forth would ask for one that had not been handed back
   * yet, and the request that failed was never retried. It also meant the
   * poster blinked out at each boundary. */
  function wrapFor(slug) {
    let rec = live.get(slug);
    if (rec) return rec;
    const clip = clips.get(slug);
    if (!clip) return null;

    const wrap = document.createElement("div");
    wrap.className = "bd-clip";
    wrap.style.setProperty("--k", "0");
    // The poster is the floor: a detached slot, a refused autoplay, a decode
    // still on its way and a machine in posterOnly all land here rather than
    // on a black rectangle.
    if (clip.poster) wrap.style.backgroundImage = `url("${clip.poster}")`;
    root.appendChild(wrap);

    rec = { slug, clip, wrap, el: null, tries: 0, retry: null, watchdog: null };
    live.set(slug, rec);
    return rec;
  }

  function attach(rec) {
    if (posterOnly || rec.el) return;

    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true;
    // Safari has historically wanted each of these as an attribute rather than
    // a property, and an old iPad is exactly where that still bites.
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.setAttribute("muted", "");
    v.setAttribute("aria-hidden", "true");
    v.setAttribute("disableremoteplayback", "");
    // Always `auto`. `metadata` on a small budget was a false economy: it
    // saved bytes the visitor was going to spend anyway and moved the whole
    // download to the moment the section arrived, so the clip was still on the
    // wire while its section was on screen. Prefetching is what keeps this
    // honest — see `warm`.
    v.preload = "auto";
    v.src = rec.clip.src;

    const ready = () => {
      rec.tries = 0;
      clearTimeout(rec.watchdog);
      rec.watchdog = null;
      v.classList.add("on");
    };
    v.addEventListener("loadeddata", ready);
    v.addEventListener("canplay", ready);
    v.addEventListener("error", () => fail(rec));

    /* A load that neither succeeds nor errors is the failure mode with no
     * event: a connection that dropped mid-file leaves the element sitting at
     * readyState 0 forever, and the visitor sees a poster with nothing behind
     * it. Nothing else will notice, so this does. */
    rec.watchdog = setTimeout(() => {
      if (v.readyState < 2) fail(rec);
    }, 9000);

    rec.wrap.appendChild(v);
    rec.el = v;
  }

  function detach(rec) {
    clearTimeout(rec.watchdog);
    rec.watchdog = null;
    if (!rec.el) return;
    rec.el.pause();
    // Emptying the source before dropping the element is what actually
    // releases the decoder on iOS; simply removing the node leaves it held
    // until GC, which is how a budget of two becomes a budget of none.
    rec.el.removeAttribute("src");
    rec.el.load();
    rec.el.remove();
    rec.el = null;
  }

  /* ---------- retry ---------- */

  /* A clip that fails is retried, never abandoned.
   *
   * The old handler removed the element on the first `error` and set a flag
   * meaning "never again". That is the right answer for a 404 and the wrong
   * one for everything else that fires the same event — a connection dropped
   * as a tunnel arrives, a decoder iOS would not hand out because two were
   * already open, a request cancelled because the page was backgrounded
   * mid-load. All momentary, all of them cost the visitor the clip for the
   * rest of the session.
   *
   * So it backs off instead, which keeps a genuinely missing file down to one
   * request every few seconds rather than a spin, and keeps trying as long as
   * the page still wants the clip. */
  const RETRY_CAP = 8000;

  function fail(rec) {
    rec.tries += 1;
    detach(rec);
    if (rec.retry) return;
    const wait = Math.min(RETRY_CAP, 500 * 2 ** Math.min(rec.tries, 5));
    rec.retry = setTimeout(() => {
      rec.retry = null;
      // Only if it is still one of the clips the page is holding open.
      if (!wanted().has(rec.slug)) return;
      attach(rec);
      if (rec.slug === current) start(rec);
    }, wait);
  }

  /** Start a clip, and notice if the browser refuses. */
  function start(rec) {
    if (!rec.el) return;
    const r = rec.el.play();
    if (r && typeof r.catch === "function") r.catch(() => armUnblock());
  }

  /** The slugs that should be holding a decoder right now. */
  function wanted() {
    const i = order.indexOf(current);
    const keep = new Set(current ? [current] : []);
    if (budget > 1) keep.add(order[i + 1]);
    if (budget > 2) keep.add(order[i - 1]);
    keep.delete(undefined);
    return keep;
  }

  return {
    /** Declare the clips, in page order. */
    register(list) {
      order = list.map((c) => c.slug);
      clips = new Map(list.map((c) => [c.slug, c]));
      this.clips = clips;
      // Posters up front, all of them. They are one background-image each and
      // they are what the visitor looks at until the footage lands, so there
      // is nothing to gain by making a section wait for its own.
      for (const slug of order) wrapFor(slug);
    },

    /**
     * Let a real user gesture lift an autoplay refusal.
     *
     * Called from inside the loader's Enter click, which is the one moment on
     * the page guaranteed to be a genuine gesture. iOS in Low Power Mode will
     * start a muted clip from there and from nowhere else.
     */
    unlock() {
      waiting = false;
      resume();
    },

    /** Make one clip the visible backdrop. Safe to call every frame. */
    show(slug) {
      if (slug === current) return;
      current = slug;

      const keep = wanted();
      for (const rec of live.values()) {
        if (keep.has(rec.slug)) continue;
        rec.wrap.style.setProperty("--k", "0");
        detach(rec);
      }

      for (const key of keep) {
        const rec = wrapFor(key);
        if (!rec) continue;
        const active = key === slug;
        rec.wrap.style.setProperty("--k", active ? "1" : "0");
        attach(rec);
        if (!rec.el) continue;
        // Neighbours stay loaded but paused: decoding a clip nobody can see is
        // the cheapest frame rate you will ever throw away.
        if (active) start(rec); else rec.el.pause();
      }
    },

    /**
     * Pull every clip into the HTTP cache, in page order, as soon as the page
     * is up.
     *
     * Without this a clip only starts downloading as its section arrives, so
     * on anything but a fast line the visitor reaches a section and watches a
     * poster while the video is still on its way. Fetching bytes costs no
     * decoder, which is the whole point.
     *
     * It no longer skips modest devices. It used to bail on `lowEnd`, which
     * covers every iPad reporting four cores — the machines with the least
     * headroom to spare were the ones asked to download each clip at the
     * moment it was needed. Bandwidth is not the scarce resource there;
     * decoders are, and this spends none.
     *
     * A clip that fails is retried rather than skipped, because a prefetch
     * that quietly gives up leaves exactly the stall it exists to prevent.
     */
    async warm() {
      if (posterOnly) return;

      const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
      await new Promise((r) => idle(r, { timeout: 1200 }));

      const queue = order.filter((s) => clips.has(s));
      let cursor = 0;

      const pull = async (slug) => {
        const clip = clips.get(slug);
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            // The body is drained rather than abandoned: an unread response
            // body holds its buffer open until GC gets to it.
            const res = await fetch(clip.src, { priority: "low", cache: "force-cache" });
            if (!res.ok) throw new Error(String(res.status));
            await res.arrayBuffer();
            return;
          } catch {
            // Offline, or the visitor left, or the connection dropped. Wait,
            // then ask again — a half-fetched clip is the stall this prevents.
            await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
          }
        }
      };

      // Two at a time. One is slower than the page needs; the whole list at
      // once competes with the clip actually on screen for the same
      // connection, which is the stall in a different costume.
      const worker = async () => {
        while (cursor < queue.length) await pull(queue[cursor++]);
      };
      await Promise.all([worker(), worker()]);
    },

    /** Nothing on screen wants a backdrop — fade the lot out. */
    clear() {
      current = null;
      for (const rec of live.values()) {
        rec.wrap.style.setProperty("--k", "0");
        rec.el?.pause();
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The screenshot showcase
 * ------------------------------------------------------------------ */

/**
 * A screenshot pinned mid-viewport while the section scrolls past it,
 * stepping through an app's screens.
 *
 * The pin is `position: sticky` in CSS, not scroll-driven transforms in JS —
 * sticky is handled on the compositor and stays glued during momentum scroll
 * on iOS, where a transform written from a scroll handler visibly lags behind
 * the finger.
 *
 * This does one job: turn scroll depth into an integer index, and only when it
 * changes. `step` is the fraction of the section given to each shot, and the
 * index is taken from the middle of each band rather than its edge, so a shot
 * is fully resolved while it is centred instead of swapping exactly as it
 * arrives.
 */
export function createShowcase(section, { onStep } = {}) {
  const shots = [...section.querySelectorAll(".shot")];
  const dots = [...section.querySelectorAll(".shot-dot")];
  // The copy steps with the picture. Each .step matches the .shot at its own
  // index; a section may legitimately have none, in which case the copy is
  // fixed and only the screenshot changes.
  const steps = [...section.querySelectorAll(".step")];
  if (shots.length < 2) return null;

  let index = -1;

  function paint(i) {
    if (i === index) return;
    const from = index;
    index = i;
    shots.forEach((s, n) => {
      s.classList.toggle("on", n === i);
      // Which way it leaves matters: a shot the visitor has scrolled past
      // should exit upward, one they have not reached should wait below.
      s.classList.toggle("past", n < i);
    });
    steps.forEach((s, n) => {
      s.classList.toggle("on", n === i);
      s.classList.toggle("past", n < i);
      // Stacked in one grid cell, so the hidden ones are still in the
      // accessibility tree and still focusable unless taken out of it.
      s.setAttribute("aria-hidden", n === i ? "false" : "true");
    });
    dots.forEach((d, n) => {
      d.classList.toggle("on", n === i);
      d.setAttribute("aria-current", n === i ? "true" : "false");
    });
    section.style.setProperty("--shot", String(i));
    if (from !== -1 && onStep) onStep(i, shots[i]);
  }

  // Tapping a dot is the mobile answer to "scroll through the screens": the
  // sticky stage works on a phone, but a thumb should not have to discover
  // that scrolling is what changes the picture.
  dots.forEach((dot, n) => {
    dot.addEventListener("click", () => {
      const r = section.getBoundingClientRect();
      const top = scrollY + r.top;
      const travel = section.offsetHeight - innerHeight;
      // Aim at the middle of that shot's band.
      scrollTo({ top: top + travel * ((n + 0.5) / shots.length), behavior: "smooth" });
    });
  });

  paint(0);

  return {
    section,
    get index() { return index; },
    get count() { return shots.length; },

    /** Called from the shared scroll loop. */
    update() {
      const r = section.getBoundingClientRect();
      const travel = section.offsetHeight - innerHeight;
      if (travel <= 0) return paint(0);
      const p = clamp01(-r.top / travel);
      paint(Math.min(shots.length - 1, Math.floor(p * shots.length)));
    },

    /** 0..1 through the pinned run — used to fade the stage in and out. */
    progress() {
      const r = section.getBoundingClientRect();
      const travel = section.offsetHeight - innerHeight;
      return travel <= 0 ? 0 : clamp01(-r.top / travel);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reveal
 * ------------------------------------------------------------------ */

/** Fade and lift each [data-reveal] once, as it arrives. */
export function createReveals(root = document) {
  const items = [...root.querySelectorAll("[data-reveal]")];
  if (!items.length) return;

  if (!("IntersectionObserver" in window)
      || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    items.forEach((el) => el.classList.add("shown"));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      // Stagger children of the same block so a section assembles rather than
      // appearing all at once.
      const delay = Number(e.target.dataset.reveal) || 0;
      setTimeout(() => e.target.classList.add("shown"), delay);
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });

  items.forEach((el) => io.observe(el));
}
