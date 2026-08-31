/* Ambient drift — the small lights falling through the whole page.
 *
 * A second, independent particle system rendered in screen space over the
 * morphing field. Screen space matters: these are meant to be motes in the air
 * between the viewer and the page, so they must ignore the main camera's
 * parallax and stay put when it swings. That is why they get their own scene
 * and an orthographic camera rather than joining the existing one.
 *
 * One draw call, no per-frame allocation, and every input the shader needs is
 * a uniform — pointer position, click pulses, scroll. The CPU does nothing per
 * frame except write four numbers.
 */

// Neon, but the brand's neon. Lime is the house colour, teal is its cool
// neighbour, amber is the bar light in the hero footage. No magenta, no
// cyberpunk purple: the palette has to survive being seen by a landlord.
const PALETTE = [
  [0.647, 0.780, 0.082],   // #A5C715 lime
  [0.298, 0.812, 0.639],   // #4CCFA3 teal
  [0.894, 0.463, 0.106],   // #E4761B amber
  [0.949, 0.937, 0.902],   // #F2EFE6 paper, the quiet majority
];

export function createAmbient(THREE, { count = 2600, dpr = 1 } = {}) {
  const scene = new THREE.Scene();
  // NDC box: everything is positioned in clip space directly.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const pos = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  const seed = new Float32Array(count);
  const size = new Float32Array(count);
  const tint = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random() * 2 - 1;
    pos[i * 3 + 1] = Math.random() * 2 - 1;
    pos[i * 3 + 2] = 0;
    // A wide spread of speeds is what reads as depth: the slow ones feel far
    // away, the quick ones feel close, without any actual z.
    speed[i] = 0.012 + Math.pow(Math.random(), 2) * 0.075;
    seed[i] = Math.random();
    size[i] = 1.0 + Math.pow(Math.random(), 3) * 3.4;
    // Mostly paper, occasionally coloured. A field where every mote is neon
    // looks like a screensaver; a field where one in five is looks like light.
    tint[i] = Math.random() < 0.34 ? Math.floor(Math.random() * 3) : 3;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  geo.setAttribute("aTint", new THREE.BufferAttribute(tint, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

  const uniforms = {
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uDpr: { value: dpr },
    uPointer: { value: new THREE.Vector2(9, 9) },   // off-screen until moved
    uPointerOn: { value: 0 },
    uOpacity: { value: 0.62 },
    uLight: { value: 0 },                            // rises on the light half
    uPalette: { value: PALETTE.map((c) => new THREE.Vector3(...c)) },
    // Four concurrent clicks is more than anyone produces; the fifth replaces
    // the oldest. Each is (x, y, startTime, unused) in NDC.
    uPulse: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -99, 0)) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aSpeed, aSeed, aSize, aTint;
      uniform float uTime, uAspect, uDpr, uPointerOn, uLight;
      uniform vec2 uPointer;
      uniform vec4 uPulse[4];
      varying float vTint;
      varying float vGlow;
      varying float vFade;

      void main(){
        float t = uTime;

        // Fall, and wrap. mod() over a 2-unit clip space means a mote leaving
        // the bottom re-enters at the top with no bookkeeping on the CPU.
        float y = mod(position.y - t * aSpeed + 1.0, 2.0) - 1.0;
        // A slow lateral sway so the fall is air, not rain.
        float x = position.x + sin(t * 0.27 + aSeed * 6.283) * 0.024;
        vec2 p = vec2(x, y);

        float glow = 0.0;

        // The pointer pushes motes gently aside — the light has presence.
        if (uPointerOn > 0.5) {
          vec2 d = p - uPointer;
          d.x *= uAspect;
          float dist = length(d);
          float push = smoothstep(0.42, 0.0, dist);
          p += normalize(d + vec2(1e-5)) * push * 0.085;
          glow += push * 0.55;
        }

        // Click pulses: a gaussian band travelling outward from the strike.
        // Motes ride the band out and brighten as it passes through them.
        for (int i = 0; i < 4; i++) {
          float age = t - uPulse[i].z;
          if (age < 0.0 || age > 1.8) continue;
          vec2 pd = p - uPulse[i].xy;
          pd.x *= uAspect;
          float r = length(pd);
          float ring = age * 1.25;
          float band = exp(-pow((r - ring) * 5.5, 2.0));
          float decay = 1.0 - age / 1.8;
          p += normalize(pd + vec2(1e-5)) * band * 0.075 * decay;
          glow += band * decay * 1.6;
        }

        // Fade in and out at the top and bottom edges so nothing pops.
        vFade = smoothstep(-1.0, -0.82, y) * (1.0 - smoothstep(0.86, 1.0, y));
        vTint = aTint;
        vGlow = glow;

        gl_PointSize = aSize * uDpr * (1.0 + glow * 1.8);
        gl_Position = vec4(p, 0.0, 1.0);
      }`,
    fragmentShader: `
      precision mediump float;
      uniform vec3 uPalette[4];
      uniform float uOpacity, uLight;
      varying float vTint, vGlow, vFade;

      void main(){
        // Soft round mote with a hot centre.
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float a = 1.0 - smoothstep(0.08, 0.5, r);

        int idx = int(vTint + 0.5);
        vec3 col = uPalette[3];
        if (idx == 0) col = uPalette[0];
        else if (idx == 1) col = uPalette[1];
        else if (idx == 2) col = uPalette[2];

        // On the paper half the motes must darken instead of glow, or they
        // vanish entirely into a bright background.
        col = mix(col, col * 0.34, uLight);

        gl_FragColor = vec4(col * (1.0 + vGlow), a * uOpacity * vFade);
      }`,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  scene.add(points);

  let next = 0;
  return {
    scene,
    camera,
    uniforms,
    material,

    /** Screen aspect, so the pointer and pulse maths stay circular. */
    resize(w, h) { uniforms.uAspect.value = w / Math.max(1, h); },

    /** Pointer in NDC. Pass null when it leaves. */
    pointer(x, y) {
      if (x == null) { uniforms.uPointerOn.value = 0; return; }
      uniforms.uPointer.value.set(x, y);
      uniforms.uPointerOn.value = 1;
    },

    /** Fire a pulse from an NDC point. Oldest slot is recycled. */
    pulse(x, y, time) {
      uniforms.uPulse.value[next].set(x, y, time, 0);
      next = (next + 1) % 4;
    },

    /** 0 on ink, 1 on paper. Drives the mote colour inversion. */
    light(k) {
      uniforms.uLight.value = k;
      uniforms.uOpacity.value = 0.62 - k * 0.22;
      material.blending = k > 0.5 ? THREE.NormalBlending : THREE.AdditiveBlending;
      material.needsUpdate = true;
    },

    update(t) { uniforms.uTime.value = t; },
  };
}
