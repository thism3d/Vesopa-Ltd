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

/* Points over the curved wall and both caps of a cylinder, split by real
   surface area so a coin does not end up with its rim denser than its face. */
export function cylinderSurface(out, off, n, cx, cy, cz, r, h, axis = "z") {
  const wall = 2 * Math.PI * r * h;
  const caps = 2 * Math.PI * r * r;
  const wallShare = wall / (wall + caps);
  for (let i = 0; i < n; i++) {
    const th = Math.random() * Math.PI * 2;
    let a, b, c;
    if (Math.random() < wallShare) {
      a = Math.cos(th) * r; b = Math.sin(th) * r; c = (Math.random() - .5) * h;
    } else {
      // sqrt keeps a disc uniform; without it points pile up in the middle.
      const rr = Math.sqrt(Math.random()) * r;
      a = Math.cos(th) * rr; b = Math.sin(th) * rr;
      c = (Math.random() < .5 ? -.5 : .5) * h;
    }
    const k = (off + i) * 3;
    if (axis === "z")      { out[k] = cx + a; out[k+1] = cy + b; out[k+2] = cz + c; }
    else if (axis === "y") { out[k] = cx + a; out[k+1] = cy + c; out[k+2] = cz + b; }
    else                   { out[k] = cx + c; out[k+1] = cy + a; out[k+2] = cz + b; }
  }
}

/* Points on the surface of a sphere. Clouds are built from a handful of these. */
export function sphereSurface(out, off, n, cx, cy, cz, r, squash = 1) {
  for (let i = 0; i < n; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const k = (off + i) * 3;
    out[k]   = cx + Math.sin(ph) * Math.cos(th) * r;
    out[k+1] = cy + Math.sin(ph) * Math.sin(th) * r * squash;
    out[k+2] = cz + Math.cos(ph) * r * squash;
  }
}

/* Sample a 2D drawing and lay the hits onto a plane at a fixed z. Used to put
   a glyph on the face of a solid — the ₿ on the coin, the rows on a screen. */
export function faceGlyph(out, off, n, drawFn, cx, cy, cz, size) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; drawFn(g, 128);
  const px = g.getImageData(0, 0, 128, 128).data;
  const hits = [];
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    if (px[(y * 128 + x) * 4 + 3] > 128) hits.push(x, y);
  }
  const m = hits.length / 2;
  for (let i = 0; i < n; i++) {
    const k = (off + i) * 3;
    if (!m) { out[k] = cx; out[k+1] = cy; out[k+2] = cz; continue; }
    const j = ((Math.random() * m) | 0) * 2;
    out[k]   = cx + (hits[j] / 128 - .5) * size;
    out[k+1] = cy + (.5 - hits[j+1] / 128) * size;
    out[k+2] = cz + (Math.random() - .5) * .012;
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

/* ---------- regions and palettes ----------
 *
 * A shape is not always one colour. The Windows flag is four squares in four
 * colours, Bitcoin is orange with a white glyph, a Visa card carries its own
 * blue, and the Vesopa V is two lime strokes plus a near-black one. None of
 * that is expressible with a single tint over the whole field.
 *
 * So every shape may ship a `regions` array — one byte-ish float per point,
 * 0..3 — and a `palette` of up to four colours. Region 0 always means "use the
 * page's own colour", which is the scroll-driven lime→signal ramp, so a shape
 * that says nothing behaves exactly as before. Regions 1..3 take their colour
 * from the shape's palette.
 *
 * Indices rather than RGB per point because the buffers are re-uploaded on
 * every morph: one float per point instead of three is a third of the traffic,
 * and the palette rides along as two small uniform arrays.                   */

export const REGION_DEFAULT = 0;

/** Fill `regions[off..off+n]` with `r`. No-op when a shape has no regions. */
function mark(regions, off, n, r) {
  if (regions) regions.fill(r, off, off + n);
}

/* ---------- the ten scroll targets ---------- */

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

/* The kitchen display: a wide screen on a foot, with ticket rows on the glass.
   The rows are what make it read as a *kitchen* screen rather than a monitor,
   so they get a fifth of the points and sit slightly proud of the panel. */
export function screenShape(count) {
  const o = new Float32Array(count * 3);
  const panel = Math.floor(count * .56);
  const rows  = Math.floor(count * .22);
  const stand = Math.floor(count * .10);
  const base  = count - panel - rows - stand;

  boxSurface(o, 0, panel, 0, .30, 0, 1.85, 1.12, .08);

  // Three columns of tickets, as on the real display.
  let off = panel;
  const per = Math.floor(rows / 9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      const n = (c === 2 && r === 2) ? rows - (off - panel) : per;
      if (n <= 0) continue;
      boxSurface(o, off, n, -.56 + c * .56, .70 - r * .34, .055, .46, .22, .012);
      off += n;
    }
  }

  boxSurface(o, panel + rows, stand, 0, -.42, 0, .16, .42, .16);
  boxSurface(o, panel + rows + stand, base, 0, -.66, 0, .86, .07, .46);
  return o;
}

