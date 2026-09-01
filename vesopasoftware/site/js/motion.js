/* The motion graphics.
 *
 * Four Lottie files, rebranded onto the Vesopa palette by
 * tools/rebrand-lottie.mjs — see that file for how the recolour works and why
 * the line-art one is inverted.
 *
 * They are heavy: 190KB to 450KB of JSON each, and lottie-web renders SVG,
 * which means hundreds of DOM nodes per animation animating every frame. Four
 * of those running at once is a genuinely slow page. So:
 *
 *   - nothing is fetched until the container is within a viewport of the
 *     screen,
 *   - nothing plays while it is off screen,
 *   - and on a coarse pointer under 820px they do not mount at all. A phone
 *     spends its frame budget on the particle field, which is the thing the
 *     page is actually made of.
 */

const BASE = "assets/motion/";

let lottiePromise = null;

/** Load the player once, on first real need. */
function player() {
  if (window.lottie) return Promise.resolve(window.lottie);
  if (lottiePromise) return lottiePromise;
  lottiePromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "js/vendor/lottie.min.js";
    s.onload = () => resolve(window.lottie);
    s.onerror = () => reject(new Error("lottie failed"));
    document.head.appendChild(s);
  });
  return lottiePromise;
}

export function mountMotion(root = document) {
  const slots = [...root.querySelectorAll("[data-motion]")];
  if (!slots.length) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = matchMedia("(pointer: coarse)").matches && innerWidth < 820;
  if (reduced || small || !("IntersectionObserver" in window)) {
    // The container keeps its own poster/fallback styling; just mark it so the
    // CSS can stop reserving space for something that will never arrive.
    slots.forEach((s) => s.classList.add("motion-off"));
    return;
  }

  const anims = new WeakMap();

  // Two observers with different margins: one decides when to *build*, the
  // other when to *play*. Building early hides the fetch; playing only when
  // visible is what keeps four of these off the frame budget at once.
  const buildIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const slot = e.target;
      buildIO.unobserve(slot);
      player().then((lottie) => {
        if (!lottie) return;
        const anim = lottie.loadAnimation({
          container: slot,
          renderer: "svg",
          loop: true,
          autoplay: false,
          path: `${BASE}${slot.dataset.motion}.json`,
          rendererSettings: {
            // Scale to fill the slot and crop, rather than letterboxing a
            // 1600x1600 square into a wide container.
            preserveAspectRatio: slot.dataset.fit || "xMidYMid meet",
            progressiveLoad: true,
          },
        });
        anim.addEventListener("DOMLoaded", () => slot.classList.add("motion-on"));
        anim.addEventListener("data_failed", () => slot.classList.add("motion-off"));
        anims.set(slot, anim);
        playIO.observe(slot);
      }).catch(() => slot.classList.add("motion-off"));
    }
  }, { rootMargin: "100% 0px" });

  const playIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const anim = anims.get(e.target);
      if (!anim) continue;
      if (e.isIntersecting) anim.play();
      else anim.pause();
    }
  }, { threshold: 0.05 });

  slots.forEach((s) => buildIO.observe(s));

  // A backgrounded tab should not be animating four SVG scenes.
  document.addEventListener("visibilitychange", () => {
    for (const s of slots) {
      const anim = anims.get(s);
      if (!anim) continue;
      if (document.hidden) anim.pause();
      else if (s.getBoundingClientRect().top < innerHeight && s.getBoundingClientRect().bottom > 0) anim.play();
    }
  });
}
