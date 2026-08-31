---
name: run-vesopasoftware
description: Build, serve, drive and screenshot the vesopasoftware.com marketing site and its customer/admin portal, and generate its imagery with the Gemini image models. Use when asked to run, start, serve, screenshot, or visually check the Vesopa Software site, to verify the particle scroll spine, to work on the portal, quotes, invoicing or logins, or to generate/regenerate site assets.
---

# Running vesopasoftware.com

Two halves that share one origin and one server:

- **The marketing site** (`site/`) — scroll-driven, one WebGL particle field
  (one draw call) morphing through seven targets, and a night→dawn→day colour
  ramp timed to the story section. No build step, no framework.
- **The portal** (`server/`) — Express + MySQL + EJS at `/portal`: customer
  accounts and teams, project tracking, files, tasks, a live message thread over
  websockets, quotes, invoicing, recurring billing and an admin panel.

Nothing interesting happens on the marketing side until you scroll, and the
field only exists inside WebGL — `curl` tells you nothing. Drive it with
`tools/drive.mjs`.

All paths below are relative to `vesopasoftware/`.

## Prerequisites

```bash
npm install                          # express, mysql2, ws, playwright, …
npx playwright install chromium      # ~/Library/Caches/ms-playwright
cp .env.example .env                 # defaults match MAMP out of the box
```

MySQL comes from MAMP: `127.0.0.1:3306`, `root`/`root`, socket
`/tmp/mamp3306.sock`. Start MAMP before the server. It is MySQL 5.7, **not**
MariaDB, so the plain `utf8mb4_unicode_ci` collation in `server/schema.sql` is
stable here — do not copy that file to a MariaDB 11.4 box unchanged.

```bash
npm run db:setup                     # create the database + apply schema
npm run db:seed                      # accounts + demo workload (idempotent)
```

Seeded logins — admin `info@vesopasoftware.com`, customer `muzahid@onzep.uk`,
both `@Vesopa2026`.

## Run (agent path)

One server now serves both halves. Background it:

```bash
npm start &                          # site + portal + websockets on :5090
node tools/drive.mjs check --url "http://localhost:5090/?probe=1"
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

`npm start`, then <http://localhost:5090/>. Scroll slowly — the whole design is
in the scroll, and the colour ramp is timed to the story rather than to a fixed
number of viewports. Append `?probe=1` only when measuring; it makes the WebGL
drawing buffer readable and costs real frames.

`npm run serve` still exists (threaded static server on :5080) but serves
`site/` **only**: no `/portal`, no `/api`, so the quote builder and contact form
on the marketing page cannot submit, and `<video>` has no Range support. Use it
only for pure-static layout work. `npm start` is the real thing.

## The portal

```
/portal              customer dashboard   /portal/admin        the money view
/portal/login        sign in              /portal/admin/projects
/portal/register     sign up              /portal/admin/invoices
/portal/forgot       password reset       /portal/admin/subscriptions
/portal/invite/:tok  team invitation      /portal/admin/mail    the mock mail log
/portal/ws           websocket            /portal/admin/staff
```

- **Mail is mocked by default** (`MAIL_MODE=mock`). Nothing leaves the machine;
  every message is written to `email_log` and printed. `/portal/admin/mail` is
  how you prove a mail fired. Set `MAIL_MODE=smtp` plus the `SMTP_*` vars for
  real delivery.
- **Payments are mocked by default** (`PAYMENT_MODE=mock`). Paying settles the
  invoice immediately so the earnings figures are exercisable. `PAYMENT_MODE=off`
  hides the button and leaves invoices to be settled by an admin.
- **The subscription sweep** runs on boot and daily, and can be forced from
  `/portal/admin/subscriptions`. It rolls `next_charge_date` forward one
  interval at a time in a loop, so a sweep that has not run for three months
  raises the three invoices it owes rather than one.
- **Money is never incremented in place.** `lib/invoices.js recalc()` reads an
  invoice's items and settled payments back and rewrites the totals, so a
  replayed webhook or a double-settle cannot inflate anything.

Uploads live in `uploads/` (outside the web root) and are served only through
`/portal/files/:id`, which re-checks project access. Do not hang
`express.static` off that directory.

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
- **The hero backdrop must live outside `main`.** `main` is `z-index:1`, which
  makes it a stacking context, so a video placed inside the hero section cannot
  be pushed behind the `#gl` canvas no matter how negative its `z-index` — it
  simply covers the particle field. `#hero-bg` and `#spotlight` are therefore
  siblings of the canvas, like `#plate` already was. The stack is video (-3),
  spotlight (-2), plate (-1), particles (0), type (1).
- **Nothing inside `#hero-bg` can protect the type**, for the same reason: the
  canvas paints above it, so the particle field lands on the headline. The
  guard that does work is `.hero .col::before` — inside `main`, above the
  canvas, below the words. Verified with `_contrast` style pixel sampling:
  hero copy measures 11.6–17.1 against a 4.5 AA threshold.
- **`filter: blur()` on a playing full-screen video is the most expensive thing
  on the page.** It is re-rasterised every frame the video advances. Removing
  it on small screens took mobile from 24fps to 60. Desktop keeps a 2px blur
  and costs ~2fps; do not raise it.
- **Do not animate opacity on the layer holding the blurred video.** The bulb
  warm-up originally ran on `#hero-bg` and dropped the first second of the page
  to 2fps by re-compositing the blur on every keyframe. It runs on `.hero-bulb`
  — one flat opaque sheet — and looks identical.
- **`drive.mjs check` samples fps immediately** and will report a low number
  during the bulb and the video's first decode. Wait ~2s before believing a
  frame rate; settled is 60 desktop and mobile.
- **`python3 -m http.server` is single-threaded** and stalls under Chromium's
  parallel connections. `npm run serve` uses `tools/serve.py`, which threads.
- **`tools/serve.py` answers no Range requests.** `SimpleHTTPRequestHandler`
  returns 200 with the whole file where a browser asked for `206 Partial
  Content`, and Safari simply refuses to play a `<video>` whose source cannot be
  range-requested — which is why clips looked broken there and fine in Chrome.
  `npm start` uses `express.static`, which answers `206` properly. If video is
  "not showing", check which server is up before touching the markup.
- **`.fld label` beat `.opt` on specificity** in the quote form and forced
  `display:block` over its flex row, stacking every tickbox above its own label
  in uppercase mono. Field labels are scoped `.fld > label` for that reason;
  keep it a direct-child selector.
- **`loadUser` must select `org_id` and `org_role`.** Every customer-side
  capability is decided from `org_role` in `lib/permissions.js`, and a column
  left out of that SELECT reads as `undefined`, which silently denies
  everything — the symptom is a 403 on billing and team for a legitimate owner.
- **The public API sits ahead of the CSRF guard, deliberately.** `/api/quote`
  and `/api/contact` are anonymous, act with nobody's authority, and are posted
  from static HTML that cannot carry a session token. They are defended by the
  rate limiter and the honeypot field instead. Everything mounted after
  `app.use(csrf)` does carry authority and is guarded — do not move a route
  across that line without thinking about which side it belongs on.
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
