/* The motion scenes (css/sections.css): play only while on screen.
 *
 * Each [data-scene] — and the five-app grid, whose icons draw themselves in —
 * gets .play while at least a fifth of it is visible and loses it when it
 * scrolls away, so nothing animates off screen or in a background tab. With
 * no IntersectionObserver every scene simply plays. Reduced motion is handled
 * in the stylesheet: the resting state of every scene is its finished frame.
 */
(function () {
  "use strict";
  var els = [].slice.call(document.querySelectorAll("[data-scene], .app-grid"));
  if (!els.length) return;
  if (!("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("play"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      // The icon draw-in is a one-off arrival, not a loop: keep it once seen.
      if (e.target.classList.contains("app-grid")) {
        if (e.isIntersecting) { e.target.classList.add("play"); io.unobserve(e.target); }
        return;
      }
      e.target.classList.toggle("play", e.isIntersecting);
    });
  }, { threshold: 0.2 });
  els.forEach(function (el) { io.observe(el); });
})();
