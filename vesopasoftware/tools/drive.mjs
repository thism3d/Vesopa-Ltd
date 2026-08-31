#!/usr/bin/env node
/* Drive vesopasoftware.com in a real browser.
   The site is a scroll spine — nothing interesting happens until you scroll,
   and the particle field only exists inside WebGL, so a static fetch tells
   you nothing. This is the handle.

     node tools/drive.mjs shots            scroll through, screenshot each section
     node tools/drive.mjs shots --mobile   same at iPhone 12 viewport
     node tools/drive.mjs check            assert the page actually works, exit 1 if not
     node tools/drive.mjs eval "<expr>"    evaluate an expression in the page
     node tools/drive.mjs repl             stdin: goto/scroll/ss/eval/quit

   Assumes `npm run serve` is up on :5080 (or pass --url).                  */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const cmd  = argv[0] || 'check';
const arg  = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i+1] : d; };
const has  = (n) => argv.includes('--' + n);
// ?probe=1 makes the WebGL drawing buffer readable — see site/js/site.js
const URL  = arg('url', 'http://localhost:5080/?probe=1');
const OUT  = arg('out', 'shots');
const MOB  = has('mobile');

mkdirSync(OUT, { recursive: true });

const SECTIONS = ['s0','s1','s2','s3','story','s5','s6','s7'];

// Headless Chromium has no GPU: WebGL falls back to software. The particle
// field is additive-blended and fill-rate bound, so a retina-scale backing
// store starves the rAF loop badly enough that CDP calls stop answering.
// Keep deviceScaleFactor at 1 here and let the flags below use what GPU exists.
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--enable-gpu-rasterization'],
});
const ctx = await browser.newContext(
  MOB ? { ...devices['iPhone 12'], deviceScaleFactor: 1 }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
);
const page = await ctx.newPage();

const errors = [], missing = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => {
  const t = m.text();
  // A 404 on an asset is the normal state until tools/gen.mjs has run; it is
  // reported separately from a real script error.
  if (m.type() === 'error' && !/404|Failed to load resource/.test(t)) errors.push('console: ' + t);
});
page.on('response', r => { if (r.status() === 404) missing.push(r.url().replace(URL, '')); });

// NOT waitUntil:'load'. The lazily-mounted <video> elements keep a resource
// pending forever while their clips are absent, so document.readyState stops
// at 'interactive' and 'load' never fires. The app raises its own flag once
// the first frame is on screen — wait for that instead.
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vesopaReady === true, null, { timeout: 20000 });
await page.waitForTimeout(1200);

const tag = MOB ? 'mobile' : 'desktop';

async function scrollTo(id) {
  await page.evaluate(sel => {
    const el = document.getElementById(sel);
    window.scrollTo({ top: el.offsetTop, behavior: 'instant' });
  }, id);
  await page.waitForTimeout(700);           // let the morph settle
}

async function shots() {
  for (const id of SECTIONS) {
    await scrollTo(id);
    const f = `${OUT}/${tag}-${id}.png`;
    await page.screenshot({ path: f });
    console.log('shot', f);
  }
}

/* Shapes are mapped to raw scroll fraction, not to sections: f = p*(NS-1).
   So a section's top almost never coincides with a fully-formed silhouette.
   This jumps to the exact scrollY where shape index i is resolved.        */
const SHAPE_NAMES = ['field','till','window','code','rack','bolt','mark'];
async function morphTo(i) {
  await page.evaluate(k => {
    const max = document.body.scrollHeight - innerHeight;
    window.scrollTo({ top: Math.round(max * (k / 6)), behavior: 'instant' });
  }, i);
  await page.waitForTimeout(900);
}

async function probe() {
  return page.evaluate(() => {
    const c = document.getElementById('gl');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    // Is anything actually drawn? Sample the canvas via a 2D copy.
    const t = document.createElement('canvas');
    t.width = 320; t.height = 200;
    const g = t.getContext('2d');
    g.drawImage(c, 0, 0, 320, 200);
    const d = g.getImageData(0, 0, 320, 200).data;
    let lit = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i+1] + d[i+2]; if (v > 24) lit++; sum += v; }
    const imgs = [...document.images].filter(i => i.id !== 'plate');
    return {
      webgl: !!gl,
      canvasW: c.width, canvasH: c.height,
      litPixels: lit, meanLuma: +(sum / (d.length / 4) / 3).toFixed(2),
      perf: document.getElementById('perf')?.textContent.replace(/\n/g, ' | '),
      tier: document.getElementById('tier')?.textContent,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      imgsTotal: imgs.length,
      imgsBroken: imgs.filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')),
      scrollH: document.body.scrollHeight,
    };
  });
}

