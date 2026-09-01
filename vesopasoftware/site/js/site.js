/* Vesopa Software — the scroll spine.
 *
 * One particle field carries the whole page: ten morph targets, one draw call,
 * no per-frame allocation. Everything else — the video behind it, the
 * screenshots pinned in front of it, the stars over the top — hangs off the
 * same scroll read, in the same frame, so nothing can disagree with anything
 * else about where on the page we are.
 *
 * Layer order, back to front, is set in CSS and assumed here:
 *   backdrop video (-6) · grade (-5) · plate (-1) · FIELD (0) ·
 *   words (1) · stars (40) · AI (60) · loader (90)
 */
import { buildShapes, upgradeShapes } from "./particles.js";
import { createAmbient } from "./ambient.js";
import { createBackdrop, createShowcase, createReveals } from "./stage.js";
import { createStars } from "./stars.js";
import { createAudio } from "./audio.js";
import { createLoader } from "./loader.js";
import { mountAI } from "./ai.js";
import { mountMotion } from "./motion.js";
import { wireStoreLinks, mountBadges, isIOS } from "./store.js";
import { wordmarkSVG, wordmarkOnView } from "./wordmark.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ---------- tier ----------
   Counts are sized to hold 16ms on a Pixel 7. The adaptive cut in frame() is
   the safety net, not the plan. Ten morph targets rather than the original
   seven means the build is ~40% more work up front, which is precisely what
   the loader is covering. */
const w = innerWidth, coarse = matchMedia("(pointer: coarse)").matches;
let TIER, COUNT;
if (coarse && w < 820) { TIER = "mobile";  COUNT = 4096; }
else if (coarse)       { TIER = "tablet";  COUNT = 14336; }
else if (w < 1500)     { TIER = "laptop";  COUNT = 22528; }
else                   { TIER = "desktop"; COUNT = 34816; }

const DPR = Math.min(devicePixelRatio || 1, 2);
let drawCount = COUNT;
// Raised by the adaptive downgrade to keep the field's mass as points are cut.
let densityBoost = 1;

/* Shapes carry their own colours now: a per-point palette index and a small
   palette per shape. That is what lets the field resolve the Windows flag in
   four colours, Bitcoin in its orange, a Visa card in its blue and gold, and
   the V with its near-black inner stroke — none of which a single tint over
   the whole field could do. Index 0 always means "the page's own colour". */
const { shapes: SHAPES, regions: REGIONS, palettes: PALETTES } = buildShapes(COUNT);
const NS = SHAPES.length;
// Regions run 0..4 (0 = the page's own colour, 1..4 = the shape's palette), so
// the uniform needs FIVE slots. At four, the Windows flag's fourth pane indexed
// past the end of the array and rendered as undefined colour.
const PAL_SLOTS = 5;

/** A shape's palette, flattened into the vec3 slots the shader reads. */
function palToUniform(list, target) {
  for (let i = 0; i < PAL_SLOTS; i++) {
    const c = list[i - 1];                     // region 1 -> palette[0]
    if (i > 0 && c) target[i].set(c);
    else target[i].set("#000000");
  }
}

/* ---------- three ---------- */
const canvas = document.getElementById("gl");
const PROBE = location.search.includes("probe");
// The fps readout is an instrument, not furniture: it only appears when asked.
if (PROBE) document.body.classList.add("probing");
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: true, antialias: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: PROBE,
});
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, .1, 60);

/* Every shape is normalised into roughly a 2.4-unit box, so the widest of them
 * needs ~1.2 units of horizontal half-extent plus a margin to breathe.
 *
 * A perspective camera's field of view is VERTICAL, so the horizontal extent is
 * that multiplied by the aspect ratio — and on a portrait phone (412x915,
 * aspect 0.45) it collapses to about 1.6 units total. The V was 2.4 wide, so
 * both arms were simply cut off by the edges of the screen, and what was left
 * sat on top of the finale's copy. It looked like the mark had failed to form;
 * it had formed perfectly and been cropped.
 *
 * So the camera is placed to fit the shape rather than pinned at a constant:
 * far enough back that 1.45 units of half-width is always visible.
 */
