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

import {
  reduced, saveData, slowLink, lowEnd, videoBudget, onStrain, strain,
} from "./device.js";

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
  const live = new Map();          // slug -> { el, wrap, failed }
  let order = [];                  // slugs in page order, for adjacency
  let current = null;
  let posterOnly = reduced || saveData || slowLink;

  // Autoplay can be refused outright — iOS in Low Power Mode does exactly
  // that, and there is no API that admits to it. The refusal used to be
  // swallowed, so the page sat on a poster forever with nothing to retry it.
  // Now the first refusal arms a one-shot listener on the next real gesture,
  // which is the only thing that will lift it.
  let blocked = false;
  function armUnblock() {
    if (blocked) return;
    blocked = true;
    const retry = () => {
      blocked = false;
      const rec = current && live.get(current);
      rec?.el?.play().catch(() => armUnblock());
    };
    addEventListener("pointerdown", retry, { once: true, passive: true });
    addEventListener("touchstart", retry, { once: true, passive: true });
    addEventListener("keydown", retry, { once: true });
  }

  // If the frame loop reports the machine is struggling, the backdrop is the
  // most expensive thing on the page that nobody is looking directly at.
  onStrain((level) => {
    if (level < 2) return;
    posterOnly = true;
    for (const rec of live.values()) {
      rec.el?.pause();
      rec.el?.remove();
      rec.el = null;
    }
  });

  function build(slug, src, poster) {
    const wrap = document.createElement("div");
    wrap.className = "bd-clip";
    wrap.style.setProperty("--k", "0");
    // The poster is the floor: an evicted slot, a refused autoplay, a decode
    // that never finishes and a machine in posterOnly all land here rather
    // than on a black rectangle.
    if (poster) wrap.style.backgroundImage = `url("${poster}")`;
    root.appendChild(wrap);

    const rec = { wrap, el: null, failed: false };
    live.set(slug, rec);
    if (posterOnly) return rec;

    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true;
    v.setAttribute("playsinline", "");           // iOS needs the attribute too
    v.setAttribute("aria-hidden", "true");
    v.setAttribute("disableremoteplayback", "");
    // `metadata` where decoders are scarce: `auto` on a phone starts pulling
    // the whole clip for a section that may never be reached.
    v.preload = videoBudget > 1 ? "auto" : "metadata";
    v.src = src;

    const ready = () => v.classList.add("on");
    v.addEventListener("canplay", ready, { once: true });
    v.addEventListener("loadeddata", ready, { once: true });
    // A clip that errors is gone for good — retrying a 404 or an unsupported
    // encode on every section change is just a slower way to show the poster.
    v.addEventListener("error", () => { rec.failed = true; v.remove(); rec.el = null; },
                       { once: true });

    wrap.appendChild(v);
    rec.el = v;
    return rec;
  }

  /** Start a clip, and notice if the browser refuses. */
  function start(rec) {
    if (!rec.el) return;
    const r = rec.el.play();
    if (r && typeof r.catch === "function") r.catch(() => armUnblock());
  }

  return {
    /** Declare the clips, in page order. */
    register(list) {
      order = list.map((c) => c.slug);
      this.clips = new Map(list.map((c) => [c.slug, c]));
    },

    /** Make one clip the visible backdrop. Safe to call every frame. */
    show(slug) {
      if (slug === current) return;
      current = slug;

      const i = order.indexOf(slug);
      // How much stays resident is a decoder budget, not a fixed window. On a
      // phone that is the current clip and nothing else; three simultaneous
      // decoders is what stopped the later clips ever playing.
      const keep = new Set([slug]);
      if (videoBudget > 1) keep.add(order[i + 1]);
      if (videoBudget > 2) keep.add(order[i - 1]);
      keep.delete(undefined);

      for (const [key, rec] of live) {
        if (keep.has(key)) continue;
        rec.el?.pause();
        rec.wrap.remove();
        live.delete(key);
      }

      for (const key of keep) {
        const clip = this.clips.get(key);
        if (!clip) continue;
        const rec = live.get(key) || build(key, clip.src, clip.poster);
        const active = key === slug;
        rec.wrap.style.setProperty("--k", active ? "1" : "0");
        if (!rec.el) continue;
        // Neighbours stay loaded but paused: decoding a clip nobody can see
        // is the cheapest frame rate you will ever throw away.
        if (active) start(rec); else rec.el.pause();
      }
    },

    /**
     * Pull the clips into the HTTP cache, in page order, once the page is up.
     *
     * Without this a clip only starts downloading as its section arrives, so
     * on anything but a fast line the visitor reaches a section and watches a
     * poster while the video is still on its way.
     *
     * Fetching bytes costs no decoder, which is the whole point — but it is
     * still bandwidth and still memory pressure, so it is skipped entirely
     * wherever either is scarce. On a metered line, a slow line, or a machine
     * already showing strain, the posters are the answer.
     */
    async warm() {
      if (posterOnly || lowEnd || saveData || slowLink) return;

      const idle = window.requestIdleCallback || ((f) => setTimeout(f, 900));
      await new Promise((r) => idle(r, { timeout: 2500 }));

      for (const slug of order) {
        if (strain() > 0) return;      // the page needs the bandwidth elsewhere
        const clip = this.clips.get(slug);
        if (!clip) continue;
        try {
          // One at a time, and the body is drained rather than abandoned: an
          // unread response body holds its buffer open until GC gets to it.
          const res = await fetch(clip.src, { priority: "low", cache: "force-cache" });
          await res.arrayBuffer().catch(() => {});
        } catch { /* offline, or the visitor left — neither is worth reporting */ }
      }
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
