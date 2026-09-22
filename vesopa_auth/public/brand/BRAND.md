# Vesopa OAuth — web icon and branding assets

Asset set for **auth.vesopa.com** (Vesopa OAuth, Vesopa Software Ltd).

Everything here was rasterised from the official vector source,
`brand_assets/SVG/Vesopa_Logo-01.svg`. Nothing is upscaled from a small PNG.
No mark was redrawn or redesigned — the geometry is byte-for-byte the
official artwork, recoloured per the brand book and re-cropped to a tight
viewBox.

`public/` is mounted at the web root by `src/server.js`, so these files are
served from **`/brand/…`**.

---

## 1. Brand colours

All values below are transcribed from **`brand_assets/BrandBook/VESOPA_Brandbook.pdf`,
page 6, "COLOR PALETTE"**.

### Main palette (page 6, left column, "MAIN PALETTE")

| Name | Hex | RGB | CMYK |
|---|---|---|---|
| Black Color | `#000000` | 0, 0, 0 | 0, 0, 0, 100 |
| White Color | `#FFFFFF` | 255, 255, 255 | 0, 0, 0, 0 |
| Leafy Canopy Color | `#A5C715` | 165, 199, 21 | 44, 0, 100, 0 |
| Nuit Blanche Color | `#164194` | 22, 65, 148 | 100, 80, 0, 0 |
| Platinum Color | `#E3E3E3` | 227, 227, 227 | 0, 0, 0, 15 |

### Additional palette (page 6, right column, "ADDITIONAL PALETTE")

| Name | Hex | RGB | CMYK |
|---|---|---|---|
| Nordic Noir Color | `#00373A` | 0, 55, 58 | 100, 30, 50, 70 |
| Clementine Color | `#EE7203` | 238, 114, 3 | 0, 65, 100, 0 |
| Hobgoblin Color | `#00AD91` | 0, 173, 145 | 77, 0, 53, 0 |
| Abandoned Spaceship Color | `#6E778B` | 110, 119, 139 | 60, 45, 30, 15 |
| Inkblot Color | `#354248` | 53, 66, 72 | 30, 0, 0, 85 |
| Bright Star Color | `#DFE3E4` | 223, 227, 228 | 15, 8, 10, 0 |

### The three used in this set

* `#000000` — brand background. `theme_color` and `background_color`.
  Page 3 ("INTRODUCTION"): *"Set against a black background, the high-contrast
  colour palette of white and green reinforces Vesopa's positioning."*
* `#FFFFFF` — the wordmark and the "V" on that black ground.
* `#A5C715` (Leafy Canopy) — the accent insert in the "V". Never anything else.

`#DFE3E4` (Bright Star) is used once, for the descriptor line on the social
cards, so it reads a step quieter than the white title.

---

## 2. Brand rules applied

**Logo versions — page 4, "LOGO — VERSIONS"**

* On light backgrounds: black wordmark, green accent → `logo-light.svg`,
  `email-logo.png`.
* On dark backgrounds: white wordmark, green accent → `logo-dark.svg`,
  and every icon in this set.
* The stylised "V" may be extracted and used alone "such as app icons, social
  media avatars, or corner branding" — which is what every favicon and app
  icon here uses.

**Safe zone — page 5, "LOGO — SAFE ZONE"**

The diagram marks `0.2A` vertically and `0.2B` horizontally, where A is the
logo height and B is the logo width. For the 7.7:1 wordmark those two readings
differ a lot, so every asset here satisfies **both**: clear space is at least
0.2 × height on the top and bottom *and* at least 0.2 × width on the left and
right.

**Favicon — page 9, "ICONOGRAPHY — FAVICON"**

The brand book specifies the favicon explicitly and illustrates it: a **black
disc** carrying the white "V" with the green accent, plus black rounded-square
versions for iOS home screens (152 iPad / 120 iPhone / 76 iPad). This set
follows that spec exactly. See §5 — it is *not* what the current
`vesopa.com` favicon does.

**Typography — page 8, "TYPOGRAPHY"**

Social cards use the brand faces from `brand_assets/Fonts/`: **Orbitron Bold**
for the title (a primary headline face) and **Blinker Regular** for the
descriptor (a supporting body face).

---

## 3. The files

