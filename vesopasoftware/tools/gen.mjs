#!/usr/bin/env node
// Vesopa asset generator — Gemini image models.
//   node tools/gen.mjs --list
//   node tools/gen.mjs R1 R6 R7            generate recipe ids (sequential)
//   node tools/gen.mjs --all               every recipe not already on disk
//   node tools/gen.mjs --prompt "..." --out assets/gen/x.png [--model nbpro|nb2] [--ar 16:9] [--size 1K|2K|4K]
//   node tools/gen.mjs --prompt "..." --ref a.png --ref b.png --out y.png     (edit / style-reference)
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname } from 'node:path';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY not set — run: source tools/.env'); process.exit(2); }

const MODELS = {
  nbpro: 'gemini-3-pro-image',       // Nano Banana Pro — hero stills. ~90s at 2K.
  nb2:   'gemini-3.1-flash-image',   // Nano Banana 2   — drafts, mattes, depth. ~14s at 1K.
  omni:  'gemini-omni-1.1-flash',
  flash: 'gemini-flash-latest',
};
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const argv = process.argv.slice(2);
const arg  = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const all  = (n) => argv.reduce((a, v, i) => (v === '--' + n ? [...a, argv[i + 1]] : a), []);
const has  = (n) => argv.includes('--' + n);

async function generate({ model = 'nbpro', prompt, refs = [], ar = '16:9', size = '2K', out, tries = 3 }) {
  const id = MODELS[model] || model;
  const parts = [];
  for (const r of refs) {
    if (!existsSync(r)) throw new Error('missing reference image: ' + r);
    parts.push({ inlineData: { mimeType: MIME[extname(r).toLowerCase()] || 'image/png',
                               data: readFileSync(r).toString('base64') } });
  }
  parts.push({ text: prompt });

  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ar, imageSize: size } },
  });

  let lastErr;
  for (let a = 1; a <= tries; a++) {
    let res, txt;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': KEY },
        body,
        // nbpro at 2K genuinely takes ~90s and 4K longer. Without this a stalled
        // socket hangs the whole run with no output at all.
        signal: AbortSignal.timeout(200_000),
      });
      txt = await res.text();
    } catch (e) {
      lastErr = 'fetch: ' + e.message;
      console.error(`  retry ${a}/${tries} ${out}: ${e.message}`);
      await sleep(5000 * a); continue;
    }

    if (!res.ok) {
      lastErr = `HTTP ${res.status}: ${txt.slice(0, 300)}`;
      console.error(`  retry ${a}/${tries} ${out}: HTTP ${res.status}`);
      if (res.status === 400 || res.status === 403) break;   // bad prompt / bad key — retrying won't help
      // 503 means the model is at capacity ("high demand"). Seconds won't help.
      await sleep((res.status === 503 ? 45000 : 6000) * a); continue;
    }
    const cand = JSON.parse(txt).candidates?.[0];
    const img  = cand?.content?.parts?.find(p => p.inlineData);
    if (!img) {
      // Safety refusals and text-only replies land here; the text says why.
      const t = cand?.content?.parts?.map(p => p.text).filter(Boolean).join(' ')
             || cand?.finishReason || txt.slice(0, 200);
      lastErr = 'no image: ' + t;
      console.error(`  retry ${a}/${tries} ${out}: ${t.slice(0, 110)}`);
      await sleep(4000 * a); continue;
    }
    // The API returns image/jpeg whatever you name the file. Write what it
    // actually sent, then convert to PNG so mattes and depth maps are lossless.
    mkdirSync(dirname(out), { recursive: true });
    const tmp = out + '.raw.jpg';
    writeFileSync(tmp, Buffer.from(img.inlineData.data, 'base64'));
    if (out.endsWith('.png') && img.inlineData.mimeType !== 'image/png') {
      execFileSync('sips', ['-s', 'format', 'png', tmp, '--out', out], { stdio: 'ignore' });
      unlinkSync(tmp);
    } else { execFileSync('mv', [tmp, out]); }
    return out;
  }
  throw new Error(lastErr);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- recipes ----
const rp = new URL('./recipes.json', import.meta.url);
const recipes = existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) : {};

if (has('list')) {
  for (const [k, v] of Object.entries(recipes))
    console.log(`${k.padEnd(7)} ${(v.model||'nbpro').padEnd(6)} ${String(v.ar).padEnd(5)} ${(v.size||'2K').padEnd(3)} ${existsSync(v.out)?'✓':' '} ${v.out}`);
  process.exit(0);
}

const AS = arg('as');                     // override every recipe's model
const named = argv.filter(a => !a.startsWith('--') && recipes[a]);
let jobs;
if (has('all'))       jobs = Object.entries(recipes).map(([id, v]) => ({ id, ...v })).filter(j => !existsSync(j.out));
else if (named.length) jobs = named.map(id => ({ id, ...recipes[id] }));
else jobs = [{ id: 'adhoc', prompt: arg('prompt'), out: arg('out', 'assets/gen/adhoc.png'),
               model: arg('model', 'nbpro'), ar: arg('ar', '16:9'), size: arg('size', '2K'), refs: all('ref') }];

if (AS) jobs = jobs.map(j => ({ ...j, model: AS }));

let ok = 0, fail = 0;
for (const j of jobs) {
  if (!j.prompt) { console.error('no prompt for ' + j.id); fail++; continue; }
  const t = Date.now();
  try { await generate(j); console.log(`ok   ${j.id.padEnd(7)} ${((Date.now()-t)/1000).toFixed(0).padStart(3)}s  ${j.out}`); ok++; }
  catch (e) { console.error(`FAIL ${j.id.padEnd(7)} ${e.message}`); fail++; }
}
console.log(`\n${ok} ok, ${fail} failed`);
