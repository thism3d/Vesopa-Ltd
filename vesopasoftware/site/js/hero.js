/* The hero: light, and the things that disturb it.
 *
 * Everything here is decoration over a hero that already works without it.
 * Three effects, in order of what they cost:
 *   spotlight   one CSS radial following the pointer   (compositor only)
 *   ripples     a ring element per click, removed on animation end
 *   fullscreen  a button, because the API demands a user gesture
 *
 * The backdrop video used to be driven from here. It is not any more — there
 * is one clip per section now and stage.js owns all of them, because deciding
 * which of eight clips should be playing is a scroll problem, not a hero one.
 */
(() => {
  const hero = document.querySelector(".hero");
  if (!hero) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const spot = document.getElementById("spotlight");
  const fsBtn = document.getElementById("fs-btn");

  /* ---------- the spotlight ----------
     Eased rather than pinned to the raw pointer: a light with mass reads as a
     lamp being swung, one with none reads as a cursor. */
  let px = 0.5, py = 0.42, tx = 0.5, ty = 0.42, moved = false;

  if (spot && !coarse && !reduced) {
    addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width;
      ty = (e.clientY - r.top) / r.height;
      moved = true;
      document.body.classList.add("lit");
    }, { passive: true });

    addEventListener("pointerleave", () => { moved = false; }, { passive: true });

    let raf = 0;
    const tick = (now) => {
      // With no pointer the light patrols on its own, so the hero is alive
      // before anyone touches it.
      if (!moved) {
        const t = now * 0.00013;
        tx = 0.5 + Math.sin(t) * 0.3;
        ty = 0.42 + Math.cos(t * 0.73) * 0.16;
      }
      px += (tx - px) * 0.055;
      py += (ty - py) * 0.055;
      spot.style.setProperty("--x", (px * 100).toFixed(2) + "%");
      spot.style.setProperty("--y", (py * 100).toFixed(2) + "%");
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !raf) raf = requestAnimationFrame(tick);
        else if (!e.isIntersecting && raf) { cancelAnimationFrame(raf); raf = 0; }
      }, { threshold: 0.01 }).observe(hero);
    }
  }

  /* ---------- click: light leaves the point of contact ---------- */
  const MAX_RINGS = 6;
  let rings = 0;

  const strike = (clientX, clientY) => {
    const r = hero.getBoundingClientRect();
    const nx = (clientX - r.left) / r.width;
    const ny = (clientY - r.top) / r.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    tx = nx; ty = ny;

    if (!reduced && rings < MAX_RINGS) {
      rings++;
      const ring = document.createElement("span");
      ring.className = "ring";
      ring.style.left = nx * 100 + "%";
      ring.style.top = ny * 100 + "%";
      ring.addEventListener("animationend", () => { ring.remove(); rings--; }, { once: true });
      hero.appendChild(ring);
    }

    // site.js publishes this once the field is up. Optional on purpose: the
    // hero must not depend on WebGL having succeeded.
    window.__vesopaField?.pulse?.(nx * 2 - 1, (1 - ny) * 2 - 1);
  };

  hero.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, input, select, textarea, label")) return;
    strike(e.clientX, e.clientY);
  }, { passive: true });

  /* ---------- fullscreen ----------
     Offered, not imposed. site.js also drives this button from the loader's
     "enter with sound and full screen", so the two must agree on state —
     hence paint() reading the document rather than tracking its own flag. */
  if (fsBtn) {
    const root = document.documentElement;
    const supported = !!(root.requestFullscreen || root.webkitRequestFullscreen);
    if (!supported) fsBtn.hidden = true;

    const paint = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      // Only the label span. Writing textContent on the button itself would
      // delete the icon element that sits beside it.
      const lbl = fsBtn.querySelector(".lbl");
      if (lbl) lbl.textContent = on ? "Exit" : "Full screen";
      fsBtn.setAttribute("aria-pressed", String(on));
      document.body.classList.toggle("is-fullscreen", on);
    };

    fsBtn.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
        } else {
          await (root.requestFullscreen?.({ navigationUI: "hide" }) ?? root.webkitRequestFullscreen?.());
        }
      } catch { /* a refusal is not an error worth showing anyone */ }
      paint();
    });

    document.addEventListener("fullscreenchange", paint);
    document.addEventListener("webkitfullscreenchange", paint);
    paint();
  }

  /* ---------- the scroll cue ---------- */
  const cue = document.getElementById("cue");
  if (cue) {
    addEventListener("scroll", () => {
      cue.classList.toggle("gone", scrollY > 40);
    }, { passive: true });
  }
})();