/* A cloud: six overlapping spheres, squashed on y and z so it reads as a
   silhouette from the front rather than a bunch of balls. */
export function cloudShape(count) {
  const o = new Float32Array(count * 3);
  const lobes = [
    [-.78,  .00, .00, .46], [-.30, .16, .05, .60], [ .26, .12, -.04, .54],
    [ .78, -.02, .02, .42], [ .00,-.24, .00, .48], [ .50,-.20, .04, .38],
  ];
  const total = lobes.reduce((a, l) => a + l[3] * l[3], 0);
  let off = 0;
  lobes.forEach((l, i) => {
    const n = i === lobes.length - 1 ? count - off : Math.floor(count * (l[3] * l[3]) / total);
    sphereSurface(o, off, n, l[0], l[1] + .18, l[2], l[3], .74);
    off += n;
  });
  return o;
}

/* An envelope: the body, and the flap folded down the front as a shallow V. */
export function envelopeShape(count) {
  const o = new Float32Array(count * 3);
  const body = Math.floor(count * .58);
  boxSurface(o, 0, body, 0, 0, 0, 2.0, 1.28, .07);
  // The flap, drawn on the face so it is a crease rather than a second slab.
  faceGlyph(o, body, count - body, (g, s) => {
    g.lineWidth = s * .045;
    g.strokeStyle = "#fff";
    g.beginPath();
    g.moveTo(s * .06, s * .22); g.lineTo(s * .50, s * .60); g.lineTo(s * .94, s * .22);
    g.stroke();
    g.strokeRect(s * .06, s * .22, s * .88, s * .56);
  }, 0, 0, .05, 2.2);
  return o;
}

/* Bitcoin, in Bitcoin's own colours: the disc in #F7931A and the ₿ struck into
   it in white. Vesopa Pay settles on-chain, so this is the section's subject
   drawn literally rather than a generic token. */
export const COIN_PALETTE = ["#F7931A", "#FFFFFF"];
export function coinShape(count, regions) {
  const o = new Float32Array(count * 3);
  const disc = Math.floor(count * .72);
  cylinderSurface(o, 0, disc, 0, 0, 0, 1.02, .17, "z");
  mark(regions, 0, disc, 1);                       // orange body
  const glyph = count - disc;
  faceGlyph(o, disc, glyph, (g, s) => {
    g.fillStyle = "#fff";
    g.font = `700 ${s * .78}px Georgia, serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("₿", s * .5, s * .52);
  }, 0, 0, .10, 1.5);
  mark(regions, disc, glyph, 2);                   // white glyph
  return o;
}

/* A payment card: slab, chip, stripe. Tilted a little so it has a face and an
   edge rather than reading as a flat rectangle. */
/* Payment card, with the Visa wordmark on its face — the card the till takes,
   in the colours it actually carries. Blue #1A1F71 and the gold #F7B600 of the
   swoosh; both sit on the daylight half of the page, where they read. */
export const CARD_PALETTE = ["#1A1F71", "#F7B600"];
export function cardShape(count, regions) {
  const o = new Float32Array(count * 3);
  const slab  = Math.floor(count * .52);
  const chip  = Math.floor(count * .08);
  const strip = Math.floor(count * .10);
  const word  = Math.floor(count * .22);
  const swoosh = count - slab - chip - strip - word;

  boxSurface(o, 0, slab, 0, 0, 0, 2.10, 1.32, .06);
  boxSurface(o, slab, chip, -.58, .18, .045, .34, .26, .01);
  mark(regions, slab, chip, 2);                                 // gold chip
  boxSurface(o, slab + chip, strip, 0, -.44, .045, 1.86, .17, .01);

  let off = slab + chip + strip;
  faceGlyph(o, off, word, (g, s) => {
    g.fillStyle = "#fff";
    g.font = `italic 700 ${s * .34}px Georgia, serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("VISA", s * .5, s * .5);
  }, .34, .40, .05, 1.5);
  mark(regions, off, word, 1);                                  // blue wordmark
  off += word;
  // The gold underline the wordmark sits on.
  boxSurface(o, off, swoosh, .34, .18, .05, .62, .05, .01);
  mark(regions, off, swoosh, 2);

  // Roll it about x so the top edge comes forward — a card seen dead flat is
  // indistinguishable from the window shape two targets earlier.
  const s = Math.sin(-.34), c = Math.cos(-.34);
  for (let i = 0; i < count; i++) {
    const k = i * 3, y = o[k+1], z = o[k+2];
    o[k+1] = y * c - z * s;
    o[k+2] = y * s + z * c;
  }
  return o;
}