const FIT_HALF_W = 1.45;
const Z_MIN = 4.3, Z_MAX = 9.5;

function fitCamera() {
  camera.aspect = innerWidth / innerHeight;
  const halfFov = (camera.fov * Math.PI) / 360;
  const zForWidth = FIT_HALF_W / (Math.tan(halfFov) * camera.aspect);
  const z = Math.min(Z_MAX, Math.max(Z_MIN, zForWidth));
  camera.position.z = z;
  // uSize is a pixel size only because the shader divides by uRef; leave this
  // behind and the points scale with the camera, ~70x too large at the far end.
  if (typeof uni !== "undefined") uni.uRef.value = z;
  camera.updateProjectionMatrix();
}

const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(SHAPES[0], 3));
geo.setAttribute("aA", new THREE.BufferAttribute(SHAPES[0].slice(), 3));
geo.setAttribute("aB", new THREE.BufferAttribute(SHAPES[1].slice(), 3));
const stag = new Float32Array(COUNT), seed = new Float32Array(COUNT), vary = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) { stag[i] = Math.random(); seed[i] = Math.random()*100; vary[i] = Math.random(); }
geo.setAttribute("aStag", new THREE.BufferAttribute(stag, 1));
geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
geo.setAttribute("aVary", new THREE.BufferAttribute(vary, 1));
// Per-point palette index for each side of the morph, re-uploaded with the
// positions whenever the pair changes.
geo.setAttribute("aRegA", new THREE.BufferAttribute(REGIONS[0].slice(), 1));
geo.setAttribute("aRegB", new THREE.BufferAttribute(REGIONS[1].slice(), 1));
geo.setDrawRange(0, drawCount);
geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

const uni = {
  uMorph: { value: 0 }, uTime: { value: 0 },
  uSize: { value: TIER === "mobile" ? 3.0 : TIER === "tablet" ? 2.4 : TIER === "laptop" ? 2.0 : 1.7 },
  uDpr: { value: DPR },
  uColA: { value: new THREE.Color("#A5C715") },
  uColB: { value: new THREE.Color("#F2EFE6") },
  uOpacity: { value: 1 }, uDrift: { value: 1 },
  uRef: { value: Z_MIN },      // camera z: makes uSize a real pixel size at rest
  // How much of the shape is formed, 0..1. Shape colours arrive WITH the
  // shape: the same points carry the till and the cloud on the way past, and
  // painting a third of the field Bitcoin orange everywhere would read as a
  // fault rather than a logo.
  uMark: { value: 0 },
  uPalA: { value: Array.from({ length: PAL_SLOTS }, () => new THREE.Color(0, 0, 0)) },
  uPalB: { value: Array.from({ length: PAL_SLOTS }, () => new THREE.Color(0, 0, 0)) },
};

// Additive blending accumulates: N overlapping splats sum to N x alpha. Scale
// the base alpha by the count so every tier lands at the same visual density.
const BASE_ALPHA = Math.min(.95, .55 + 8000 / COUNT);
const BASE_SIZE = uni.uSize.value;

