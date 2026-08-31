/* The hero: light, and the things that disturb it.
 *
 * Everything here is decoration over a hero that already works without it. The
 * video is background, never content: it carries no information, has no
 * controls, is muted and aria-hidden, and the copy is legible with it removed
 * entirely. If autoplay is refused — iOS low-power mode, a data saver, a
 * blocked codec — the poster still stands and nothing below notices.
 *
 * Four effects, in order of how much they cost:
 *   spotlight   one CSS radial that follows the pointer          (compositor only)
 *   ripples     a ring element per click, removed on animation end
 *   bulb        a brightness curve run once on first paint
 *   fullscreen  a button, because the API demands a user gesture
 */
(() => {
  // The hero is section s0; .hero is the styling hook. One element, one id.
  const hero = document.querySelector(".hero");
  if (!hero) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const video = document.getElementById("hero-video");
  const spot = document.getElementById("spotlight");
  const fsBtn = document.getElementById("fs-btn");

  /* ---------- the video ----------
     Autoplay is attempted, never assumed. A rejected play() is an ordinary
     outcome on mobile, so it is caught and the poster simply stays. */
  if (video && !reduced) {
    // The CSS only fades the footage in on [data-playing], so a stalled or
    // refused load never shows a black rectangle where the poster should be.
    const start = () =>
      video.play()
        .then(() => video.setAttribute("data-playing", ""))
        .catch(() => document.body.classList.add("no-video"));
    if (video.readyState >= 2) start();
    else video.addEventListener("loadeddata", start, { once: true });
    video.addEventListener("error", () => document.body.classList.add("no-video"), { once: true });

    // A background video playing to nobody is wasted battery. Pause it when
    // the hero leaves the screen or the tab goes away, resume when it returns.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        ([e]) => {
          if (e.isIntersecting) video.play().catch(() => {});
          else video.pause();
        },
        { threshold: 0.01 },
      );
      io.observe(hero);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) video.pause();
      else if (hero.getBoundingClientRect().bottom > 0) video.play().catch(() => {});
    });
  } else if (video) {
    document.body.classList.add("no-video");
  }

  /* ---------- the spotlight ----------
     A soft radial that brightens the footage under the cursor, so the scene
     behind the type reads as something being looked at rather than something
     being played. Position is written to two CSS custom properties and the
     element itself never changes layout — this is a compositor-only effect.

     Eased rather than pinned to the raw pointer: a light with mass reads as a
     lamp being swung, and a light with none reads as a cursor. */
  let px = 0.5, py = 0.42, tx = 0.5, ty = 0.42, moved = false;

  if (spot && !coarse && !reduced) {
    addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width;
      ty = (e.clientY - r.top) / r.height;
      moved = true;
      document.body.classList.add("lit");
    }, { passive: true });

    // Give it back to the idle drift when the pointer leaves.
    addEventListener("pointerleave", () => { moved = false; }, { passive: true });

    let raf = 0;
    const tick = (now) => {
      // With no pointer, the light patrols slowly on its own — the watchtower
      // sweep. It never stops, so the hero is alive before anyone touches it.
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

    // Stop the loop entirely when the hero is off screen.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting && !raf) raf = requestAnimationFrame(tick);
        else if (!e.isIntersecting && raf) { cancelAnimationFrame(raf); raf = 0; }
      }, { threshold: 0.01 }).observe(hero);
    }
  }

  /* ---------- click: light leaves the point of contact ----------
     A ring on the DOM for the visible pulse, and an impulse handed to the
     particle field so the points move with it rather than beside it. */
  const MAX_RINGS = 6;
  let rings = 0;

  const strike = (clientX, clientY) => {
    const r = hero.getBoundingClientRect();
    const nx = (clientX - r.left) / r.width;
    const ny = (clientY - r.top) / r.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

    // Push the light to the strike so the spotlight follows the hand.
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

    // site.js publishes this once the field is up. It is optional on purpose:
    // the hero must not depend on WebGL having succeeded.
    window.__vesopaField?.pulse?.(nx * 2 - 1, (1 - ny) * 2 - 1);
  };

  hero.addEventListener("pointerdown", (e) => {
    // Let real controls do their job — a click on the CTA is not a light show.
    if (e.target.closest("a, button, input, select, textarea, label")) return;
    strike(e.clientX, e.clientY);
  }, { passive: true });

  /* ---------- the bulb ----------
     One warm-up on first paint: a couple of stutters, then steady. Run once,
     never on a loop — a light that keeps flickering reads as a fault, and it
     is exactly the kind of motion that makes text hard to read. */
  if (!reduced) {
    requestAnimationFrame(() => hero.classList.add("bulb"));
    setTimeout(() => hero.classList.add("bulb-done"), 1500);
  } else {
    hero.classList.add("bulb-done");
  }

  /* ---------- fullscreen ----------
     Offered, not imposed. The API requires a user gesture, and a site that
     grabs the whole screen unasked is a site people close. */
  if (fsBtn) {
    const root = document.documentElement;
    const supported = !!(root.requestFullscreen || root.webkitRequestFullscreen);
    if (!supported) fsBtn.hidden = true;

    const paint = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      fsBtn.textContent = on ? "Exit full screen" : "Full screen";
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

  /* ---------- the scroll cue ----------
     Hidden the moment anyone scrolls, so it never nags. */
  const cue = document.getElementById("cue");
  if (cue) {
    addEventListener("scroll", () => {
      cue.classList.toggle("gone", scrollY > 40);
    }, { passive: true });
  }
})();
