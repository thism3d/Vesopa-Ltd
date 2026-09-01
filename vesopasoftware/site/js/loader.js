/* The way in.
 *
 * Two jobs, and they belong together:
 *
 *   1. Cover the first second. The particle field builds tens of thousands of
 *      points and three video decoders spin up; without a cover the visitor
 *      watches that happen. The mark drawing itself is the wait.
 *
 *   2. Ask the one question that has to be asked from a gesture. Browsers will
 *      not start audio, and will not go fullscreen, except inside a real click.
 *      So the last frame of the loader is the invitation, and the click that
 *      dismisses it is the click that enables both.
 *
 * The V is the actual logo geometry — the same three polygons as
 * assets/logo.svg and the same three the particle field morphs to at the foot
 * of the page. It is stroked on first, so the shape draws itself as a line,
 * then the fill arrives underneath it.
 */

import { wordmarkSVG, playWordmark } from "./wordmark.js";

/**
 * @param {object} o
 * @param {() => Promise<void>|void} o.onEnter  run inside the dismissing click
 * @param {boolean} o.canFullscreen
 */
export function createLoader({ onEnter, canFullscreen = true } = {}) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const el = document.createElement("div");
  el.id = "loader";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Vesopa Software");
  el.innerHTML = `
    <div class="ld-inner">
      <div class="ld-lockup">${wordmarkSVG("Vesopa")}</div>
      <div class="ld-bar"><i></i></div>
      <div class="ld-ask" hidden>
        <p class="ld-ask-t">${canFullscreen ? "Best with sound, full screen." : "Best with sound."}</p>
        <p class="ld-ask-s">There is a room tone under this page and it is worth hearing.
          ${canFullscreen ? "Both are one click, and either" : "It"} can be turned off at any point.</p>
        <div class="ld-ask-r">
          <button class="ld-go" type="button">Enter with sound${canFullscreen ? " &amp; full screen" : ""}</button>
          <button class="ld-skip" type="button">Enter quietly</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.documentElement.classList.add("loading");

  const bar = el.querySelector(".ld-bar i");
  const ask = el.querySelector(".ld-ask");
  const goBtn = el.querySelector(".ld-go");
  const skipBtn = el.querySelector(".ld-skip");

  let progress = 0;
  let settled = false;

  // The V draws itself, then becomes the word. Held as a promise so `ready()`
  // can wait for it: cutting the lockup off mid-stroke to put a dialog over it
  // is worse than waiting the extra beat, and the page behind is still
  // assembling anyway.
  const lockup = playWordmark(el.querySelector(".ld-lockup"));

  /** Progress is eased toward, never set — a bar that jumps reads as fake. */
  function paint() {
    bar.style.transform = `scaleX(${progress.toFixed(3)})`;
  }

  const api = {
    /** 0..1. Real readiness, from site.js. */
    to(p) {
      progress = Math.max(progress, Math.min(1, p));
      paint();
      if (progress >= 1) api.ready();
    },

    /** Everything is up: show the invitation, once the word is whole. */
    ready() {
      if (settled) return;
      settled = true;
      lockup.then(() => {
        el.classList.add("asking");
        ask.hidden = false;
        goBtn.focus({ preventScroll: true });
      });
    },

    /** Take the loader down. */
    async dismiss(withExtras) {
      el.classList.add("gone");
      document.documentElement.classList.remove("loading");
      // The click is still live here, which is the only reason audio and
      // fullscreen can be started at all.
      try { await onEnter?.(withExtras); } catch { /* never block the page */ }
      setTimeout(() => el.remove(), 900);
    },
  };

  goBtn.addEventListener("click", () => api.dismiss(true));
  skipBtn.addEventListener("click", () => api.dismiss(false));

  // A safety net. If some asset never resolves, the page must still open —
  // being held behind a loading screen by a 404 is the worst possible failure.
  setTimeout(() => api.ready(), 6000);

  paint();
  return api;
}