/* The Windows flag — four panes, four colours, skewed the way the logo is.
   All three shipped products are Microsoft Store apps, so this is the platform
   said in one shape, and it is the clearest possible cue for the Store badge
   sitting beside it. */
export const WINDOWS_PALETTE = ["#F25022", "#7FBA00", "#00A4EF", "#FFB900"];
export function windowsShape(count, regions) {
  const o = new Float32Array(count * 3);
  const per = Math.floor(count / 4);
  // Panes: [cx, cy, region]. The gap between them is what makes it read as a
  // flag rather than one square.
  const panes = [
    [-0.56,  0.52, 1], [ 0.56,  0.60, 2],
    [-0.56, -0.60, 3], [ 0.56, -0.52, 4],
  ];
  let off = 0;
  panes.forEach((pane, i) => {
    const n = i === panes.length - 1 ? count - off : per;
    const [cx, cy, r] = pane;
    boxSurface(o, off, n, cx, cy, 0, 0.95, 0.95, 0.06);
    mark(regions, off, n, r);
    off += n;
  });
  // The logo leans: the right-hand panes sit higher and the whole flag is
  // sheared, as though seen in perspective. Applied after the fact so the
  // panes stay square in their own right.
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    o[k + 1] += o[k] * 0.10;      // shear y by x
    o[k] *= 1.02;
  }
  return o;
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

/* The wordmark — the real Vesopa V, traced from favicon.svg
   (viewBox 0 0 46.35 33.09). Three polygons, and they are NOT one colour: the
   two outer strokes are lime and the lower-right inner stroke is near-black
   (#1d1d1b). That dark block is what makes the mark a V rather than a chevron,
   so the field has to be able to paint it.
                                                                             */
const VW = 46.35, VH = 33.09;
const MARK_POLYS = [
  [[9.95,0],[0,0],[18.01,33.09],[27.96,33.09]],           // lime
  [[27.4,16.54],[37.35,16.54],[46.35,0],[36.4,0]],        // lime
  [[27.4,16.54],[18.39,33.09],[28.34,33.09],[37.35,16.54]], // dark
];
const DARK_POLY = 2;

