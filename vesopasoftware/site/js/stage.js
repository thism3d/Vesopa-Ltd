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

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ------------------------------------------------------------------ *
 * The backdrop
 * ------------------------------------------------------------------ */

/**
 * One <video> per clip, but only ever three alive at once.
 *
 * The obvious build is one element per section, mounted up front. Eight
 * simultaneous H.264 decoders is fine on a desktop and comfortably enough to
 * stall a phone — Safari caps concurrent decoders and simply refuses to play
 * the ninth, which shows up as "some of the videos don't work" on exactly the
 * devices you cannot debug on.
 *
 * So elements are built on demand and evicted once they are two sections away.
 * The poster image underneath means an evicted or not-yet-decoded slot still
 * shows the right frame rather than a black rectangle.
 */
export function createBackdrop(root) {
  const live = new Map();          // slug -> { el, wrap }
  let order = [];                  // slugs in page order, for adjacency
  let current = null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const saveData = navigator.connection?.saveData;

  function build(slug, src, poster) {
    const wrap = document.createElement("div");
    wrap.className = "bd-clip";
    wrap.style.setProperty("--k", "0");
    if (poster) wrap.style.backgroundImage = `url("${poster}")`;

    if (!reduced && !saveData) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true;
      v.setAttribute("playsinline", "");     // iOS needs the attribute
      v.setAttribute("aria-hidden", "true");
      v.preload = "auto";
      v.src = src;
      // Only reveal once it can actually paint, or a slow connection shows a
      // black box over the poster it was meant to replace.
      const ready = () => v.classList.add("on");
      v.addEventListener("canplay", ready, { once: true });
      v.addEventListener("loadeddata", ready, { once: true });
      v.addEventListener("error", () => v.remove(), { once: true });
      wrap.appendChild(v);
      live.set(slug, { wrap, el: v });
    } else {
      live.set(slug, { wrap, el: null });
    }

    root.appendChild(wrap);
    return live.get(slug);
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
      // Keep this one and its immediate neighbours; drop the rest.
      const keep = new Set([slug, order[i - 1], order[i + 1]].filter(Boolean));

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
        if (active) rec.el.play().catch(() => {});
        // Neighbours stay loaded but paused: decoding a clip nobody can see
        // is the cheapest frame rate you will ever throw away.
        else rec.el.pause();
      }
    },

    /**
     * Pull every clip into the HTTP cache, in page order, once the page is up.
     *
     * The lazy build above means a clip starts downloading only as its section
     * arrives, so on anything but a fast line the visitor reaches a section
     * and watches a poster while the video is still on its way. Warming the
     * cache first means the <video> element, when it is finally built, is
     * reading from disk.
     *
     * Deliberately NOT eight <video> elements up front: browsers cap
     * concurrent decoders, and Safari simply refuses to play past the limit.
     * This fetches bytes, which costs no decoder at all, and the elements are
     * still created one section at a time.
     *
     * Sequential, and skipped entirely on a metered or slow connection —
     * roughly 7MB of video is not something to pull down a phone's data plan
     * before it has been asked for.
     */
    async warm() {
      if (reduced || saveData) return;
      const c = navigator.connection;
      if (c && /(^|-)2g$/.test(c.effectiveType || "")) return;

      const idle = window.requestIdleCallback || ((f) => setTimeout(f, 900));
      await new Promise((r) => idle(r, { timeout: 2500 }));

      for (const slug of order) {
        const clip = this.clips.get(slug);
        if (!clip) continue;
        try {
          // One at a time: a parallel burst would compete with the clip the
          // visitor is actually looking at.
          await fetch(clip.src, { priority: "low", cache: "force-cache" });
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
