/* Shooting stars — the top layer of the page.
 *
 * Everything else on this site is either behind the type (the video backdrop,
 * the particle field) or is the type. This is the one layer that crosses in
 * front of all of it, which is exactly why it has to be sparse: a star every
 * few seconds reads as weather, a constant stream reads as a screensaver.
 *
 * They fall top-left to bottom-right, and only once the visitor has actually
 * started reading — a star during the hero competes with the headline for the
 * one moment the headline has.
 *
 * Canvas 2D rather than another WebGL context: this is a dozen line segments a
 * frame, the page already holds a WebGL context for the particle field, and a
 * second one costs a real GPU context switch every frame for no gain.
 */

/* Three lights, weighted. The red is the moon low and dirty on the horizon,
   which is the one the brief asked for; it is rare because a red streak reads
   as an alarm if it happens often. Warm white does most of the work. */
const COLOURS = [
  { rgb: [255, 248, 232], weight: 0.52, name: "white" },   // warm white
  { rgb: [255, 208, 106], weight: 0.30, name: "yellow" },  // amber
  { rgb: [214, 92, 66], weight: 0.18, name: "red" },       // red moon
];

function pickColour() {
  let r = Math.random();
  for (const c of COLOURS) { if ((r -= c.weight) <= 0) return c.rgb; }
  return COLOURS[0].rgb;
}

export function createStars(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Gap between stars. The opening burst is tighter so the first few arrive
  // close together and the effect announces itself, then it settles down.
  const GAP = opts.gap ?? [2600, 7200];
  const OPENING = opts.opening ?? 4;      // how many arrive at the tighter gap
  const OPENING_GAP = [700, 1500];

  let dpr = 1, W = 0, H = 0;
  const stars = [];
  let launched = 0;
  let nextAt = Infinity;                  // armed by start(), not before
  let running = false;
  let raf = 0;

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn() {
    // Enter from the top-left quadrant: either down the left edge or across
    // the top. Both give a stroke travelling down-right across the frame.
    const fromLeft = Math.random() < 0.45;
    const x = fromLeft ? -0.08 * W : (Math.random() * 0.72 - 0.12) * W;
    const y = fromLeft ? (Math.random() * 0.42 - 0.10) * H : -0.08 * H;

    // Roughly 30° below horizontal, with spread. Slightly flatter than 45° so
    // the streak crosses more of a wide screen before it leaves the bottom.
    const angle = (26 + Math.random() * 24) * Math.PI / 180;
    const speed = (0.55 + Math.random() * 0.75) * Math.max(W, H) / 1000;

    stars.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      len: 90 + Math.random() * 230,
      rgb: pickColour(),
      life: 0,
      // Total travel time in ms, so a star always completes its arc rather
      // than being cut off by a frame-rate change.
      span: 1100 + Math.random() * 900,
      width: 1 + Math.random() * 1.4,
    });
  }

  function schedule(now) {
    const [lo, hi] = launched < OPENING ? OPENING_GAP : GAP;
    nextAt = now + lo + Math.random() * (hi - lo);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    ctx.clearRect(0, 0, W, H);

    if (now >= nextAt) { spawn(); launched++; schedule(now); }
    if (!stars.length) return;

    // Additive: the trails are light, so where two cross they brighten rather
    // than one painting over the other.
    ctx.globalCompositeOperation = "lighter";

    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.life += 16.7;
      const t = s.life / s.span;
      if (t >= 1) { stars.splice(i, 1); continue; }

      s.x += s.vx * 16.7;
      s.y += s.vy * 16.7;

      // Fade in fast, hold, fade out slow — a streak that pops into existence
      // at full brightness looks like a dropped frame.
      const a = Math.min(1, t / 0.12) * (1 - Math.pow(t, 2.2));
      const [r, g, b] = s.rgb;

      // The trail, tapering to nothing behind the head.
      const n = Math.hypot(s.vx, s.vy) || 1;
      const tx = s.x - (s.vx / n) * s.len;
      const ty = s.y - (s.vy / n) * s.len;
      const grad = ctx.createLinearGradient(s.x, s.y, tx, ty);
      grad.addColorStop(0, `rgba(${r},${g},${b},${(a * 0.95).toFixed(3)})`);
      grad.addColorStop(0.35, `rgba(${r},${g},${b},${(a * 0.28).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);

      ctx.strokeStyle = grad;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // The head: a small hot core with a soft halo around it.
      const halo = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 9 * s.width);
      halo.addColorStop(0, `rgba(255,255,255,${(a * 0.9).toFixed(3)})`);
      halo.addColorStop(0.4, `rgba(${r},${g},${b},${(a * 0.42).toFixed(3)})`);
      halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 9 * s.width, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
  }

  addEventListener("resize", resize, { passive: true });
  resize();

  return {
    /** Arm the field. Called once the visitor has scrolled off the hero. */
    start() {
      if (running || reduced) return;
      running = true;
      schedule(performance.now());
      raf = requestAnimationFrame(frame);
    },
    /** Send one immediately — used to mark an arrival on the page. */
    burst(n = 1) {
      if (reduced) return;
      for (let i = 0; i < n; i++) setTimeout(spawn, i * 220);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, W, H);
    },
    get running() { return running; },
  };
}
