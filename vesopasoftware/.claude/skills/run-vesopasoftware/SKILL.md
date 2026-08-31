---
name: run-vesopasoftware
description: Build, serve, drive and screenshot the vesopasoftware.com marketing site, and generate its imagery with the Gemini image models. Use when asked to run, start, serve, screenshot, or visually check the Vesopa Software site, to verify the particle scroll spine, or to generate/regenerate site assets.
---

# Running vesopasoftware.com

A static, scroll-driven marketing site. One WebGL particle field (32,768 points,
one draw call) morphs through seven targets as you scroll, and the page inverts
from ink to paper at the Cloud section. There is no build step and no framework.

Nothing interesting happens until you scroll, and the field only exists inside
WebGL — `curl` tells you nothing. Drive it with `tools/drive.mjs`.

All paths below are relative to `vesopasoftware/`.

## Prerequisites

```bash
npm install                          # playwright only
npx playwright install chromium      # ~/Library/Caches/ms-playwright
```

## Run (agent path)

Two terminals, or background the server:

```bash
npm run serve &                      # threaded static server on :5080
node tools/drive.mjs check           # assert the site works; exit 1 if not
node tools/drive.mjs shots           # screenshot each of the 8 sections
node tools/drive.mjs morphs          # screenshot each of the 7 particle targets
node tools/drive.mjs shots --mobile  # iPhone 12 viewport
node tools/drive.mjs video           # decode every clip: dimensions, duration, playable
node tools/drive.mjs eval "document.title"
```

Screenshots land in `shots/` as `<desktop|mobile>-<section>.png`.

`check` asserts: WebGL context up, the field actually rendered (it samples the
canvas), no broken internal links, the page is tall enough to scroll, and the
ink→paper inversion really happens. It prints a list of assets that have not
been generated yet — that list is informational, not a failure.

For anything interactive, the REPL:

```bash
node tools/drive.mjs repl
# goto s5        scroll to a section  (s0 s1 s2 s3 story s5 s6 s7)
# morph 4        scroll to where particle target 4 is fully formed
# ss rack        screenshot to shots/rack.png
# probe          fps, point count, lit pixels, body background, broken images
# eval <expr>    evaluate in the page
# quit
```

`morph <n>` matters: shapes are mapped to raw scroll fraction, not to sections,
so a section's top almost never shows a resolved silhouette. Targets are
`0 field · 1 till · 2 window · 3 code · 4 rack · 5 bolt · 6 mark`.

## Run (human path)

`npm run serve` then open <http://localhost:5080/>. Scroll slowly — the whole
design is in the scroll. Append `?probe=1` only when measuring; it makes the
WebGL drawing buffer readable and costs real frames.

## Video clips

The four clips are generated externally (MiniMax Hailuo, Cinematic, 6s) from the
start frames in `masters/video/`, and dropped into `site/assets/video/` as
`v1_hero.mp4`, `v3_pass.mp4`, `v5_aisle.mp4`, `v6_settle.mp4`. See
`vesopa-video-orders.md` for the exact prompts.

Every new clip needs one pass before it ships:

```bash
python3 tools/faststart.py site/assets/video/*.mp4   # idempotent; keeps a .orig
node tools/drive.mjs video                           # confirm it still decodes
```

`tools/faststart.py` moves the `moov` atom in front of `mdat` and rewrites the
`stco`/`co64` chunk-offset tables to match. Hailuo writes `moov` last, which
forces a browser to download the whole clip before the first frame — invisible
on localhost, a visible stall on 4G. There is no `ffmpeg` on this machine, which
is why this is hand-rolled rather than `-movflags +faststart`.

A well only mounts a clip if it has `data-clip`. Leave the attribute off until
the file exists: pointing it at a missing file is a decoder error
(`MEDIA_ELEMENT_ERROR: Format error`), not a silent no-op.

## Asset pipeline

`masters/` holds the 2K PNGs the model produced (~100 MB, never served).
`site/assets/` holds what actually ships (~2.6 MB). Regenerate one from the
other:

```bash
./tools/optimise.sh                  # masters/ -> site/assets/, idempotent
```

Run it after any generation. It resizes plates to 1600px WebP, tiles to 1024px,
keeps particle mattes as 512px PNG, and rebuilds the 1200x630 OG card.

## Generating imagery

Assets come from the Gemini image models. The key lives in `tools/.env`
(gitignored, chmod 600) — `source tools/.env` first.