/** Shoelace area, so points are shared out by how much ink each stroke is. */
function polyArea(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Build the V, and report which points landed on the dark stroke.
 *
 * Sampled per polygon rather than as one silhouette: the whole point is to
 * know which stroke each point belongs to, and a single raster of all three
 * throws that away. `flags` is filled with 1 for the dark stroke and 0 for the
 * lime ones — site.js hands it to the shader as an attribute so the mark can
 * resolve in two colours the way the real logo does.
 */
export const MARK_PALETTE = ["#1d1d1b"];
export function markShape(count, regions) {
  const out = new Float32Array(count * 3);
  const areas = MARK_POLYS.map(polyArea);
  const total = areas.reduce((a, b) => a + b, 0);

  let off = 0;
  MARK_POLYS.forEach((poly, i) => {
    const n = i === MARK_POLYS.length - 1 ? count - off : Math.round(count * areas[i] / total);
    if (n <= 0) return;
    const cloud = silhouette(n, (g, s) => {
      const k = (s * .82) / VW;                 // fit width, keep aspect
      const ox = (s - VW * k) / 2, oy = (s - VH * k) / 2;
      g.beginPath();
      poly.forEach(([x, y], j) => (j ? g.lineTo(ox + x * k, oy + y * k) : g.moveTo(ox + x * k, oy + y * k)));
      g.closePath(); g.fill();
    }, .14);
    out.set(cloud, off * 3);
    // The two outer strokes stay region 0 so they follow the page's own colour
    // home to lime; only the inner one is pinned to the mark's near-black.
    if (i === DARK_POLY) mark(regions, off, n, 1);
    off += n;
  });
  return out;
}

/* The ten scroll targets, in page order. Each one is the section it belongs
   to, drawn in points:
 *
 *   0 field     the hero — nothing resolved yet
 *   1 till      Vesopa EPOS
 *   2 screen    Vesopa Kitchen
 *   3 window    Vesopa Customer Display
 *   4 code      the story — how any of this got built
 *   5 cloud     Vesopa Cloud
 *   6 envelope  Vesopa Mail
 *   7 coin      Vesopa Pay
 *   8 card      the build work, and what it costs
 *   9 mark      the V, held through the finale
 */
/**
 * Build all ten targets.
 *
 * Returns `{ shapes, regions, palettes }` — three parallel arrays. `regions[i]`
 * is a per-point palette index for shape i (all zeros where the shape is one
 * colour), and `palettes[i]` is that shape's colour list, where index 0 of the
 * list answers to region 1. Region 0 always means "the page's own colour".
 */
/**
 * Shuffle a shape's points, carrying its regions with them.
 *
 * This is not cosmetic. Every builder lays its parts out in blocks — the V is
 * poly 0, then poly 1, then poly 2; the Windows flag is four consecutive
 * panes; the coin is the disc and then the glyph. The renderer draws
 * `setDrawRange(0, drawCount)`, and the adaptive downgrade lowers drawCount
 * when a machine cannot hold 60fps.
 *
 * A prefix of a block-laid-out buffer is not a smaller version of the shape —
 * it is the *first part of it*. On a 2560x1440 Retina Mac the downgrade cut
 * 34,816 points to 12,994 and the brand mark rendered as a single diagonal
 * stroke, because the other two polygons lived past the end of the draw range.
 * The Windows flag lost three of its four panes the same way. It looked like
 * the shape had failed to form; it had formed and been truncated.
 *
 * Interleaved, any prefix is a uniform sample of the whole shape, so a
 * downgraded field is a sparser V rather than a third of one.
 */
function interleave(positions, regions, count) {
  for (let i = count - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    for (let k = 0; k < 3; k++) {
      const a = i * 3 + k, b = j * 3 + k;
      const t = positions[a]; positions[a] = positions[b]; positions[b] = t;
    }
    if (regions) { const t = regions[i]; regions[i] = regions[j]; regions[j] = t; }
  }
}

export function buildShapes(count) {
  const mk = (fn, palette) => {
    const regions = palette ? new Float32Array(count) : null;
    const positions = fn(count, regions);
    interleave(positions, regions, count);
    return { positions, regions, palette: palette || [] };
  };

  const built = [
    mk(fieldShape),                                 // 0 hero
    mk(tillShape),                                  // 1 EPOS
    mk(screenShape),                                // 2 Kitchen
    mk(windowsShape, WINDOWS_PALETTE),              // 3 Customer Display / Microsoft
    mk(codeShape),                                  // 4 the story
    mk(cloudShape),                                 // 5 Cloud
    mk(envelopeShape),                              // 6 Mail
    mk(coinShape, COIN_PALETTE),                    // 7 Pay — Bitcoin
    mk(cardShape, CARD_PALETTE),                    // 8 the build work — Visa
    mk(markShape, MARK_PALETTE),                    // 9 the V
  ];

  return {
    shapes: built.map((b) => b.positions),
    regions: built.map((b) => b.regions || new Float32Array(count)),
    palettes: built.map((b) => b.palette),
  };
}

/* Swap the procedural till and coin for the matte+depth clouds once their PNGs
   decode. `token` is a photographed metal disc, which is a far better coin
   than a cylinder with a glyph stamped on it. Returns what actually changed;
   a missing or rejected matte simply leaves the procedural shape in place. */
export async function upgradeShapes(shapes, count, base = "assets/particles/") {
  const jobs = [
    [1, "till",  .45],
    [7, "token", .30],
  ];
  const changed = [];
  await Promise.all(jobs.map(async ([i, slug, d]) => {
    const c = await matteDepth(count, `${base}${slug}_mask.png`, `${base}${slug}_depth.png`, d);
    if (c) { shapes[i] = c; changed.push(i); }
  }));
  return changed;
}