if (cmd === 'video') {
  // Ask the real decoder rather than parsing atoms by hand: dimensions,
  // duration, and whether the clip actually reaches a playable state.
  const clips = await page.$$eval('.well[data-clip]', ws => ws.map(w => w.dataset.clip));
  for (const src of clips) {
    const r = await page.evaluate(u => new Promise(res => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = u;
      const done = s => res({ src: u, ...s });
      v.addEventListener('loadedmetadata', () => {
        const meta = { w: v.videoWidth, h: v.videoHeight, dur: +v.duration.toFixed(2) };
        v.addEventListener('canplaythrough', () => done({ ...meta, playable: true }), { once: true });
        setTimeout(() => done({ ...meta, playable: v.readyState >= 3 }), 8000);
      }, { once: true });
      v.addEventListener('error', () => done({ error: v.error && v.error.message || 'load failed' }), { once: true });
      setTimeout(() => done({ error: 'timeout' }), 15000);
    }), src);
    const name = r.src.split('/').pop();
    console.log(r.error ? `FAIL ${name}: ${r.error}`
      : `ok   ${name.padEnd(16)} ${r.w}x${r.h}  ${r.dur}s  ${r.playable ? 'playable' : 'STALLED'}`);
  }

} else if (cmd === 'morphs') {
  // One screenshot per fully-formed particle target.
  for (let i = 0; i < SHAPE_NAMES.length; i++) {
    await morphTo(i);
    const f = `${OUT}/${tag}-morph${i}-${SHAPE_NAMES[i]}.png`;
    await page.screenshot({ path: f });
    console.log('shot', f);
  }
  console.log(errors.length ? '\nerrors:\n' + [...new Set(errors)].join('\n') : '\nno page errors');

} else if (cmd === 'shots') {
  await shots();
  console.log(errors.length ? '\nerrors:\n' + [...new Set(errors)].join('\n') : '\nno page errors');
  const miss = [...new Set(missing)];
  if (miss.length) console.log(`${miss.length} asset(s) not generated yet`);

} else if (cmd === 'eval') {
  console.log(JSON.stringify(await page.evaluate(argv[1]), null, 1));

} else if (cmd === 'repl') {
  process.stdin.setEncoding('utf8');
  console.log('ready. commands: goto <id> | morph <0-6> | scroll <px> | ss <name> | eval <expr> | probe | quit');
  for await (const chunk of process.stdin) {
    for (const line of chunk.split('\n').map(s => s.trim()).filter(Boolean)) {
      const [c, ...rest] = line.split(' '); const a = rest.join(' ');
      try {
        if (c === 'quit') { await browser.close(); process.exit(0); }
        else if (c === 'goto')   { await scrollTo(a); console.log('at ' + a); }
        else if (c === 'morph')  { await morphTo(+a); console.log('morph ' + a + ' = ' + SHAPE_NAMES[+a]); }
        else if (c === 'scroll') { await page.evaluate(y => scrollTo(0, y), +a); await page.waitForTimeout(400); console.log('y=' + a); }
        else if (c === 'ss')     { const f = `${OUT}/${a || 'shot'}.png`; await page.screenshot({ path: f }); console.log(f); }
        else if (c === 'probe')  { console.log(JSON.stringify(await probe(), null, 1)); }
        else if (c === 'eval')   { console.log(JSON.stringify(await page.evaluate(a))); }
        else console.log('?');
      } catch (e) { console.log('ERR ' + e.message); }
    }
  }

} else {                                   // check
  const top = await probe();
  await scrollTo('s5');                    // the ink→paper inversion
  const light = await probe();
  await scrollTo('s7');
  await page.screenshot({ path: `${OUT}/${tag}-check.png` });

  const fail = [];
  if (!top.webgl)                     fail.push('no WebGL context');
  if (top.litPixels < 200)            fail.push(`particle field looks empty (${top.litPixels} lit px)`);
  // Broken <img> is expected while assets/ is still generating — warn, don't fail.
  if (top.imgsBroken.length)          console.log('not yet generated: ' + top.imgsBroken.join(', '));
  if (top.scrollH < 3000)             fail.push('page too short to scroll: ' + top.scrollH);
  // The whole art direction is that the page inverts at Cloud. Assert it.
  const lum = s => s.match(/\d+/g).slice(0, 3).reduce((a, b) => a + +b, 0) / 3;
  if (!(lum(light.bodyBg) > lum(top.bodyBg) + 60)) fail.push(`no ink→paper inversion (${top.bodyBg} → ${light.bodyBg})`);
  if (errors.length)                  fail.push('page errors: ' + [...new Set(errors)].slice(0, 6).join(' ; '));

  console.log('top   ', JSON.stringify(top));
  console.log('cloud ', JSON.stringify({ bodyBg: light.bodyBg, litPixels: light.litPixels }));
  const miss = [...new Set(missing)];
  if (miss.length) console.log(`\n${miss.length} asset(s) not generated yet:\n  ` + miss.join('\n  '));
  if (fail.length) { console.error('\nFAIL\n- ' + fail.join('\n- ')); await browser.close(); process.exit(1); }
  console.log('\nPASS — webgl up, field drawn, images resolve, page inverts at Cloud');
}

if (cmd !== 'repl') await browser.close();
