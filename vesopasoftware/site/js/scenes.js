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

/* The photo reel: each [data-drift] shot moves against the scroll at its own
 * rate, so the three read as layers rather than a flat row. Transform only,
 * one rAF per scroll, and nothing at all with reduced motion or on a phone,
 * where the reel is a swipeable row instead. */
(function () {
  "use strict";
  var els = [].slice.call(document.querySelectorAll("[data-drift]"));
  if (!els.length) return;
  var still = window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 760px)");
  var queued = false;
  function frame() {
    queued = false;
    var vh = window.innerHeight;
    els.forEach(function (el) {
      if (still.matches) { el.style.transform = ""; return; }
      var r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > vh + 200) return;
      var d = (r.top + r.height / 2 - vh / 2) * parseFloat(el.getAttribute("data-drift"));
      el.style.transform = "translate3d(0," + d.toFixed(1) + "px,0)";
    });
  }
  function ask() { if (!queued) { queued = true; requestAnimationFrame(frame); } }
  window.addEventListener("scroll", ask, { passive: true });
  window.addEventListener("resize", ask);
  ask();
})();
