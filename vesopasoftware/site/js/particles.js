/* Vesopa — particle shape sources.
   Every builder returns Float32Array(count*3) normalised into roughly a
   2.4-unit box so any two shapes can be linearly morphed without a rescale.

   Two sources of geometry:
     - procedural  (boxSurface / silhouette) — always available, used on boot
     - matte+depth (matteDepth)              — a 2.5D point cloud sampled from
       a white-on-black mask PNG plus a greyscale depth PNG. This replaced the
       GLB plan: three product images and six edits give the same silhouette
       and the same parallax as a mesh sample at 1.6px point size, without
       shipping a mesh loader.                                                */

export const SC = 256;                 // sampler raster; 256² is plenty at 65k points
const SPAN = 2.4;                      // world width the raster maps onto

/* ---------- procedural ---------- */

export function boxSurface(out, off, n, cx, cy, cz, sx, sy, sz) {
  const A = [sy*sz, sy*sz, sx*sz, sx*sz, sx*sy, sx*sy];
  const T = A.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    let r = Math.random() * T, f = 0; while (r > A[f]) { r -= A[f]; f++; }
    let x = (Math.random()-.5)*sx, y = (Math.random()-.5)*sy, z = (Math.random()-.5)*sz;
    if (f === 0) x = -sx/2; else if (f === 1) x = sx/2;
    else if (f === 2) y = -sy/2; else if (f === 3) y = sy/2;
    else if (f === 4) z = -sz/2; else z = sz/2;
    const k = (off+i)*3; out[k] = cx+x; out[k+1] = cy+y; out[k+2] = cz+z;
  }
}

/* Draw anything on a 2D canvas, get a point cloud from its alpha. */
export function silhouette(count, drawFn, depth) {
  const c = document.createElement("canvas"); c.width = c.height = SC;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; drawFn(g, SC);
  return sampleAlpha(count, g.getImageData(0, 0, SC, SC).data, null, depth || .12);
}

/* Shared inner loop for both silhouette() and matteDepth().
   `mask` is RGBA; a pixel is solid if alpha>128 AND red>128 — alpha covers the
   canvas path, red covers a decoded JPEG-origin matte which is fully opaque. */
function sampleAlpha(count, mask, depthData, depth) {
  const hits = [];
  for (let y = 0; y < SC; y++) for (let x = 0; x < SC; x++) {
    const i = (y*SC + x) * 4;
    if (mask[i+3] > 128 && mask[i] > 128) hits.push(x, y);
  }
  const n = hits.length / 2;
  const out = new Float32Array(count * 3);
  if (!n) return out;                                   // empty matte — caller keeps the fallback
  for (let i = 0; i < count; i++) {
    const j = ((Math.random() * n) | 0) * 2;
    const x = hits[j], y = hits[j+1], k = i*3;
    out[k]   = (x/SC - .5) * SPAN + (Math.random()-.5)*.012;
    out[k+1] = (.5 - y/SC) * SPAN + (Math.random()-.5)*.012;
    if (depthData) {
      // luminance 0..1, white = nearest. Centre it so the cloud straddles z=0.
      const d = depthData[(y*SC + x)*4] / 255;
      out[k+2] = (d - .5) * depth + (Math.random()-.5)*.01;
    } else {
      out[k+2] = (Math.random()-.5) * depth;
    }
  }
  return out;
}

/* ---------- matte + depth ---------- */

function drawToData(img) {
  const c = document.createElement("canvas"); c.width = c.height = SC;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#000"; g.fillRect(0, 0, SC, SC);       // matte background must be black
  g.drawImage(img, 0, 0, SC, SC);
  return g.getImageData(0, 0, SC, SC).data;
}

const loadImg = src => new Promise((res, rej) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => rej(new Error("no " + src));
  i.src = src;
});

/* Resolves to a point cloud, or null if either PNG is missing — the caller
   then keeps whatever procedural shape it already had. Never throws. */
export async function matteDepth(count, maskSrc, depthSrc, depth = .55) {
  try {
    const [m, d] = await Promise.all([loadImg(maskSrc), loadImg(depthSrc)]);
    const cloud = sampleAlpha(count, drawToData(m), drawToData(d), depth);
    // A matte that came back nearly all-white or all-black is a failed edit,
    // not geometry. Reject it rather than morph into a solid square.
    let solid = 0;
    const md = drawToData(m);
    for (let i = 0; i < md.length; i += 4) if (md[i] > 128) solid++;
    const frac = solid / (SC*SC);
    if (frac < .02 || frac > .92) return null;
    return cloud;
  } catch { return null; }
}

/* ---------- the seven scroll targets ---------- */

