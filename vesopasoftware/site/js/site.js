/* Vesopa Software — scroll spine.
   One particle field carries the whole page: seven morph targets, one draw
   call, no per-frame allocation. Everything else on the page stays still.  */
import { buildShapes, upgradeShapes } from "./particles.js";
import { createAmbient } from "./ambient.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- tier ----------
   Counts are sized to the brief's mobile promise: 16ms frame time on a
   Pixel 7. The adaptive cut in frame() is the safety net, not the plan. */
const w = innerWidth, coarse = matchMedia("(pointer: coarse)").matches;
let TIER, COUNT;
if (coarse && w < 820) { TIER = "mobile";  COUNT = 4096; }
else if (coarse)       { TIER = "tablet";  COUNT = 16384; }
else if (w < 1500)     { TIER = "laptop";  COUNT = 24576; }
else                   { TIER = "desktop"; COUNT = 40960; }

// Desktop was 65,536 points across seven morph targets — 1.4 million floats
// generated synchronously before the first frame could be drawn, which is a
// visible stall on the very thing the page is judged by. At 40,960 the field
// reads identically (the points overlap heavily at this density) and the
// build costs about a third less. The adaptive cut in frame() still trims
// further on a machine that cannot hold 60fps.
const DPR = Math.min(devicePixelRatio || 1, 2);
let drawCount = COUNT;

const SHAPES = buildShapes(COUNT);
const NS = SHAPES.length;

/* ---------- three ---------- */
const canvas = document.getElementById("gl");
// ?probe=1 keeps the drawing buffer readable so tools/drive.mjs can measure
// whether the field actually rendered. WebGL clears the buffer after each
// composite, so without this any readback of the canvas comes back empty.
// It costs real performance, so it is never on for visitors.
const PROBE = location.search.includes("probe");
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: true, antialias: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: PROBE,
});
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, .1, 60);
camera.position.z = 4.3;

const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(SHAPES[0], 3));
geo.setAttribute("aA", new THREE.BufferAttribute(SHAPES[0].slice(), 3));
geo.setAttribute("aB", new THREE.BufferAttribute(SHAPES[1].slice(), 3));
const stag = new Float32Array(COUNT), seed = new Float32Array(COUNT), vary = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) { stag[i] = Math.random(); seed[i] = Math.random()*100; vary[i] = Math.random(); }
geo.setAttribute("aStag", new THREE.BufferAttribute(stag, 1));
geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
geo.setAttribute("aVary", new THREE.BufferAttribute(vary, 1));
geo.setDrawRange(0, drawCount);
geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

const uni = {
  uMorph: { value: 0 }, uTime: { value: 0 },
  uSize: { value: TIER === "mobile" ? 3.0 : TIER === "tablet" ? 2.4 : TIER === "laptop" ? 2.0 : 1.6 },
  uDpr: { value: DPR },
  uColA: { value: new THREE.Color("#A5C715") },
  uColB: { value: new THREE.Color("#F2EFE6") },
  uOpacity: { value: 1 }, uDrift: { value: 1 },
  uRef: { value: 4.3 },        // camera z: makes uSize a real pixel size at rest
};

// Additive blending accumulates: N overlapping splats sum to N x alpha. A field
// tuned at 4k points blows out to solid white at 65k. Scale the base alpha by
// the count so every tier lands at roughly the same on-screen density.
const BASE_ALPHA = Math.min(.95, .55 + 8000 / COUNT);
const BASE_SIZE = uni.uSize.value;

