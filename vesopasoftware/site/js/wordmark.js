/* The lockup: a V that becomes VESOPA.
 *
 * Traced from brandAssets/SVG/Vesopa_Logo-01.svg. The useful discovery is that
 * the V inside the wordmark is *exactly* the standalone mark in favicon.svg —
 * same three polygons, same 46.35 x 33.09, simply translated to (42.52,153.42).
 * So there is no morph to do and no second set of geometry to keep in sync: the
 * V draws itself at 1.85x in the middle of the lockup box, then eases back to
 * its own place in the word while the other five letters arrive behind it.
 *
 * Colour follows the brand's two lockups rather than being invented here:
 *   Logo-01 (on paper) — ink letterforms, lime on the V's inner stroke
 *   Logo-02 (on ink)   — paper letterforms, lime on the V's inner stroke
 * Both are just `currentColor` for the letters plus one lime accent, so the
 * component takes its colour from wherever it is placed and needs no variants.
 *
 * The whole thing is CSS transitions on a class. It is deliberately not tied to
 * the loader: the same lockup plays again further down the page.
 */

/* Lockup extents in the source artwork: x 42.52..297.64, y 153.42..186.54.
   The viewBox is taller than the word so the enlarged V has somewhere to be
   during the first beat — cheaper than overflow:visible, which would let it
   spill over whatever it sits next to. */
const VIEWBOX = "38 138 264 64";

/* The V's centre, and how far it has to travel to sit in the middle of the
   lockup. Both are measured from the artwork, not eyeballed. */
const V_CX = 65.695, V_CY = 169.965;
const LOCKUP_CX = 170.08;
const V_SHIFT = (LOCKUP_CX - V_CX).toFixed(3);   // 104.385

/* Left to right, which is the order they arrive in. The source file lists them
   backwards (a, p, o, s, V, e) because of how it was exported. */
const LETTERS = [
  // e
  `<path d="M96.53,153.62l-0.08,0.08l0,0l-8.12,8.12v0.14v4.36v7.8v4.28l8.34,8.34l0,0.01h30.19v-8.34H96.67v-4.29h21.85l8.34-8.34v-3.82v-8.26v-0.08H96.53z M118.53,166.31H96.67v-4.36h21.85V166.31z"/>`,
  // s
  `<polygon points="169.76,161.76 169.76,153.42 139.57,153.42 139.43,153.42 139.41,153.46 131.24,161.63 131.24,161.76 131.24,165.63 131.59,165.99 131.59,165.99 139.57,173.97 161.43,173.97 161.43,178.21 131.24,178.21 131.24,186.54 161.43,186.54 169.76,178.21 169.76,178.21 169.76,173.97 161.78,165.99 161.43,165.99 139.57,165.99 139.57,161.76"/>`,
  // o
  `<path d="M204.08,153.42h-21.85l-8.34,8.34v16.45l8.34,8.34h21.85l8.34-8.34v-16.45L204.08,153.42z M182.23,178.21v-16.45h21.85v16.45H182.23z"/>`,
  // p
  `<path d="M246.96,153.42h-21.98h-5.05h-3.29v33.12h8.34v-8.44h21.98h0.35l7.92-7.92l0.06,0.02v-8.44L246.96,153.42z M224.97,170.18v-8.42h21.98v8.42H224.97z"/>`,
  // a
  `<polygon points="267.45,153.42 259.12,161.76 259.12,178.21 267.45,186.54 280.97,186.54 289.3,178.21 267.45,178.21 267.45,161.76 289.3,161.76 289.3,178.21 289.3,186.54 297.64,186.54 297.64,178.21 297.64,161.76 297.64,153.42"/>`,
];

/* The V, in the wordmark's own coordinates. Two outer strokes and the inner
   one, which is the accent in every official lockup. */
const V_POLYS = [
  `<polygon class="wm-v-a" points="52.47,153.42 42.52,153.42 60.53,186.51 70.48,186.51"/>`,
  `<polygon class="wm-v-a" points="69.92,169.97 79.87,169.97 88.87,153.42 78.92,153.42"/>`,
  `<polygon class="wm-v-b" points="69.92,169.97 60.91,186.51 70.86,186.51 79.87,169.97"/>`,
];

/** The lockup's markup. `label` gives it an accessible name, or omit for decor. */
export function wordmarkSVG(label) {
  return `<svg class="wm" viewBox="${VIEWBOX}" ${label
    ? `role="img" aria-label="${label}"`
    : 'aria-hidden="true"'} style="--v-shift:${V_SHIFT}px">
    <g class="wm-word">${LETTERS.map((d, i) => `<g class="wm-l" style="--i:${i}">${d}</g>`).join("")}</g>
    <g class="wm-v">${V_POLYS.join("")}</g>
  </svg>`;
}

/**
 * Play the reveal on a container holding a wordmarkSVG.
 *
 * Two beats, driven by classes so the CSS owns the timing: `drawing` strokes
 * the V on its own at 1.85x in the middle of the box, then `settled` returns it
 * to its place in the word and brings the letters in behind it.
 *
 * Returns a promise that resolves when the word is whole, so a caller can wait
 * for it — the loader does, rather than cutting the animation off with a
 * dialog.
 */
export function playWordmark(root, { drawMs = 1150, holdMs = 260 } = {}) {
  const svg = root.querySelector(".wm");
  if (!svg) return Promise.resolve();

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    svg.classList.add("drawing", "settled", "instant");
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    // Two frames before starting: one for the element to be in the document,
    // one for the initial state to be the browser's actual computed style. Set
    // the class in the same frame it mounts and there is no "from" to
    // transition out of, so the whole thing simply appears finished.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      svg.classList.add("drawing");
      setTimeout(() => {
        svg.classList.add("settled");
        // The letters are staggered in CSS; the last one lands well after the
        // V has arrived, so the caller waits for the whole word.
        setTimeout(resolve, 1000);
      }, drawMs + holdMs);
    }));
  });
}

/** Play it once, when it first scrolls into view. */
export function wordmarkOnView(root) {
  if (!("IntersectionObserver" in window)) return playWordmark(root);
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    playWordmark(root);
  }, { threshold: 0.4 });
  io.observe(root);
}
