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

/* Section icons. The particle field used to morph into each section's subject,
 * but as loose points it only resolved with the section dead centre, read as
 * a blur on iPad, and spent the rest of the scroll as dust across the copy.
 * Each section now carries its subject as a crisp line icon above its label,
 * which draws itself once as the section arrives. */
(function () {
  "use strict";
  var I = {
    epos: '<rect x="6" y="8" width="36" height="24" rx="3"/><path d="M14 17h10M14 23h6M30 17h4M30 23h4"/><path d="M20 32v6M28 32v6M14 40h20"/>',
    kitchen: '<path d="M12 8h24v32l-4-3-4 3-4-3-4 3-4-3-4 3z"/><path d="M17 16h14M17 22h10M17 28h12"/>',
    display: '<rect x="5" y="9" width="38" height="25" rx="3"/><path d="M11 16h14M11 21h11M11 26h13M31 16h6M31 21h6M31 26h6"/><path d="M18 40h12M24 34v6"/>',
    express: '<rect x="13" y="4" width="22" height="32" rx="3"/><path d="M17 10h6v5h-6zM25 10h6v5h-6zM17 18h6v5h-6zM25 18h6v5h-6zM18 29h12"/><path d="M24 36v6M17 44h14"/>',
    loyalty: '<rect x="5" y="11" width="38" height="26" rx="4"/><path d="M24 15.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.8-3.6 5.2-.8z"/><path d="M11 33h4M18 33h4M26 33h4M33 33h4"/>',
    apps: '<rect x="7" y="7" width="15" height="15" rx="2"/><rect x="26" y="7" width="15" height="15" rx="2"/><rect x="7" y="26" width="15" height="15" rx="2"/><rect x="26" y="26" width="15" height="15" rx="2"/>',
    online: '<rect x="7" y="7" width="13" height="13" rx="2"/><rect x="28" y="7" width="13" height="13" rx="2"/><rect x="7" y="28" width="13" height="13" rx="2"/><path d="M11 11h5v5h-5zM32 11h5v5h-5zM11 32h5v5h-5zM28 28h5M37 28h4v5M28 33v8M33 37h8M37 41"/>',
    story: '<path d="M17 14L7 24l10 10M31 14l10 10-10 10M27 9l-6 30"/>',
    cloud: '<path d="M14 35a8 8 0 0 1-1.5-15.9A11 11 0 0 1 34 17a9 9 0 0 1 1 18z"/><path d="M24 23v9M20 28l4 4 4-4"/>',
    auth: '<path d="M24 5l15 6v11c0 10-6.5 17-15 21C15.5 39 9 32 9 22V11z"/><circle cx="24" cy="21" r="4"/><path d="M24 25v7"/>',
    stack: '<path d="M24 6L5 15l19 9 19-9z"/><path d="M5 23l19 9 19-9"/><path d="M5 31l19 9 19-9"/>',
    pay: '<path d="M27 4L11 27h12l-3 17 17-24H25z"/>',
    builds: '<path d="M10 44V14M10 18l30-10"/><rect x="5" y="40" width="10" height="4" rx="1"/><rect x="28" y="30" width="16" height="9" rx="2"/><path d="M31 34.5h10"/>',
    how: '<rect x="10" y="7" width="28" height="36" rx="3"/><path d="M19 4h10v6H19z"/><path d="M15 19l2.5 2.5L22 17M15 29l2.5 2.5L22 27M15 38h4"/><path d="M26 19h7M26 29h7M24 38h9"/>',
    quote: '<circle cx="24" cy="24" r="19"/><path d="M29 15.5a6 6 0 0 0-10 4.5v12M16 25h10M16 32h16"/>',
    contact: '<path d="M8 10h32a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H22l-9 7v-7H8a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3z"/><path d="M14 20h20M14 26h13"/>'
  };
  var made = [];
  Object.keys(I).forEach(function (id) {
    var sec = document.getElementById(id);
    var num = sec && sec.querySelector(".num");
    if (!num) return;
    var el = document.createElement("span");
    el.className = "sec-ico";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<svg viewBox="0 0 48 48">' + I[id] + "</svg>";
    [].forEach.call(el.querySelectorAll("path,rect,circle"), function (p, i) {
      p.setAttribute("pathLength", "1");
      p.style.transitionDelay = (0.12 + i * 0.09) + "s";
    });
    num.parentNode.insertBefore(el, num);
    made.push(el);
  });
  if (!made.length) return;
  if (!("IntersectionObserver" in window)) { made.forEach(function (el) { el.classList.add("drawn"); }); return; }
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("drawn"); io.unobserve(e.target); }
    });
  }, { threshold: 0.6 });
  made.forEach(function (el) { io.observe(el); });
})();