| File | Dimensions | Bytes | Purpose |
|---|---|---|---|
| `favicon.ico` | 16×16, 32×32, 48×48 (3 frames, 32-bit) | 2,249 | Legacy browser tab icon. Each frame is rendered natively from vector, not downsampled from one bitmap. |
| `favicon-16.png` | 16×16 RGBA | 399 | Tab icon, small. |
| `favicon-32.png` | 32×32 RGBA | 766 | Tab icon, standard. |
| `favicon-48.png` | 48×48 RGBA | 1,090 | Tab icon, hi-dpi / Windows site tile. |
| `favicon.svg` | viewBox `0 0 64 64` | 470 | Vector tab icon; any size, no blur. |
| `apple-touch-icon.png` | 180×180 RGB | 2,503 | iOS "Add to Home Screen". Opaque black, full-bleed square — no alpha channel, so iOS cannot composite it onto black. Deliberately **not** pre-rounded; iOS applies its own squircle mask. |
| `icon-192.png` | 192×192 RGB | 2,291 | PWA icon, `purpose: any`. |
| `icon-512.png` | 512×512 RGB | 4,770 | PWA icon / install prompt / splash, `purpose: any`. |
| `icon-maskable-192.png` | 192×192 RGB | 2,079 | PWA icon, `purpose: maskable`. |
| `icon-maskable-512.png` | 512×512 RGB | 4,557 | PWA icon, `purpose: maskable`. |
| `og-image.png` | 1200×630 RGB | 18,518 | Open Graph card (Facebook, LinkedIn, Slack, WhatsApp, iMessage). |
| `twitter-card.png` | 1200×600 RGB | 18,413 | `summary_large_image` card for Twitter/X. |
| `email-logo.png` | 400×96 RGB | 2,350 | Header logo for transactional email. **Opaque white background** — a transparent PNG renders as a black logo on black in a dark-mode mail client. |
| `app-logo.png` | 128×128 RGBA | 2,753 | Default first-party application logo on the OAuth consent screen. |
| `logo-light.svg` | viewBox `0 0 255.12 33.33` | 2,026 | Full wordmark **for light colour schemes** (black ink, green accent). |
| `logo-dark.svg` | viewBox `0 0 255.12 33.33` | 2,026 | Full wordmark **for dark colour schemes** (white ink, green accent). |
| `site.webmanifest` | — | 815 | PWA manifest. |

Naming: `logo-light` / `logo-dark` are named for the **colour scheme they are
used in**, not the colour of the ink. `logo-dark.svg` is the white one, for
dark mode.

### Maskable icons

Android crops maskable icons to an arbitrary shape. Content must survive a
circle of 80% of the icon width. The "V" here is drawn at 50% of the icon
width, giving a bounding-box half-diagonal of 0.307 × width against a safe
radius of 0.40 × width — a comfortable margin, verified by overlay in
`Documents\Vesopa-Claude-Images\auth_app_icons.png`.

### `app-logo.png` is a tile, not a bare mark

The brief asked for a transparent 128×128. It is a transparent PNG (RGBA, with
transparent corners), but the mark sits on a black rounded-square tile rather
than floating free, because a bare mark was **measured to fail**: the
brand-green limbs of the "V" are invisible against the brand-green `#A5C715`
background, and the black accent is invisible on a dark consent screen. There
is no two-tone transparent treatment that survives white, dark *and* green.
The page-9 tile treatment survives all three. Evidence:
`Documents\Vesopa-Claude-Images\auth_app_logo_grounds.png`.

---

## 4. HTML — paste this into `<head>`

Absolute URLs are required for `og:image` and `twitter:image`; crawlers do not
resolve relative paths. Change the host if this ever moves off
`auth.vesopa.com`.

```html
<!-- Vesopa OAuth — icons, manifest, social cards -->
<meta name="theme-color" content="#000000">

<link rel="icon" href="/brand/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/brand/favicon-16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/brand/site.webmanifest">

<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vesopa OAuth">
<meta property="og:title" content="Vesopa OAuth">
<meta property="og:description" content="One Vesopa account for everything">
<meta property="og:url" content="https://auth.vesopa.com/">
<meta property="og:image" content="https://auth.vesopa.com/brand/og-image.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Vesopa OAuth - One Vesopa account for everything">

<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Vesopa OAuth">
<meta name="twitter:description" content="One Vesopa account for everything">
<meta name="twitter:image" content="https://auth.vesopa.com/brand/twitter-card.png">
<meta name="twitter:image:alt" content="Vesopa OAuth - One Vesopa account for everything">
```

### The wordmark on the login page

```html
<picture>
  <source srcset="/brand/logo-dark.svg" media="(prefers-color-scheme: dark)">
  <img src="/brand/logo-light.svg" alt="Vesopa" width="255" height="33">
</picture>
```