export function fieldShape(count) {                      // S0 dispersed / hero
  const o = new Float32Array(count*3);
  for (let i = 0; i < count; i++) {
    const k = i*3, r = .75 + Math.pow(Math.random(), .6)*1.15;
    const th = Math.random()*Math.PI*2, ph = Math.acos(2*Math.random()-1);
    o[k]   = Math.sin(ph)*Math.cos(th)*r*1.5;
    o[k+1] = Math.sin(ph)*Math.sin(th)*r*.85;
    o[k+2] = Math.cos(ph)*r*.6;
  }
  return o;
}

export function tillShape(count) {                       // S1 till terminal
  const o = new Float32Array(count*3);
  const a = Math.floor(count*.62), b = Math.floor(count*.13), c = count-a-b;
  boxSurface(o, 0, a, 0, .42, 0, 1.55, 1.0, .09);
  boxSurface(o, a, b, 0, -.24, .06, .17, .62, .17);
  boxSurface(o, a+b, c, 0, -.6, .06, .95, .09, .62);
  return o;
}

export function windowShape(count) {                     // S2 application window
  return silhouette(count, (g, s) => {
    g.fillRect(s*.10, s*.20, s*.80, s*.60);
    g.clearRect(s*.13, s*.29, s*.74, s*.48);
  }, .1);
}

export function codeShape(count) {                       // S3 lines of code
  return silhouette(count, (g, s) => {
    let y = s*.24;
    const rows = [.52,.68,.34,.74,.44,.6,.28,.66,.5,.38,.7,.46];
    for (const w of rows) {
      const ind = (Math.random() < .4 ? s*.06 : 0);
      g.fillRect(s*.16 + ind, y, s*w*.78, s*.026);
      y += s*.045;
    }
  }, .1);
}

export function rackShape(count) {                       // S4 server rack column
  const o = new Float32Array(count*3);
  const units = 11, per = Math.floor(count*.86/units);
  let off = 0;
  for (let u = 0; u < units; u++) {
    boxSurface(o, off, per, 0, 1.02 - u*.19, 0, 1.12, .13, .5);
    off += per;
  }
  const rail = Math.floor((count-off)/2);
  boxSurface(o, off, rail, -.62, .05, 0, .07, 2.3, .5);
  boxSurface(o, off+rail, count-off-rail, .62, .05, 0, .07, 2.3, .5);
  return o;
}

export function boltShape(count) {                       // S5 lightning bolt
  return silhouette(count, (g, s) => {
    g.beginPath();
    g.moveTo(s*.58,s*.10); g.lineTo(s*.30,s*.55); g.lineTo(s*.47,s*.55);
    g.lineTo(s*.40,s*.92); g.lineTo(s*.70,s*.44); g.lineTo(s*.52,s*.44);
    g.closePath(); g.fill();
  }, .16);
}

/* S6 wordmark — the real Vesopa V, traced from brandAssets logo.svg
   (viewBox 0 0 46.35 33.09). Three polygons: two lime strokes and the
   dark inner stroke. All three are mass; the mark reads as the V. */
const VW = 46.35, VH = 33.09;
const MARK_POLYS = [
  [[9.95,0],[0,0],[18.01,33.09],[27.96,33.09]],
  [[27.4,16.54],[37.35,16.54],[46.35,0],[36.4,0]],
  [[27.4,16.54],[18.39,33.09],[28.34,33.09],[37.35,16.54]],
];
export function markShape(count) {
  return silhouette(count, (g, s) => {
    const k = (s*.82)/VW;                 // fit width, keep aspect
    const ox = (s - VW*k)/2, oy = (s - VH*k)/2;
    for (const poly of MARK_POLYS) {
      g.beginPath();
      poly.forEach(([x, y], i) => (i ? g.lineTo(ox+x*k, oy+y*k) : g.moveTo(ox+x*k, oy+y*k)));
      g.closePath(); g.fill();
    }
  }, .14);
}

export function buildShapes(count) {
  return [
    fieldShape(count), tillShape(count), windowShape(count), codeShape(count),
    rackShape(count), boltShape(count), markShape(count),
  ];
}

/* Upgrade indices 1 (till), 4 (rack) and 5 (bolt→token) in place once the
   generated mattes decode. Returns the indices that actually changed. */
export async function upgradeShapes(shapes, count, base = "assets/particles/") {
  const jobs = [
    [1, "till",  .45],
    [4, "rack",  .55],
    [5, "token", .30],
  ];
  const changed = [];
  await Promise.all(jobs.map(async ([i, slug, d]) => {
    const c = await matteDepth(count, `${base}${slug}_mask.png`, `${base}${slug}_depth.png`, d);
    if (c) { shapes[i] = c; changed.push(i); }
  }));
  return changed;
}
