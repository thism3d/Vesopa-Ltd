/* Vesopa Software — scroll spine.
   One particle field carries the whole page: seven morph targets, one draw
   call, no per-frame allocation. Everything else on the page stays still.  */
import { buildShapes, upgradeShapes } from "./particles.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- tier ----------
   Counts are sized to the brief's mobile promise: 16ms frame time on a
   Pixel 7. The adaptive cut in frame() is the safety net, not the plan. */
const w = innerWidth, coarse = matchMedia("(pointer: coarse)").matches;
let TIER, COUNT;
if (coarse && w < 820) { TIER = "mobile";  COUNT = 4096; }
else if (coarse)       { TIER = "tablet";  COUNT = 16384; }
else if (w < 1500)     { TIER = "laptop";  COUNT = 32768; }
else                   { TIER = "desktop"; COUNT = 65536; }
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

const s5 = document.getElementById("s5");
const s6 = document.getElementById("s6");
const plate = document.getElementById("plate");

function onScroll() {
  const max = Math.max(1, document.body.scrollHeight - innerHeight);
  const p = Math.min(1, Math.max(0, scrollY / max));
  const f = p * (NS - 1);
  const a = Math.min(NS - 2, Math.floor(f));
  setPair(a, a + 1);
  uni.uMorph.value = f - a;

  // inversion: begins as section 05 (Cloud) enters, completes quickly
  const kRaw = Math.min(1, Math.max(0, 1 - (s5.getBoundingClientRect().top / (innerHeight * .72))));
  // Compress the colour change into the middle third of the trigger range and
  // smootherstep it. The grey window still exists but is short enough to read
  // as a flip rather than a fade to mud.
  const kc = Math.min(1, Math.max(0, (kRaw - .34) / .32));
  const k = kc * kc * kc * (kc * (kc * 6 - 15) + 10);
  bgC.copy(INK).lerp(PAPER, k);
  // Pick whichever ink actually wins on contrast against the live background.
  fgC.copy(ratio(PAPER, bgC) >= ratio(INK, bgC) ? PAPER : INK);
  document.body.style.backgroundColor = "#" + bgC.getHexString();
  document.body.style.color = "#" + fgC.getHexString();
  // The hero plate belongs to the hero. Past two viewports it competes with
  // the story images, so fade it out there rather than holding it for the
  // whole dark half.
  if (plate) {
    const fade = Math.max(0, 1 - scrollY / (innerHeight * 1.8));
    plate.style.opacity = String((1 - k) * .30 * fade);
  }

  // particles must survive the inversion: additive on ink, normal on paper
  const nowLight = k > .5;
  if (nowLight !== lightMode) {
    lightMode = nowLight;
    mat.blending = nowLight ? THREE.NormalBlending : THREE.AdditiveBlending;
    mat.needsUpdate = true;
  }
  const payK = Math.min(1, Math.max(0, 1 - (s6.getBoundingClientRect().top / (innerHeight * .6))));
  uni.uColA.value.copy(LIME).lerp(SIGNAL, payK * .9);
  uni.uColB.value.copy(nowLight ? DARKP : PAPER);
  uni.uOpacity.value = BASE_ALPHA * (nowLight ? .85 : 1.0);
  camera.position.y = -p * .35;
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  onScroll();
}, { passive: true });

/* pointer parallax, desktop only */
let px = 0, py = 0, tx = 0, ty = 0;
if (!coarse) addEventListener("pointermove", e => {
  tx = (e.clientX / innerWidth - .5) * .36; ty = (e.clientY / innerHeight - .5) * .24;
}, { passive: true });

/* ---------- lazy video ----------
   Poster is a real <img> so it is the LCP candidate and costs nothing extra.
   The clip only mounts inside one viewport, and only when the tab is not
   asking us to save data. */
const saveData = navigator.connection && navigator.connection.saveData;
if (!reduced && !saveData && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      const well = e.target, src = well.dataset.clip;
      io.unobserve(well);
      if (!src) continue;
      const v = document.createElement("video");
      v.muted = v.loop = v.playsInline = true; v.preload = "auto";
      v.setAttribute("aria-hidden", "true");
      v.src = src;
      v.addEventListener("canplay", () => { v.classList.add("on"); v.play().catch(() => {}); }, { once: true });
      // A missing clip is the normal state until the four externals land.
      v.addEventListener("error", () => v.remove(), { once: true });
      well.appendChild(v);
    }
  }, { rootMargin: "100% 0px" });
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
  requestAnimationFrame(frame);
}

onScroll();
// Signal for tools/drive.mjs: first frame is up, the field exists.
window.__vesopaReady = true;
if (reduced) {
  uni.uDrift.value = 0;
  renderer.render(scene, camera);
  if (perf) perf.textContent = "reduced motion\nstatic frame";
  addEventListener("scroll", () => renderer.render(scene, camera), { passive: true });
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