const mat = new THREE.ShaderMaterial({
  uniforms: uni, transparent: true, depthWrite: false, depthTest: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute vec3 aA; attribute vec3 aB;
    attribute float aStag; attribute float aSeed; attribute float aVary;
    uniform float uMorph,uTime,uSize,uDpr,uDrift,uRef;
    varying float vV;
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
      vec4 mv = modelViewMatrix * vec4(p,1.0);
      gl_PointSize = uSize * uDpr * (uRef / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    precision mediump float;
    uniform vec3 uColA,uColB; uniform float uOpacity;
    varying float vV;
    void main(){
      vec2 d = gl_PointCoord - 0.5;
      float a = 1.0 - smoothstep(0.22,0.5,length(d));
      if(a<0.01) discard;
      gl_FragColor = vec4(mix(uColA,uColB,vV*0.55), a*uOpacity);
    }`,
});
scene.add(new THREE.Points(geo, mat));

/* ---------- scroll → morph ---------- */
let idxA = 0, idxB = 1;

/** How much of the final target (the Vesopa V) is currently formed, 0..1.
 *  Used to bring the mark back to brand lime wherever it lands in the page. */
function markness() {
  if (idxB !== NS - 1) return 0;
  // uMorph runs 0..1 across the pair; ease it so the colour arrives with the
  // shape rather than ahead of it.
  const t = Math.min(1, Math.max(0, uni.uMorph.value));
  return t * t * (3 - 2 * t);
}
function setPair(a, b, force) {
  if (!force && a === idxA && b === idxB) return;
  idxA = a; idxB = b;
  geo.attributes.aA.array.set(SHAPES[a]); geo.attributes.aA.needsUpdate = true;
  geo.attributes.aB.array.set(SHAPES[b]); geo.attributes.aB.needsUpdate = true;
}

const INK = new THREE.Color("#0B0E0A"), PAPER = new THREE.Color("#F2EFE6");
const LIME = new THREE.Color("#A5C715"), SIGNAL = new THREE.Color("#E4761B");
const DARKP = new THREE.Color("#1E2A12");
const bgC = new THREE.Color(), fgC = new THREE.Color();
let lightMode = false;

/* ---------- night to day ----------
   The page used to cut from ink to paper across two thirds of one viewport,
   straight down the middle of the colour cube — which passes through mud,
   because the shortest path from near-black to warm off-white is grey.

   This walks a dawn instead. Each stop is a real moment of one: the blue hour
   before any sun, the first warm cast on the horizon, low sun, then full
   daylight. Interpolating between adjacent stops keeps the hue moving through
   blue and amber rather than collapsing to neutral, so the eye reads a time of
   day changing rather than a brightness slider being dragged.

   The ramp is also spread over a much longer scroll — from inside the story to
   the middle of Cloud — because that is what makes it feel like a sunrise and
   not a light switch. */
const DAWN = [
  { at: 0.00, c: new THREE.Color("#0B0E0A") },  // night
  { at: 0.30, c: new THREE.Color("#0F1922") },  // blue hour
  { at: 0.52, c: new THREE.Color("#2A2733") },  // the sky lifts, still cold
  { at: 0.70, c: new THREE.Color("#6B4F3C") },  // first warmth on the horizon
  { at: 0.86, c: new THREE.Color("#C7A582") },  // low sun
  { at: 1.00, c: new THREE.Color("#F2EFE6") },  // day
];

function dawnAt(t, out) {
  const k = Math.min(1, Math.max(0, t));
  for (let i = 1; i < DAWN.length; i++) {
    if (k > DAWN[i].at && i < DAWN.length - 1) continue;
    const a = DAWN[i - 1], b = DAWN[i];
    const span = b.at - a.at;
    const local = span <= 0 ? 0 : (k - a.at) / span;
    // Smoothstep inside each segment so the stops do not announce themselves
    // as creases in the gradient.
    const e = local * local * (3 - 2 * local);
    return out.copy(a.c).lerp(b.c, Math.min(1, Math.max(0, e)));
  }
  return out.copy(DAWN[DAWN.length - 1].c);
}

/* WCAG relative luminance, and the contrast ratio between two colours.
   The inversion is the loudest moment on the page and it must never cost
   legibility: rather than lerping the text through the same mid-grey the
   background is passing through, we measure and pick the readable ink. */
const relLum = c => {
  const f = v => (v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4));
  return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b);
};
const ratio = (a, b) => {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
};

const story = document.getElementById("story");
const s5 = document.getElementById("s5");
const s6 = document.getElementById("s6");
const plate = document.getElementById("plate");
const heroBg = document.getElementById("hero-bg");

/* Where the sun comes up, in page coordinates.
 *
 * The colour is the story, so it is timed to the story rather than to a fixed
 * number of viewports. Night holds through the hero and EPOS — the problem and
 * the long build. First light arrives around the third story beat, the one
 * where the thing actually goes into a venue. By the time Cloud is centred it
 * is full day, which is the point: that section is a daylight desk in a
 * working business.
 *
 * Measured off offsetTop rather than a viewport multiple, so a tall phone and
 * a wide desktop reach dawn at the same moment in the narrative instead of at
 * the same number of pixels. Recomputed on resize, because these move.
 */
let dawnStart = 0, dawnEnd = 1;
function measureDawn() {
  const eye = innerHeight * 0.5;                       // what counts as "on screen"
  const storyTop = story ? story.offsetTop : 0;
  const storyH = story ? story.offsetHeight : innerHeight;
  const s5Top = s5 ? s5.offsetTop : storyTop + storyH;
  const s5H = s5 ? s5.offsetHeight : innerHeight;

  dawnStart = storyTop + storyH * 0.34 - eye;          // third beat
  dawnEnd = s5Top + s5H * 0.42 - eye;                  // Cloud, centred
  if (dawnEnd - dawnStart < innerHeight) dawnEnd = dawnStart + innerHeight;
}
measureDawn();

// The eased value the page actually paints. kTarget tracks the scrollbar; kNow
// chases it in the rAF loop, which is what turns a scroll into a sunrise — a
// trackpad flick moves the bar instantly, and the light should not.
let kTarget = 0, kNow = 0;

function readScroll() {
  const max = Math.max(1, document.body.scrollHeight - innerHeight);
  const p = Math.min(1, Math.max(0, scrollY / max));
  // Reach the last target (the V) at 92% of the scroll rather than at the
  // final pixel, so the mark is fully formed and *held* for the whole finale
  // section. Resolving it only at scrollY === max meant the brand mark existed
  // for one scroll position that most people never land on exactly.
  const f = Math.min(1, p / 0.92) * (NS - 1);
  const a = Math.min(NS - 2, Math.floor(f));
  setPair(a, a + 1);
  uni.uMorph.value = f - a;
  camera.position.y = -p * .35;

  kTarget = Math.min(1, Math.max(0, (scrollY - dawnStart) / (dawnEnd - dawnStart)));
}

/** Paint everything that depends on the time of day. Called every frame with
 *  the eased value, never with the raw one. */
function paintDawn(k) {
  dawnAt(k, bgC);
  // Pick whichever ink actually wins on contrast against the live background.
  // Measured, not guessed: the ramp passes through mid-tones where neither
  // choice is obvious, and a threshold would pick wrong in exactly that window.
  fgC.copy(ratio(PAPER, bgC) >= ratio(INK, bgC) ? PAPER : INK);
  document.body.style.backgroundColor = "#" + bgC.getHexString();
  document.body.style.color = "#" + fgC.getHexString();

  // The hero plate belongs to the night. It fades on its own past the hero,
  // and the rising light finishes it off.
  if (plate) {
    const fade = Math.max(0, 1 - scrollY / (innerHeight * 1.8));
    plate.style.opacity = String((1 - k) * .30 * fade);
  }

  // The footage belongs to the hero alone. It is gone by one viewport down,
  // so it never competes with the story plates or survives into the daylight.
  if (heroBg) {
    const gone = Math.max(0, 1 - scrollY / (innerHeight * 0.9));
    heroBg.style.setProperty("--hero-fade", (gone * (1 - k)).toFixed(3));
  }

  // Particles must survive the whole ramp. Additive light on a dark sky is
  // right; on a bright one it blows out, so the switch follows the measured
  // luminance of the live background rather than an arbitrary point in k.
  const nowLight = relLum(bgC) > .18;
  if (nowLight !== lightMode) {
    lightMode = nowLight;
    mat.blending = nowLight ? THREE.NormalBlending : THREE.AdditiveBlending;
    mat.needsUpdate = true;
  }

  // The field warms with the sky, then turns to Pay's signal orange as that
  // section arrives — one continuous colour journey, not two unrelated ones.
  const payK = s6 ? Math.min(1, Math.max(0, 1 - (s6.getBoundingClientRect().top / (innerHeight * .6)))) : 0;
  const warm = Math.min(1, Math.max(0, (k - .45) / .4)) * .55;
  uni.uColA.value.copy(LIME).lerp(SIGNAL, Math.max(warm, payK * .9));

  // ...except for the last shape. The final morph target is the Vesopa V, and
  // it was resolving in Pay's orange purely because it happens to form at the
  // bottom of the page, where the orange lerp is at full strength. The mark is
  // the brand, so it comes home to lime as it assembles: markness is how much
  // of the last target is showing, and the colour is pulled back by exactly
  // that much.
  uni.uColA.value.lerp(LIME, markness());
  uni.uColB.value.copy(PAPER).lerp(DARKP, nowLight ? 1 : 0);
  // The mark reads as a solid green form rather than a two-tone cloud, so the
  // secondary colour collapses into the primary as it resolves.
  uni.uColB.value.lerp(LIME, markness() * .75);
  uni.uOpacity.value = BASE_ALPHA * (nowLight ? .85 : 1.0);

  // The motes live through the same sunrise: additive sparks on the night
  // sky, darkened dust once the page is paper.
  ambient.light(Math.min(1, Math.max(0, (k - .55) / .35)));
}

function onScroll() { readScroll(); }
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  ambient.resize(innerWidth, innerHeight);
  measureDawn();
  readScroll();
  // Snap on resize: easing toward a target that just moved looks like a bug.
  kNow = kTarget;
  paintDawn(kNow);
}, { passive: true });

/* ---------- ambient drift ----------
   The second field: motes falling through screen space, independent of the
   morphing field and of the camera. Sized well below the main field because it
   is additive on top of it — the two together must still land inside the same
   frame budget, so the ambient count is roughly a tenth of the morph count. */
const AMBIENT_COUNT = TIER === "mobile" ? 700 : TIER === "tablet" ? 1400 : 2600;
const ambient = createAmbient(THREE, { count: AMBIENT_COUNT, dpr: DPR });
ambient.resize(innerWidth, innerHeight);

/* pointer parallax, desktop only */
let px = 0, py = 0, tx = 0, ty = 0;
if (!coarse) addEventListener("pointermove", e => {
  tx = (e.clientX / innerWidth - .5) * .36; ty = (e.clientY / innerHeight - .5) * .24;
  // Same pointer, expressed in NDC for the ambient field.
  ambient.pointer((e.clientX / innerWidth) * 2 - 1, (1 - e.clientY / innerHeight) * 2 - 1);
}, { passive: true });
if (!coarse) addEventListener("pointerleave", () => ambient.pointer(null), { passive: true });

/* The hero's click handler reaches the field through this. Published rather
   than imported so hero.js keeps working when WebGL does not come up at all. */
window.__vesopaField = {
  pulse(nx, ny) { ambient.pulse(nx, ny, performance.now() * 0.001); },
};

/* ---------- lazy video ----------
   Poster is a real <img> so it is the LCP candidate and costs nothing extra.
   The clip only mounts inside one viewport, and only when the tab is not
   asking us to save data.

   Thirteen wells now share this observer, so the mount is deliberately
   conservative: one viewport of lookahead rather than two, `preload=metadata`
   rather than `auto`, and the element is only revealed once the browser says
   it can actually play it. Nine of the thirteen clips do not exist yet — a
   404 removes the element and leaves the still, which is the normal state
   until the files land. */
const saveData = navigator.connection && navigator.connection.saveData;
if (!reduced && !saveData && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      const well = e.target, src = well.dataset.clip;
      io.unobserve(well);
      if (!src) continue;
      const v = document.createElement("video");
      v.muted = v.loop = v.playsInline = true;
      v.preload = "metadata";
      v.setAttribute("aria-hidden", "true");
      v.setAttribute("playsinline", "");          // iOS Safari needs the attribute, not just the property
      v.src = src;
      const reveal = () => { v.classList.add("on"); v.play().catch(() => {}); };
      // canplay is the honest signal, but Safari can settle on loadeddata and
      // never fire canplay for a looping muted clip. Take whichever arrives.
      v.addEventListener("canplay", reveal, { once: true });
      v.addEventListener("loadeddata", reveal, { once: true });
      v.addEventListener("error", () => v.remove(), { once: true });
      well.appendChild(v);
    }
  }, { rootMargin: "50% 0px" });
  document.querySelectorAll(".well[data-clip]").forEach(w => io.observe(w));
}

/* ---------- loop + adaptive downgrade ---------- */
const perf = document.getElementById("perf");
const tierEl = document.getElementById("tier");
if (tierEl) tierEl.textContent = TIER + " / " + COUNT.toLocaleString();
let last = performance.now(), acc = 0, frames = 0, fps = 0, settled = 0;

function frame(now) {
  const dt = now - last; last = now;
  acc += dt; frames++;

  // Ease the light toward where the scrollbar says it should be. The rate is
  // per-second and scaled by the real frame time, so the sunrise takes the
  // same wall-clock time at 60fps as it does at 30 — a fixed per-frame lerp
  // would run at half speed on a slow machine.
  if (kNow !== kTarget) {
    const step = 1 - Math.pow(0.0016, Math.min(dt, 60) / 1000);
    kNow += (kTarget - kNow) * step;
    if (Math.abs(kTarget - kNow) < 0.0006) kNow = kTarget;
    paintDawn(kNow);
  }
  if (acc > 500) {
    fps = Math.round(1000 / (acc / frames));
    if (settled > 6 && fps < 52 && drawCount > 6000) {
      drawCount = Math.floor(drawCount * .72);
      geo.setDrawRange(0, drawCount);
      // Nudge size up so the field keeps its mass, but never past 1.45x base:
      // beyond that the points merge and the shape stops being legible.
      uni.uSize.value = Math.min(uni.uSize.value * 1.08, BASE_SIZE * 1.45);
      // Fewer points means less accumulation, so give each one a little more.
      uni.uOpacity.value = Math.min(.95, uni.uOpacity.value * 1.1);
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
  // both passes are depth-testless and transparent, so draw order is the only
  // thing deciding what sits in front — the motes are meant to be nearest.
  ambient.update(now * .001);
  renderer.autoClear = false;
  renderer.render(ambient.scene, ambient.camera);
  renderer.autoClear = true;

  requestAnimationFrame(frame);
}

// Paint the opening state before the first frame, with no easing — the light
// should already be correct when the page appears, and only ease thereafter.
readScroll();
kNow = kTarget;
paintDawn(kNow);

// Signal for tools/drive.mjs: first frame is up, the field exists.
window.__vesopaReady = true;
if (reduced) {
  // No easing for someone who asked for less motion: the colour still tells
  // the story, it just arrives with the scroll instead of chasing it.
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
    readScroll();
    kNow = kTarget;
    paintDawn(kNow);
    still();
  }, { passive: true });
} else {
  requestAnimationFrame(frame);
}

/* Swap the procedural till / rack / bolt for the matte+depth clouds once
   they decode. If the PNGs are absent the procedural shapes simply stay —
   this is why the site is not blocked on asset delivery. */
upgradeShapes(SHAPES, COUNT).then(changed => {
  if (!changed.length) return;
  setPair(idxA, idxB, true);
  if (reduced) renderer.render(scene, camera);
  console.info("[vesopa] matte+depth targets live:", changed.join(","));
});