```bash
source tools/.env
node tools/gen.mjs --list            # 27 recipes, ✓ marks what is already on disk
node tools/gen.mjs --all             # everything still missing, in dependency order
node tools/gen.mjs R7 R7m R7d        # named recipes
node tools/gen.mjs --model nb2 --ar 1:1 --size 1K \
  --out site/assets/x.png --prompt "..."
node tools/gen.mjs --ref site/assets/particles/till.png \
  --prompt "Convert this image into a pure two-tone mask..." \
  --out site/assets/particles/till_mask.png --model nb2
```

Models: `nbpro` = Nano Banana Pro (`gemini-3-pro-image`), `nb2` = Nano Banana 2
(`gemini-3.1-flash-image`), `omni`, `flash`. Recipe order in `tools/recipes.json`
is dependency-correct — plates before their mattes, ST1 before the story frames
that reference it — so `--all` is always safe to re-run. It skips what exists.

## Gotchas

- **Never run generation concurrently.** Four parallel batches queued so badly
  that an unrelated single request timed out at 120s; sequential finished the
  same work far faster. One process, always.
- **The image API returns JPEG no matter what you name the file**, with a C2PA
  provenance manifest attached. `gen.mjs` converts to PNG on write — this
  matters enormously for the two-tone mattes, where JPEG ringing would put grey
  fringes into a mask that must be pure black and white.
- **Nano Banana Pro at 2K takes 30–90s**, occasionally minutes. That is normal,
  not a hang. `nb2` at 1K is ~13s and is the right choice for mattes and drafts.
- **`waitUntil: 'load'` never resolves.** The lazily-mounted `<video>` elements
  keep a resource pending while their clips are absent, so `document.readyState`
  stops at `interactive` forever. Wait for `window.__vesopaReady` instead.
- **`page.waitForFunction(fn, {timeout})` silently ignores the timeout** —
  options are the *third* argument. Pass `(fn, null, {timeout})`.
- **Headless Chromium renders WebGL in software.** At `deviceScaleFactor: 2` the
  additive, fill-rate-bound particle field starves the rAF loop until CDP calls
  stop answering and the driver hangs with no error. The driver pins DSF to 1.
- **Reading the canvas needs `?probe=1`.** WebGL clears its drawing buffer after
  compositing, so `drawImage(canvas)` returns pure black. The page only sets
  `preserveDrawingBuffer` when that query param is present.
- **`python3 -m http.server` is single-threaded** and stalls under Chromium's
  parallel connections. `npm run serve` uses `tools/serve.py`, which threads.
- **Nano Banana Pro goes down under load.** It returned 503 "experiencing high
  demand" for an extended period while `nb2` stayed healthy throughout. `--as
  nb2` overrides every recipe's model so the set can be pulled anyway; the
  quality difference on photographic plates is small.
- **Clips arrive without faststart.** Always run `tools/faststart.py` on a new
  MP4. `drive.mjs video` is the only reliable probe — hand-parsing MP4 atom
  offsets for width/height gets it wrong, and ImageMagick hangs trying to decode
  video, so ask the browser instead.
- **Generated mattes are not literal silhouettes.** Asked for "every pixel of
  the object becomes white", the model returns a two-tone *brightness* split —
  on the rack, the frame comes back white and the dark unit faces black. It
  still reads correctly as particles, but do not assume mask == outline.
  `matteDepth()` rejects a matte that is under 2% or over 92% solid, and the
  procedural shape stays in place when it does.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `page.goto: Timeout 30000ms exceeded` | You used `waitUntil:'load'`. Use `domcontentloaded` + `__vesopaReady`. |
| Driver hangs with no output at all | DSF > 1 with software WebGL. Keep `deviceScaleFactor: 1`. |
| `FAIL — particle field looks empty (0 lit px)` | Serving without `?probe=1`. The driver's default URL includes it. |
| Field renders as one solid white blob | `uSize` is a pixel size only because the shader divides by `uRef` (camera z). If you change `camera.position.z`, change `uni.uRef` to match or points become ~70× too large. |
| `GEMINI_API_KEY not set` | `source tools/.env` — it is not exported by npm scripts. |
| A recipe fails repeatedly with `no image:` | Read the printed reason. Usually a safety refusal on the prompt; reword rather than retry. |
| Everything 404s under `assets/` | The web root is `site/`. Recipes write to `masters/`; run `./tools/optimise.sh` to produce `site/assets/`. |
| `FAIL ... no image: IMAGE_RECITATION` | The model refused because the output would reproduce training data — common on generic texture prompts ("seamless tileable thermal paper"). Reword concretely rather than retrying; retries always fail the same way. |
| `HTTP 503 ... experiencing high demand` | Nano Banana Pro capacity, not your request. Either wait, or pull the set with `--as nb2` and re-run the hero frames on `nbpro` later. |