const mat = new THREE.ShaderMaterial({
  uniforms: uni, transparent: true, depthWrite: false, depthTest: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute vec3 aA; attribute vec3 aB;
    attribute float aStag; attribute float aSeed; attribute float aVary;
    attribute float aRegA; attribute float aRegB;
    uniform float uMorph,uTime,uSize,uDpr,uDrift,uRef;
    uniform vec3 uPalA[5]; uniform vec3 uPalB[5];
    varying float vV; varying float vTintK; varying vec3 vTint;
    void main(){
      float t = clamp((uMorph - aStag*0.34)/0.66, 0.0, 1.0);
      t = t*t*(3.0-2.0*t);
      vec3 p = mix(aA,aB,t);
      float burst = sin(3.14159*t);
      p += normalize(p+vec3(0.0001)) * burst * (0.34 + aVary*0.5);
      float s=aSeed, tt=uTime;
      p.x += sin(tt*0.31 + s)*0.028*uDrift;
      p.y += cos(tt*0.27 + s*1.7)*0.028*uDrift;
      p.z += sin(tt*0.22 + s*0.6)*0.030*uDrift;
      vV = aVary;

      // Palette lookup happens here, in the vertex shader, because dynamic
      // indexing of a uniform array is only guaranteed to compile on this
      // side under GLSL ES 1.0. The two sides of the morph are resolved
      // separately and crossfaded, so a point travelling from a white glyph
      // to a lime stroke passes through the colours in between rather than
      // snapping at the halfway mark.
      int ia = int(aRegA + 0.5);
      int ib = int(aRegB + 0.5);
      vec3 ca = uPalA[ia];
      vec3 cb = uPalB[ib];
      float ka = step(0.5, aRegA);
      float kb = step(0.5, aRegB);
      vTint  = mix(ca, cb, t);
      vTintK = mix(ka, kb, t);

      vec4 mv = modelViewMatrix * vec4(p,1.0);
      gl_PointSize = uSize * uDpr * (uRef / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    precision mediump float;
    uniform vec3 uColA,uColB; uniform float uOpacity,uMark;
    varying float vV; varying float vTintK; varying vec3 vTint;
    void main(){
      vec2 d = gl_PointCoord - 0.5;
      float a = 1.0 - smoothstep(0.22,0.5,length(d));
      if(a<0.01) discard;
      vec3 col = mix(uColA,uColB,vV*0.55);
      // A shape's own colours fade in with the shape. uMark is how resolved
      // the current target is, so Bitcoin's orange and the Windows flag
      // arrive as the silhouette does and are gone again by the next section.
      float k = vTintK * uMark;
      col = mix(col, vTint, k);
      // A brand colour on an additive pass is washed out, and a near-black one
      // is invisible — adding dark to dark adds nothing. Give tinted points
      // their own alpha so they paint as mass rather than disappearing.
      gl_FragColor = vec4(col, a * mix(uOpacity, min(1.0, uOpacity + 0.35), k));
    }`,
});
scene.add(new THREE.Points(geo, mat));

/* ---------- the acts ----------
 * The old spine spread the morph evenly across total scroll height, which
 * meant a shape resolved wherever the arithmetic happened to put it — usually
 * halfway between two sections, in the gap, where nobody was looking.
 *
 * Every section now declares which target belongs to it (data-shape), and the
 * morph interpolates between the *centres* of consecutive sections. A shape is
 * therefore fully formed exactly when its section is centred on screen, and in
 * transit the rest of the time. Two sections may name the same target — a
 * showcase and the strip of facts under it both say "till" — which morphs the
 * shape to itself and simply holds it, which is what you want there.
 */
const actEls = [...document.querySelectorAll("[data-shape]")];
let acts = [];                 // { at: pageY of centre, shape: index }

function measureActs() {
  acts = actEls.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      at: scrollY + r.top + r.height / 2 - innerHeight / 2,
      shape: Math.min(NS - 1, Number(el.dataset.shape) || 0),
      el,
    };
  }).sort((a, b) => a.at - b.at);
}

let idxA = 0, idxB = 1;
function setPair(a, b, force) {
  if (!force && a === idxA && b === idxB) return;
  idxA = a; idxB = b;
  geo.attributes.aA.array.set(SHAPES[a]); geo.attributes.aA.needsUpdate = true;
  geo.attributes.aB.array.set(SHAPES[b]); geo.attributes.aB.needsUpdate = true;
  // Colours travel with the geometry, or a point would arrive at the Windows
  // flag still carrying the palette index of the till it came from.
  geo.attributes.aRegA.array.set(REGIONS[a]); geo.attributes.aRegA.needsUpdate = true;
  geo.attributes.aRegB.array.set(REGIONS[b]); geo.attributes.aRegB.needsUpdate = true;
  palToUniform(PALETTES[a], uni.uPalA.value);
  palToUniform(PALETTES[b], uni.uPalB.value);
}

/** How resolved the current target is, 0..1 — eased, not linear. */
function resolvedness() {
  if (idxA === idxB) return 1;                   // held on one shape
  const t = clamp01(uni.uMorph.value);
  return t * t * (3 - 2 * t);
}

/** How much of the final target (the V) is formed, 0..1. */
function markness() {
  if (idxB !== NS - 1) return 0;
  if (idxA === NS - 1) return 1;                 // held past the last act
  return resolvedness();
}

const INK = new THREE.Color("#0B0E0A"), PAPER = new THREE.Color("#F2EFE6");
const LIME = new THREE.Color("#A5C715"), SIGNAL = new THREE.Color("#E4761B");
const DARKP = new THREE.Color("#1E2A12");
const bgC = new THREE.Color(), fgC = new THREE.Color();
let lightMode = false;

/* ---------- night to day ----------
   Each stop is a real moment of a dawn: the blue hour, the first warm cast,
   low sun, then daylight. Interpolating between adjacent stops keeps the hue
   moving through blue and amber rather than collapsing to the mud you get
   walking straight down the middle of the colour cube from black to cream. */
const DAWN = [
  { at: 0.00, c: new THREE.Color("#0B0E0A") },  // night
  { at: 0.30, c: new THREE.Color("#0F1922") },  // blue hour
  { at: 0.52, c: new THREE.Color("#2A2733") },  // the sky lifts, still cold
  { at: 0.70, c: new THREE.Color("#6B4F3C") },  // first warmth on the horizon
  { at: 0.86, c: new THREE.Color("#C7A582") },  // low sun
  { at: 1.00, c: new THREE.Color("#F2EFE6") },  // day
];

function dawnAt(t, out) {
  const k = clamp01(t);
  for (let i = 1; i < DAWN.length; i++) {
    if (k > DAWN[i].at && i < DAWN.length - 1) continue;
    const a = DAWN[i - 1], b = DAWN[i];
    const span = b.at - a.at;
    const local = span <= 0 ? 0 : (k - a.at) / span;
    const e = local * local * (3 - 2 * local);
    return out.copy(a.c).lerp(b.c, clamp01(e));
  }
  return out.copy(DAWN[DAWN.length - 1].c);
}

/* WCAG relative luminance and contrast ratio. The inversion is the loudest
   moment on the page and must never cost legibility, so the ink is measured
   against the live background rather than switched at a threshold. */
const relLum = c => {
  const f = v => (v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4));
  return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b);
};
const ratio = (a, b) => {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
};

const story = document.getElementById("story");
const cloud = document.getElementById("cloud");
const pay = document.getElementById("pay");
const plate = document.getElementById("plate");
const backdropEl = document.getElementById("backdrop");
const gradeEl = document.getElementById("grade");

/* Where the sun comes up, in page coordinates. Timed to the story rather than
   to a fixed number of viewports, so a tall phone and a wide desktop reach
   dawn at the same moment in the narrative. */
let dawnStart = 0, dawnEnd = 1;
function measureDawn() {
  const eye = innerHeight * 0.5;
  const storyTop = story ? story.offsetTop : 0;
  const storyH = story ? story.offsetHeight : innerHeight;
  const cTop = cloud ? cloud.offsetTop : storyTop + storyH;
  const cH = cloud ? cloud.offsetHeight : innerHeight;

  dawnStart = storyTop + storyH * 0.30 - eye;
  dawnEnd = cTop + cH * 0.45 - eye;
  if (dawnEnd - dawnStart < innerHeight) dawnEnd = dawnStart + innerHeight;
}

let kTarget = 0, kNow = 0;
let scrollK = 0;                 // 0..1 down the whole page, for the audio filter

function readScroll() {
  const max = Math.max(1, document.body.scrollHeight - innerHeight);
  scrollK = clamp01(scrollY / max);

  /* morph from the acts */
  if (acts.length) {
    const y = scrollY;
    if (y <= acts[0].at) {
      setPair(acts[0].shape, acts[0].shape);
      uni.uMorph.value = 1;
    } else if (y >= acts[acts.length - 1].at) {
      const s = acts[acts.length - 1].shape;
      setPair(s, s);
      uni.uMorph.value = 1;
    } else {
      let i = 0;
      while (i < acts.length - 2 && y > acts[i + 1].at) i++;
      const a = acts[i], b = acts[i + 1];
      const span = Math.max(1, b.at - a.at);
      setPair(a.shape, b.shape);
      uni.uMorph.value = clamp01((y - a.at) / span);
    }
  }

  camera.position.y = -scrollK * .35;
  kTarget = clamp01((scrollY - dawnStart) / (dawnEnd - dawnStart));
}

/* The field's colour depends on scroll position, not on the dawn: which
 * section is arriving (Pay's orange) and how much of the V has formed. Those
 * keep changing long after the sunrise has finished.
 *
 * This is split out of paintDawn because paintDawn only runs while the light
 * is still easing — and once kNow reaches kTarget it stops being called at
 * all. Everything colour-related therefore froze at whatever it was when the
 * ramp saturated, which is why the brand mark assembled at the foot of the
 * page in Pay's gold instead of coming home to lime. Uniform writes are cheap,
 * so these run every frame; the body background and the DOM writes stay in
 * paintDawn, where they are only paid for when the light actually moves.
 */
function paintField() {
  const payK = pay ? clamp01(1 - (pay.getBoundingClientRect().top / (innerHeight * .6))) : 0;
  const warm = clamp01((kNow - .45) / .4) * .55;
  const m = markness();

  uni.uColA.value.copy(LIME).lerp(SIGNAL, Math.max(warm, payK * .9));
  // ...except the last shape. The V is the brand, so it comes home to lime as
  // it assembles, pulled back by exactly how much of it is showing.
  uni.uColA.value.lerp(LIME, m);
  uni.uColB.value.copy(PAPER).lerp(DARKP, lightMode ? 1 : 0);
  // The mark reads as one solid green form rather than a two-tone cloud, so
  // the secondary colour collapses into the primary as it resolves.
  uni.uColB.value.lerp(LIME, m * .75);
  // Step back where a screenshot is pinned. Those sections already have a
  // device frame and a column of copy competing for the same middle of the
  // screen, and the field at full strength was crossing both — which is what
  // made the text hard to read. beaconK is already an eased measure of how
  // centred the pinned shot is, so the field recedes and returns with it.
  uni.uOpacity.value = Math.min(.95,
    BASE_ALPHA * densityBoost * (lightMode ? .85 : 1.0) * (1 - beaconK * 0.5));
  // How strongly a shape's own colours show. They arrive with the silhouette
  // and are gone by the next section.
  //
  // The V's near-black inner stroke is the one that needs the page to have
  // reached its paper half first: the material is on NormalBlending by then,
  // and near-black added to a night sky under additive blending is nothing at
  // all. Every other palette (Bitcoin's orange, the Windows flag, Visa's blue)
  // is a light colour and shows on either ground.
  const onMark = idxB === NS - 1 || idxA === NS - 1;
  uni.uMark.value = onMark ? (lightMode ? m : 0) : resolvedness();
}

/** Paint everything that depends on the time of day. */
function paintDawn(k) {
  dawnAt(k, bgC);
  fgC.copy(ratio(PAPER, bgC) >= ratio(INK, bgC) ? PAPER : INK);
  document.body.style.backgroundColor = "#" + bgC.getHexString();
  document.body.style.color = "#" + fgC.getHexString();
  // The chips in the fixed bar cannot read the body colour through a blend
  // mode, so they get told which half of the page they are on.
  document.body.classList.toggle("day", relLum(bgC) > .18);

  if (plate) {
    const fade = Math.max(0, 1 - scrollY / (innerHeight * 1.8));
    plate.style.opacity = String((1 - k) * .28 * fade);
  }

  // The footage belongs to the night. It recedes as the light comes up rather
  // than being cut off at a section boundary.
  const bd = (1 - k * 0.92).toFixed(3);
  backdropEl?.style.setProperty("--bd-fade", bd);
  gradeEl?.style.setProperty("--bd-fade", bd);

  // Additive light is right on a dark sky and blows out on a bright one, so
  // the switch follows the measured luminance of the live background.
  const nowLight = relLum(bgC) > .18;
  if (nowLight !== lightMode) {
    lightMode = nowLight;
    mat.blending = nowLight ? THREE.NormalBlending : THREE.AdditiveBlending;
    mat.needsUpdate = true;
  }

  ambient.light(clamp01((k - .55) / .35));
}

/* ---------- ambient drift ---------- */
const AMBIENT_COUNT = TIER === "mobile" ? 700 : TIER === "tablet" ? 1400 : 2400;
const ambient = createAmbient(THREE, { count: AMBIENT_COUNT, dpr: DPR });
ambient.resize(innerWidth, innerHeight);

/* ---------- the backdrop ----------
   One clip per section, declared in the markup. Posters and sources share a
   slug, so the markup says `data-clip="v1_hero"` and both paths follow. */
const backdrop = createBackdrop(backdropEl);
const clipEls = [...document.querySelectorAll("[data-clip]")];
backdrop.register(
  [...new Set(clipEls.map((el) => el.dataset.clip))].map((slug) => ({
    slug,
    src: `assets/video/${slug}.mp4`,
    poster: `assets/video/${slug}.webp`,
  })),
);

/** Whichever clip-bearing section owns the middle of the screen. */
function pickClip() {
  const mid = innerHeight / 2;
  let best = null, bestD = Infinity;
  for (const el of clipEls) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    const d = Math.abs(r.top + r.height / 2 - mid);
    if (d < bestD) { bestD = d; best = el.dataset.clip; }
  }
  if (best) backdrop.show(best);
}

/* ---------- showcases ---------- */
const showcases = [...document.querySelectorAll(".showcase")]
  .map((sec) => createShowcase(sec, {
    onStep: (i, shotEl) => {
      audio.tick();
      // Push the field out from the screenshot as it changes, so the swap is
      // something the whole page does rather than something one <img> does.
      const r = shotEl.getBoundingClientRect();
      window.__vesopaField?.pulse?.(
        ((r.left + r.width / 2) / innerWidth) * 2 - 1,
        (1 - (r.top + r.height / 2) / innerHeight) * 2 - 1,
      );
    },
  }))
  .filter(Boolean);

/* ---------- the beacon ----------
   The field leans toward whatever the page most wants looked at: the pinned
   screenshot, and with it the Store badge beside it. Strength is eased by how
   centred the target is, so the current gathers and releases instead of
   snapping on at a section boundary. */
const beaconEls = [...document.querySelectorAll("[data-beacon]")];
let beaconK = 0;

function updateBeacon() {
  let best = null, bestK = 0;
  for (const el of beaconEls) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    const cy = r.top + r.height / 2;
    // 1 when the element is centred, 0 by the time it is a viewport away.
    const k = clamp01(1 - Math.abs(cy - innerHeight / 2) / (innerHeight * 0.6));
    if (k > bestK) { bestK = k; best = { r, cy }; }
  }
  // Ease, so a fast scroll does not strobe the field between two targets.
  beaconK += ((best ? bestK : 0) - beaconK) * 0.06;
  if (beaconK < 0.01 || !best) return ambient.beacon(null);
  const cx = best.r.left + best.r.width / 2;
  ambient.beacon((cx / innerWidth) * 2 - 1, 1 - (best.cy / innerHeight) * 2, beaconK * 0.85);
}

/* ---------- stars ---------- */
const stars = createStars(document.getElementById("stars"));
let starsArmed = false;

/* ---------- audio ---------- */
const audio = createAudio();
const soundBtn = document.getElementById("sound-btn");
const fsBtn = document.getElementById("fs-btn");
if (soundBtn) {
  if (!audio.available) soundBtn.hidden = true;
  soundBtn.addEventListener("click", async () => {
    const on = audio.enabled ? (audio.disable(), false) : await audio.enable();
    soundBtn.setAttribute("aria-pressed", String(!!on));
    soundBtn.querySelector(".lbl").textContent = on ? "Sound on" : "Sound";
    if (on) audio.scroll(scrollK);
  });
}

/* ---------- scroll ---------- */
function onScroll() {
  readScroll();
  pickClip();
  for (const s of showcases) s.update();
  if (!starsArmed && scrollY > innerHeight * 0.55) { starsArmed = true; stars.start(); }
}
addEventListener("scroll", onScroll, { passive: true });

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false);
  // Rotating a tablet changes the aspect enormously, and with it how far back
  // the camera has to sit for the shape to fit.
  fitCamera();
  ambient.resize(innerWidth, innerHeight);
  measureActs();
  measureDawn();
  onScroll();
  // Snap on resize: easing toward a target that just moved looks like a bug.
  kNow = kTarget;
  paintDawn(kNow);
  paintField();
}, { passive: true });

/* pointer parallax, desktop only */
let px = 0, py = 0, tx = 0, ty = 0;
if (!coarse) addEventListener("pointermove", e => {
  tx = (e.clientX / innerWidth - .5) * .36; ty = (e.clientY / innerHeight - .5) * .24;
  ambient.pointer((e.clientX / innerWidth) * 2 - 1, (1 - e.clientY / innerHeight) * 2 - 1);
}, { passive: true });
if (!coarse) addEventListener("pointerleave", () => ambient.pointer(null), { passive: true });

/* The hero's click handler reaches the field through this. Published rather
   than imported so hero.js keeps working when WebGL does not come up. */
window.__vesopaField = {
  pulse(nx, ny) { ambient.pulse(nx, ny, performance.now() * 0.001); },
  /* What the spine currently thinks. The morph is driven off measured section
     centres, so when a shape fails to resolve on a device the question is
     always "was its act reachable?" — and that is arithmetic, not a hunch. */
  debug() {
    const max = Math.max(1, document.body.scrollHeight - innerHeight);
    return {
      scrollY: Math.round(scrollY), maxScroll: Math.round(max),
      vh: innerHeight, scrollH: document.body.scrollHeight,
      a: idxA, b: idxB, morph: +uni.uMorph.value.toFixed(3),
      markness: +markness().toFixed(3),
      acts: acts.map(x => ({ id: x.el.id || x.el.className, at: Math.round(x.at), shape: x.shape })),
      lastActReachable: acts.length ? acts[acts.length - 1].at <= max : false,
    };
  },
};

/* ---------- loop + adaptive downgrade ---------- */
const perf = document.getElementById("perf");
let last = performance.now(), acc = 0, frames = 0, fps = 0, settled = 0;
let audioK = -1;

function frame(now) {
  const dt = now - last; last = now;
  acc += dt; frames++;

  // Ease the light toward where the scrollbar says it should be. The rate is
  // per-second and scaled by real frame time, so the sunrise takes the same
  // wall-clock time at 60fps as at 30.
  if (kNow !== kTarget) {
    const step = 1 - Math.pow(0.0016, Math.min(dt, 60) / 1000);
    kNow += (kTarget - kNow) * step;
    if (Math.abs(kTarget - kNow) < 0.0006) kNow = kTarget;
    paintDawn(kNow);
  }

  paintField();
  updateBeacon();

  // The filter follows the scroll, but setTargetAtTime on every frame is a lot
  // of scheduling for a parameter that moves slowly.
  if (Math.abs(scrollK - audioK) > 0.01) { audioK = scrollK; audio.scroll(scrollK); }

  if (acc > 500) {
    fps = Math.round(1000 / (acc / frames));
    if (settled > 6 && fps < 52 && drawCount > 6000) {
      drawCount = Math.floor(drawCount * .72);
      geo.setDrawRange(0, drawCount);
      // Nudge size up so the field keeps its mass, but never past 1.45x base:
      // beyond that the points merge and the shape stops being legible.
      uni.uSize.value = Math.min(uni.uSize.value * 1.08, BASE_SIZE * 1.45);
      // Through the multiplier, not uOpacity itself: paintField rewrites that
      // uniform every frame, so a value poked in here was gone by the next one
      // and the field simply thinned out with each downgrade.
      densityBoost = Math.min(1.6, densityBoost * 1.1);
    }
    settled++;
    if (perf) perf.textContent = fps + " fps\n" + drawCount.toLocaleString() + " pts\n" + TIER;
    acc = 0; frames = 0;
  }

  uni.uTime.value = now * .001;
  px += (tx - px) * .045; py += (ty - py) * .045;
  camera.position.x = px; camera.rotation.y = -px * .08; camera.rotation.x = py * .06;

  renderer.render(scene, camera);

  // Second pass, over the first. autoClear off or this wipes the morph field;
  // both passes are depth-testless, so draw order decides what sits in front.
  ambient.update(now * .001);
  renderer.autoClear = false;
  renderer.render(ambient.scene, ambient.camera);
  renderer.autoClear = true;

  requestAnimationFrame(frame);
}

/* ---------- boot ---------- */
fitCamera();
measureActs();
measureDawn();
readScroll();
pickClip();
kNow = kTarget;
paintDawn(kNow);
paintField();

/* The lockup, wherever the page asks for one. Rendered from the module rather
   than written into the HTML so the loader and the page share one copy of the
   artwork, and played once as it arrives. */
for (const slot of document.querySelectorAll("[data-wordmark]")) {
  slot.innerHTML = wordmarkSVG("Vesopa");
  wordmarkOnView(slot);
}

createReveals();
wireStoreLinks();
mountBadges();
mountMotion();
mountAI();

// Sections are tall and full of lazy images; the act positions measured before
// layout settles are wrong by a viewport or more. Re-measure once fonts have
// applied, which is the last thing that moves anything.
document.fonts?.ready.then(() => { measureActs(); measureDawn(); onScroll(); });

// Signal for tools/drive.mjs: first frame is up, the field exists.
window.__vesopaReady = true;

if (reduced) {
  uni.uDrift.value = 0;
  const still = () => {
    renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.render(ambient.scene, ambient.camera);
    renderer.autoClear = true;
  };
  still();
  if (perf) perf.textContent = "reduced motion\nstatic frame";
  addEventListener("scroll", () => {
    kNow = kTarget;
    paintDawn(kNow);
    paintField();
    still();
  }, { passive: true });
} else {
  requestAnimationFrame(frame);
}

/* ---------- the way in ----------
   The loader covers the build above and asks the one question that has to come
   from a click. Skipped entirely for a deep link: someone arriving at #quote
   wants the form, not a title card. */
const deepLink = location.hash && location.hash !== "#s0";
/* Fullscreen is offered everywhere except iOS and iPadOS. Safari there exits
   fullscreen on an upward scroll — it reads the gesture as a request for the
   browser chrome back — and paints its own exit control over the top-left
   corner of the page. A button that loses a fight with the OS every time is
   worse than no button, so on those devices the invitation is sound only. */
const OFFER_FULLSCREEN =
  !isIOS() &&
  !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
if (!OFFER_FULLSCREEN && fsBtn) fsBtn.hidden = true;

const loader = deepLink ? null : createLoader({
  canFullscreen: OFFER_FULLSCREEN,
  async onEnter(withExtras) {
    if (!withExtras) return;
    // Still inside the click, which is the only reason either of these works.
    const okAudio = await audio.enable();
    if (okAudio && soundBtn) {
      soundBtn.setAttribute("aria-pressed", "true");
      soundBtn.querySelector(".lbl").textContent = "Sound on";
      audio.scroll(scrollK);
    }
    try {
      if (OFFER_FULLSCREEN) {
        await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      }
    } catch { /* refused, or unsupported — the page is fine either way */ }
    stars.burst(2);
  },
});

/* Once the visitor is actually on the page, pull the rest of the clips into
   cache in the background so none of them is still downloading when its
   section arrives. */
const warmVideo = () => backdrop.warm();
if (loader) {
  // After the loader is dismissed — not during, when the field is still
  // building and the first clip is competing for the same connection.
  setTimeout(warmVideo, 2500);
} else {
  addEventListener("load", () => setTimeout(warmVideo, 1200), { once: true });
}

// Real milestones rather than a timer pretending to be one. The shapes are
// already built by the time this module body runs, so that is most of it.
loader?.to(0.55);
requestAnimationFrame(() => loader?.to(0.75));
Promise.all([
  document.fonts?.ready ?? Promise.resolve(),
  new Promise((r) => setTimeout(r, 500)),
]).then(() => loader?.to(1));

/* Swap the procedural till and coin for the matte+depth clouds once they
   decode. If the PNGs are absent the procedural shapes stay — which is why the
   site is not blocked on asset delivery. */
upgradeShapes(SHAPES, COUNT).then(changed => {
  if (!changed.length) return;
  setPair(idxA, idxB, true);
  if (reduced) renderer.render(scene, camera);
  console.info("[vesopa] matte+depth targets live:", changed.join(","));
});
