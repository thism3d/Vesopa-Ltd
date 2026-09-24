/* Rebrand stock Lottie files onto the Vesopa palette.
 *
 * The four motion graphics arrived in their vendors' colours — a yellow POS
 * illustration, black-on-white line art, a muted-brown chef, a teal wallet.
 * Dropped straight onto the page they read as four clip-art files from four
 * different shops, which is exactly what they are.
 *
 * This walks every fill, stroke and gradient stop and remaps the colour while
 * preserving the artwork's internal light-to-dark ordering, so the drawing
 * still reads as a drawing:
 *
 *   - saturated colours are the artist's *accents*. They become lime, or the
 *     signal orange when the source hue was already warm. Their relative
 *     lightness is kept so a highlight stays a highlight.
 *   - unsaturated colours are *structure*. They ride a ramp from ink to paper
 *     at the same relative lightness they had.
 *
 * The ramp floor matters. Mapped onto a true 0..1 range, every dark line in
 * these files lands on #0B0E0A — the page's own background — and the artwork
 * loses its outlines entirely on the dark half of the site. `lo` lifts the
 * floor so the darkest ink in a drawing still separates from the ground.
 *
 * `invert` is for line art. `customer-paying` is 417 black strokes on 267
 * white fills: map that by luminance and the lines go to ink and vanish, while
 * the fills go to paper and become a white blob. Inverting first puts the
 * lines in the light and the fills in the dark, which is what a line drawing
 * on a night-time page actually needs.
 *
 *   node tools/rebrand-lottie.mjs
 *
 * Reads site/assets/motion_graphics/*.json, writes site/assets/motion/*.json.
 * Idempotent: it always reads the untouched source, never its own output.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "site", "assets", "motion_graphics");
const OUT = path.join(HERE, "..", "site", "assets", "motion");

const INK = [0x0b, 0x0e, 0x0a];
const PAPER = [0xf2, 0xef, 0xe6];
const LIME = [0xa5, 0xc7, 0x15];
const SIGNAL = [0xe4, 0x76, 0x1b];

/* slug -> { out, invert, lo, warm }
 *   lo    floor of the neutral ramp (0 = ink, 1 = paper)
 *   warm  accents go to signal orange rather than lime                    */
const JOBS = {
  "Pos": { out: "pos", lo: 0.20 },
  "customer-paying-with-card-at-checkout-line-art-2025-10-20-04-30-48-utc":
    { out: "pay", invert: true, lo: 0.10 },
  "professional-chef-2026-07-08-04-04-37-utc": { out: "kitchen", lo: 0.22 },
  "web-wallet-and-online-banking-2025-11-05-03-32-19-utc":
    { out: "wallet", lo: 0.20, warm: true },
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [0, 1, 2].map((i) => lerp(a[i], b[i], t));

/** Perceptual lightness, 0..1. sRGB weights — good enough to order a palette. */
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Saturation as chroma over max channel — how much of an accent this is. */
function sat([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

/** True when the hue sits in the reds/oranges/yellows. */
function isWarm([r, g, b]) {
  return r >= g && g >= b && r - b > 24;
}

function remap(rgb, job) {
  let L = lum(rgb);
  if (job.invert) L = 1 - L;
  const lo = job.lo ?? 0.16;
  L = lerp(lo, 1, clamp01(L));

  const S = sat(rgb);
  const ramp = L < 0.5
    ? mix(INK, [0x2a, 0x31, 0x2b], L / 0.5)
    : mix([0x2a, 0x31, 0x2b], PAPER, (L - 0.5) / 0.5);

  if (S < 0.22) return ramp;                       // structure — stays neutral

  // An accent. Pull it toward the brand hue by how saturated it was, but keep
  // its lightness so highlights stay above midtones.
  const hue = job.warm || isWarm(rgb) ? SIGNAL : LIME;
  const tinted = mix(ramp, hue, Math.min(1, (S - 0.22) / 0.5) * 0.85);
  // Accents on the dark end would otherwise go muddy; give them their colour.
  return L < 0.34 ? mix(tinted, hue, 0.35) : tinted;
}

/* Lottie stores colour as 0..1 floats, but plenty of exporters emit 0..255.
   Detect per array rather than per file — some files mix the two. */
const to255 = (k) => (k.some((v) => v > 1.001) ? k.slice(0, 3) : k.slice(0, 3).map((v) => v * 255));
const back = (rgb, wasFloat) => (wasFloat ? rgb.map((v) => v / 255) : rgb);

function convert(json, job) {
  let fills = 0, stops = 0;

  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;

    // Solid fill / stroke.
    if ((n.ty === "fl" || n.ty === "st") && n.c && Array.isArray(n.c.k) && typeof n.c.k[0] === "number") {
      const wasFloat = !n.c.k.some((v) => v > 1.001);
      const next = remap(to255(n.c.k), job);
      const a = n.c.k[3];
      n.c.k = back(next, wasFloat).concat(a === undefined ? [] : [a]);
      fills++;
    }

    // Gradient fill / stroke. g.k.k is flat: [pos,r,g,b, pos,r,g,b, ...] with
    // an optional alpha run of [pos,a, pos,a, ...] appended after the colours.
    // g.p is the number of colour stops, so the colour run is exactly p*4 long
    // — walking past it would rewrite the alpha ramp as if it were RGB.
    if ((n.ty === "gf" || n.ty === "gs") && n.g && n.g.k && Array.isArray(n.g.k.k)) {
      const arr = n.g.k.k;
      if (typeof arr[0] === "number") {
        const p = n.g.p || Math.floor(arr.length / 4);
        const wasFloat = !arr.slice(0, p * 4).some((v) => v > 1.001);
        for (let i = 0; i < p; i++) {
          const o = i * 4 + 1;
          if (o + 2 >= arr.length) break;
          const next = back(remap(to255([arr[o], arr[o + 1], arr[o + 2]]), job), wasFloat);
          arr[o] = next[0]; arr[o + 1] = next[1]; arr[o + 2] = next[2];
          stops++;
        }
      }
    }

    for (const k in n) walk(n[k]);
  };

  walk(json);
  return { fills, stops };
}

fs.mkdirSync(OUT, { recursive: true });
let done = 0;
for (const [slug, job] of Object.entries(JOBS)) {
  const from = path.join(SRC, `${slug}.json`);
  if (!fs.existsSync(from)) { console.warn(`  skip ${slug} — not found`); continue; }
  const json = JSON.parse(fs.readFileSync(from, "utf8"));
  const { fills, stops } = convert(json, job);
  const to = path.join(OUT, `${job.out}.json`);
  fs.writeFileSync(to, JSON.stringify(json));
  const kb = (fs.statSync(to).size / 1024).toFixed(0);
  console.log(`  ${job.out}.json  ${fills} fills, ${stops} gradient stops  ${kb}KB`);
  done++;
}
console.log(`\n  ${done} rebranded -> site/assets/motion/\n`);