The intrinsic ratio is 255.12 : 33.33. Set one dimension in CSS and let the
other follow; do not set both to values off that ratio.

### If the login page is white in light mode

A single black `theme-color` will paint the Android address bar black over a
white page. If that looks wrong, replace the one `theme-color` line with:

```html
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
```

Leave `site.webmanifest` on `#000000` either way — that value drives the PWA
splash screen, which uses the black icons.

---

## 5. Things worth knowing about the source assets

1. **The CSP will block the manifest.** `src/middleware.js` sets
   `default-src 'none'` and declares no `manifest-src`. `manifest-src` falls
   back to `default-src`, so `<link rel="manifest">` is refused and the PWA
   never installs. Adding `"manifest-src 'self'"` to the directive list fixes
   it. `img-src 'self' data:` already covers every image here. *(Not changed —
   outside the scope of this asset work.)*

2. **`/favicon.ico` will 404.** Browsers request the site root path blind,
   regardless of the link tags. Copying `favicon.ico` to `public/favicon.ico`
   as well removes a 404 on every cold visit. *(Not done — outside scope.)*

3. **The existing `vesopa.com` favicon is off-spec.** `favicon.svg` and
   `favicon.png` at the repo root are the "V" with **green limbs and a dark
   `#1D1D1B` insert on transparency** — that is logo variant 03, not the
   favicon the brand book specifies on page 9 (black disc, white "V", green
   accent). This set follows the brand book. If the two services must look
   identical in a tab, the brand book is the one to change to, not away from.

4. **`#1D1D1B` vs `#000000`.** The root `favicon.svg` uses `#1D1D1B` for its
   dark colour. That is the Adobe CMYK (0,0,0,100) → RGB conversion of the
   brand black, not a separate brand colour. The brand book states
   `#000000`; that is what is used here.

5. **The green drifts in the raster exports.** `brand_assets/brand/*.png` and
   the root `favicon.png` carry `#A5C711`, four points off the specified
   `#A5C715`, from a colour-profile conversion on export. Every file in this
   folder is rendered from vector at the exact `#A5C715`.

6. **`brand_assets/brand/512x512.png` is 1024×1024.** The filename is wrong.
   It is also the green-background variant (variant 02: green ground, white
   wordmark, black accent), not an icon. It was not used.

7. **The source SVGs have a 340.16 × 340.16 viewBox around a 255 × 33
   wordmark.** Roughly 92% of the canvas is empty. Dropping either file
   straight into an `<img>` yields a logo about a tenth of the height you
   asked for, floating in space. `logo-light.svg` and `logo-dark.svg` here are
   re-cropped to the artwork.

8. **The wordmark baseline is very slightly ragged in the official artwork.**
   The "e" descends to y=186.75 while every other glyph and the "V" stop at
   y=186.51–186.54 — a 0.21-unit overshoot, 0.63% of the logo height. It is
   sub-pixel at any realistic size and has been left exactly as drawn rather
   than silently "corrected".

9. **Every source SVG contains a dead path**, `<path class="st0"
   d="M79.47,184.69"/>` — a moveto with no drawing commands, filled `#6B6B6A`
   (a grey that appears nowhere in the palette). It renders nothing. Skipped.

10. **The mark is legible at 16px, so no simplification was needed.** The "V"
    is three straight-edged polygons; at 16×16 the white limbs and the green
    accent both survive. The full wordmark does *not* survive — at 16px tall
    it is 123px wide and turns to mud — which is why every favicon uses the
    icon-only mark, as page 4 permits.

---

## 6. How these were produced

No ImageMagick, rsvg, Inkscape, Cairo or `sharp` exists on the build machine.
Every path in the official SVGs uses only straight-line commands
(`M`/`L`/`H`/`V`/`Z` — verified, zero curves), so the assets were rendered with
**Python 3.14 + Pillow 12.3 + numpy 2.5** using a purpose-written exact
rasteriser: even-odd fill by XOR of subpath masks, 4–24× supersampling, and
area-average downsampling in premultiplied alpha.

The generated `logo-light.svg` was rasterised back and compared against a
direct render of the master geometry: **0 differing pixels out of 136,680**.

Rebuild scripts and evidence sheets are in
`C:\Users\Administrator\Documents\Vesopa-Claude-Images\`:
`auth_favicons.png`, `auth_app_icons.png`, `auth_social_email.png`,
`auth_wordmarks.png`, `auth_app_logo_grounds.png`, and the brand book pages
`brandbook_p04/05/06/07/09/10*.png`.
