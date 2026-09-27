# Metric Membership: design system

One system for the member app (`app/`, Flutter) and the staff console
(`server/public/admin`, plain HTML/CSS). Tokens live in `app/lib/brand.dart`
(`MetricBrand`, `Space`, `Radii`) and at the top of `server/public/admin/admin.css`
(`:root`). Change a value in both.

## Colour

The brand is Metric's navy and green (metricgroup.co.uk). Navy carries the
product; green is a signal colour (open, recognised, active), used sparingly
so it keeps meaning something.

| Token | Hex | Use |
| --- | --- | --- |
| `navy900` | `#00144D` | Hero backgrounds, deepest surface |
| `navy` (brand) | `#002788` | Primary buttons, headings on light, links |
| `navy600` | `#1D3FA8` | Gradient partner, hover |
| `navy50` | `#EEF2FB` | Tinted fills, selected rows, icon tiles |
| `green` (brand) | `#5BD601` | On navy only: badges, signals, beams |
| `green700` | `#2F7A00` | Green text/icons on white (AA contrast) |
| `green50` | `#EEFBE3` | Success fills |
| `ink` | `#0B1530` | Body headings |
| `slate` | `#4A5670` | Body text, secondary |
| `muted` | `#8792A8` | Captions, placeholders |
| `line` | `#E4E9F2` | Borders, dividers |
| `canvas` | `#F5F7FB` | App background |
| `amber` / `amber50` | `#B45309` / `#FFF6E5` | Pending, waiting |
| `red` / `red50` | `#C62828` / `#FDECEC` | Refused, destructive |

Rules: never green text on white (use `green700`); never two saturated
colours side by side; one primary (navy) button per screen.

## Type

Plus Jakarta Sans (OFL), bundled, weights 400–800.

| Style | Size / line | Weight |
| --- | --- | --- |
| Display | 30 / 1.15 | 800, tracking -0.5 |
| H1 | 24 / 1.2 | 800, tracking -0.3 |
| H2 | 18 / 1.3 | 700 |
| Title | 16 / 1.35 | 700 |
| Body | 15 / 1.5 | 400–500 |
| Small | 13 / 1.45 | 500 |
| Overline | 11 / 1 | 800, tracking 1.6, upper case |

## Space, radius, elevation

- Space: 4, 8, 12, 16, 20, 24, 32, 48. Page gutter 20; card padding 20.
- Radius: 10 (inputs, chips), 16 (buttons, tiles), 22 (cards), 28 (sheets, hero).
- Elevation: `shadow-sm` 0 1 2 navy@6%; `shadow-md` 0 8 24 navy@10%;
  `shadow-lg` 0 18 40 navy@18% (membership card, primary button only).

## Motion

200 ms for state changes, 350 ms for page/slide, easeOutCubic. The entry
scene loops over 8 s. Everything holds still under reduced motion.

## Components

- **Primary button**: navy fill, white 16/700 label, 56 high, radius 16,
  `shadow-md`. Continue with Vesopa carries the Vesopa mark and a green arrow.
- **Secondary button**: white, 1px `line` border, navy label.
- **Card**: white, 1px `line`, radius 22, no shadow (lists), `shadow-md` (feature).
- **Icon tile**: 40x40, radius 12, `navy50` fill, navy icon.
- **Status pill**: 12/800, radius 99; green-on-navy (open), amber50/amber
  (pending), red50/red (refused).
- **Number plate**: UK yellow (rear) or white (front), black condensed bold.
- **Page header**: centred title (H1) with an overline and one line of help.

## System bars (the phone's top and bottom bars)

Staff choose them under **Appearance → Phone bars** in the console; nothing is
rebuilt or redeployed to change them.

- **Themes** live in `server/src/themes.js`: `stops` (the top bar's gradient;
  the first stop is the still colour and the manifest's `theme_color`),
  `bottom` (the navigation bar), `dark` (white icons). To add one, add an
  entry there; the console, the manifest, the web and the native app all pick
  it up. `barMotion` is `animated` or `still`.
- **Web and installed web app.** Android Chrome takes the top bar from
  `<meta name="theme-color">` and the bottom bar from the page background.
  `server/public/theme.js` (never cached) sets both, from localStorage first so
  there is no white flash, then from `/api/v1/theme` (no-store) on load, every
  minute and whenever the app comes back to the front. When animated it moves
  theme-color through the stops every 120 ms over a 14 s round trip, paused
  while hidden and off under reduced motion. A MutationObserver puts the colour
  back when Flutter's engine writes its own theme-color. Load it with
  `data-paint="page"` on a Flutter page (the page background follows the
  bottom bar) and without it elsewhere (the console).
- **Manifest.** `/manifest.json` is written per request by `server/src/web.js`
  from the build's own `app/web/manifest.json` with the chosen colours, and is
  never cached. An installed app reads it again the next time it opens.
- **Auto-update.** `/api/v1/theme` also carries `build` (the web build's
  index.html time). When it changes, theme.js reloads the page the next time
  it comes back to the front, so a deploy reaches open apps without anybody
  refreshing or losing what they were typing.
- **Native (Android, iPhone, Windows).** Android 15 and later draw apps edge
  to edge and ignore a status bar colour, so `lib/ui/system_bars.dart`
  (`MaterialApp.builder`) paints the strips behind the status and navigation
  bars itself, with the same gradient drift, and sets the icon brightness. The
  choice comes from `/api/v1/brand` → `theme`, is kept in shared_preferences,
  and is fetched again every time the app resumes.
