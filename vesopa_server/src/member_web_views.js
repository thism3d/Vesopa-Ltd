/**
 * The members' site's pages (src/member_web.js), as strings.
 *
 * Each one is the Flutter app's screen of the same name, drawn as HTML from
 * the same API answers and in the same words (vesopa_loyalty/lib/ui/):
 * sign_in.dart, card_page.dart, history_page.dart, inbox_page.dart,
 * account_page.dart with membership_section.dart, classes_page.dart and
 * venue_page.dart. Where the app opens a dialog or a sheet, the page opens a
 * <details> or goes to a page of its own, so nothing needs script; the few
 * things only a browser's script can do (a passkey, notifications, the
 * position for nearby offers) are offered only where it is there to do them.
 *
 * THE COLOURS are the venue's look (src/venue_looks.js) in the device's light
 * or dark mode, by the same rules as the app's
 * (vesopa_loyalty/lib/data/venue_style.dart): a warm paper white with the club
 * colour in it, or near black with the club colour in it.
 */
const fs = require('fs');
const path = require('path');

const QR = require('./qr');
const venueLooks = require('./venue_looks');

const CSS = fs.readFileSync(path.join(__dirname, 'member_web.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\n\s*/g, '\n')
  .trim();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ---------------------------------------------------------------------------
// Words for numbers and dates, as the app writes them
// ---------------------------------------------------------------------------

const money = (minor) => `£${(Number(minor || 0) / 100).toFixed(2)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZONE = 'Europe/London';
const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** The venue's own clock: the members are at a club in Wales. */
function local(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(CLOCK.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: p.hour, mi: p.minute };
}

/** "12 Sep 2026, 18:40", or without the time. */
function when(value, { time = true } = {}) {
  // A bare date is a day, not a moment: read as written.
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (bare) return `${Number(bare[3])} ${MONTHS[Number(bare[2]) - 1]} ${bare[1]}`;
  const t = local(value);
  if (!t) return '';
  const day = `${t.d} ${MONTHS[t.mo - 1]} ${t.y}`;
  return time ? `${day}, ${t.h}:${t.mi}` : day;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// The venue's colours and type
// ---------------------------------------------------------------------------

const rgb = (hex) => {
  const v = parseInt(String(hex).replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const toHex = (c) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
/** Color.lerp. */
const mix = (a, b, t) => toHex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));
const rgba = (hex, a) => `rgba(${rgb(hex).join(',')},${Number(a.toFixed(3))})`;
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((x) => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Brand.onColour. */
const onColour = (hex) => (luminance(hex) > 0.5 ? '#111111' : '#FFFFFF');
/** Brand.readableOn: lightened or darkened just enough to read as text. */
function readableOn(c, on, min = 4.5) {
  const toward = luminance(on) < 0.4 ? '#FFFFFF' : '#000000';
  let out = c;
  for (let t = 0.05; contrast(out, on) < min && t <= 1; t += 0.05) out = mix(c, toward, t);
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** The club's three colours: its look's, else made from the back office's main colour. */
function clubOf(brand) {
  const look = venueLooks.lookFor(brand.slug);
  const primary = HEX.test(brand.colours && brand.colours.primary) ? brand.colours.primary : '#1F6FEB';
  const club = look ? look.club : primary;
  return {
    club,
    deep: look ? look.deep : mix(club, '#000000', 0.55),
    glow: look ? look.glow : mix(club, '#FFFFFF', 0.15),
  };
}

/** The drifting lights (ClubGradient), at an intensity, for light or dark. */
function lights({ club, glow }, intensity, dark) {
  const k = intensity * (dark ? 0.6 : 0.75);
  const warm = mix(glow, '#FF6A3D', 0.5);
  return [
    `radial-gradient(circle at 35% 38%,${rgba(glow, 0.85 * k)} 0,${rgba(glow, 0)} 32%)`,
    `radial-gradient(circle at 66% 62%,${rgba(warm, 0.55 * k)} 0,${rgba(warm, 0)} 30%)`,
    `radial-gradient(circle at 50% 80%,${rgba(club, 0.7 * k)} 0,${rgba(club, 0)} 34%)`,
  ].join(',');
}

/** One mode's custom properties. */
function shades(colours, dark) {
  const { club, deep, glow } = colours;
  const bg = dark ? mix('#0B0909', club, 0.10) : mix('#FFFCFA', club, 0.035);
  const text = dark ? '#F7F1F0' : mix('#17100F', club, 0.08);
  const primary = dark ? mix(club, glow, 0.65) : club;
  const error = dark ? '#F2B8B5' : '#B3261E';
  const good = readableOn(primary, bg);
  const vars = {
    bg, text, primary,
    'on-primary': onColour(primary),
    link: good,
    muted: mix(text, bg, 0.35),
    card: dark ? mix(bg, '#FFFFFF', 0.07) : mix(bg, text, 0.045),
    'card-hi': dark ? mix(bg, '#FFFFFF', 0.12) : mix(bg, text, 0.085),
    input: dark ? mix(bg, '#FFFFFF', 0.05) : '#FFFFFF',
    line: mix(bg, text, dark ? 0.16 : 0.13),
    tonal: rgba(primary, dark ? 0.2 : 0.1),
    pill: rgba(primary, dark ? 0.32 : 0.16),
    nav: dark ? mix(bg, '#FFFFFF', 0.05) : mix(bg, club, 0.04),
    icon: dark ? mix(glow, '#FFFFFF', 0.25) : club,
    error,
    'on-error': dark ? '#601410' : '#FFFFFF',
    'error-soft': rgba(error, 0.12),
    good,
    'good-soft': rgba(good, 0.12),
    shadow: rgba(club, dark ? 0.3 : 0.38),
    base: dark ? mix(deep, '#000000', 0.35) : deep,
    lights: lights(colours, 1, dark),
    'lights-bar': lights(colours, 0.6, dark),
  };
  return Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';');
}

/*
 * THE TYPEFACE. Montserrat, Pontardawe RFC's, is served here as small woff2
 * files (about 19 KB a weight) rather than the catalogue's TrueType ones (180
 * KB), and the two weights every page uses are preloaded. Any other family a
 * venue chose in the back office is drawn from its catalogue faces.
 */
const WOFF2 = {
  montserrat: { family: 'Montserrat', faces: [400, 700, 800].map((weight) => ({ weight, url: `/assets/fonts/montserrat/montserrat-latin-${weight}-normal.woff2` })) },
};

function fonts(brand) {
  const look = venueLooks.lookFor(brand.slug);
  const pick = (f) => {
    const slug = (f && f.slug) || (!f && look && look.font) || null;
    if (slug && WOFF2[slug]) return { slug, ...WOFF2[slug], woff2: true };
    return f && f.faces && f.faces.length ? { slug: f.slug, family: f.family, faces: f.faces } : null;
  };
  const body = pick(brand.fonts && brand.fonts.body);
  const head = pick(brand.fonts && brand.fonts.heading) || body;
  const stack = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  const faces = [];
  const preload = [];
  for (const f of [body, head]) {
    if (!f || faces.some((x) => x.slug === f.slug)) continue;
    faces.push(f);
    if (f.woff2) preload.push(...f.faces.filter((x) => x === f.faces[0] || x.weight === 700).map((x) => x.url));
  }
  const css = faces.map((f) => f.faces.map((x) => {
    const format = /\.woff2$/i.test(x.url) ? 'woff2' : /\.woff$/i.test(x.url) ? 'woff' : /\.otf$/i.test(x.url) ? 'opentype' : 'truetype';
    return `@font-face{font-family:"${esc(f.family)}";font-weight:${Number(x.weight) || 400};font-display:swap;src:url(${esc(x.url)}) format("${format}")}`;
  }).join('')).join('');
  return {
    css,
    preload: [...new Set(preload)],
    body: body ? `"${esc(body.family)}",${stack}` : stack,
    head: head ? `"${esc(head.family)}",${stack}` : stack,
  };
}

/** Everything the page's colours and type need, as one <style> head. */
function theme(brand) {
  const colours = clubOf(brand);
  const f = fonts(brand);
  const scale = Math.min(Math.max(Number(brand.font_scale) || 1, 0.8), 1.4);
  const fixed = `--club:${colours.club};--base-dark:${mix(colours.deep, '#000000', 0.35)};--way:${rgba(mix('#0B0909', colours.club, 0.1), 0.6)};--font:${f.body};--font-head:${f.head};--scale:${scale}`;
  return {
    colours,
    preload: f.preload,
    css: `${f.css}:root{${fixed};${shades(colours, false)};color-scheme:light}`
      + `@media (prefers-color-scheme:dark){:root{${shades(colours, true)};color-scheme:dark}}`,
  };
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

const PATHS = {
  card: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h2M20 14v1.5',
  activity: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h4',
  classes: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  venue: 'M4 10v10h16V10M3 10l2-6h14l2 6zM9 20v-6h6v6',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  chev: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  place: 'M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  mobile: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  fingerprint: 'M8.5 20.5c1-2.2 1.5-4.7 1.5-7.5a2 2 0 0 1 4 0c0 2.6-.4 5-1.2 7M5.5 17c.6-1.4.9-2.8.9-4.5a5.6 5.6 0 0 1 11.2 0c0 1.6-.1 3.1-.4 4.5M4 10a8.6 8.6 0 0 1 16 0M12 13c0 3-.6 5.6-1.8 8',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3',
  badge: 'M4 6h16v12H4zM8 10h4M8 14h8',
  renew: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  devices: 'M3 5h13v10H3zM1 19h17M19 9h4v10h-4z',
  check: 'M5 12l5 5 9-10',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5',
  photo: 'M4 7h3l2-2h6l2 2h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  flip: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4',
  gift: 'M4 9h16v4H4zM5 13h14v8H5zM12 9v12M12 9c-2-4-6-4-6-1.5S9 9 12 9zm0 0c2-4 6-4 6-1.5S15 9 12 9z',
  repeat: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 15l2 2 4-4',
  history: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4M12 8v4l3 2',
  busy: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M10 13l4 4M14 13l-4 4',
  near: 'M3 11l18-8-8 18-2-8z',
  family: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 20a6 6 0 0 1 12 0M14 20a4.5 4.5 0 0 1 8-2.8',
  hourglass: 'M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9',
  snow: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9',
  verified: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6zM9 12l2 2 4-4',
};

const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;

const APPLE = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16.37 12.57c-.02-2.36 1.93-3.5 2.02-3.55-1.1-1.61-2.81-1.83-3.42-1.85-1.45-.15-2.84.86-3.58.86-.74 0-1.88-.84-3.09-.82-1.59.02-3.06.93-3.88 2.35-1.66 2.87-.42 7.12 1.19 9.45.79 1.14 1.73 2.42 2.96 2.37 1.19-.05 1.64-.77 3.08-.77 1.43 0 1.84.77 3.09.74 1.28-.02 2.09-1.16 2.87-2.31.9-1.32 1.27-2.6 1.29-2.67-.03-.01-2.48-.95-2.51-3.8zM14.02 5.61c.65-.79 1.09-1.89.97-2.98-.94.04-2.08.63-2.75 1.41-.6.7-1.13 1.82-.99 2.89 1.05.08 2.12-.53 2.77-1.32z"/></svg>';
const PLAY = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor;stroke:none"><path d="M8 5v14l11-7z"/></svg>';
// Google's "G": four arcs in Google's colours, as the app draws it.
const GOOGLE = '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke-width="4">'
  + '<path d="M16.13 4.86A8 8 0 0 0 3.87 4.86" stroke="#EA4335"/><path d="M3.87 4.86A8 8 0 0 0 4.86 16.13" stroke="#FBBC05"/>'
  + '<path d="M4.86 16.13A8 8 0 0 0 16.55 14.59" stroke="#34A853"/><path d="M16.55 14.59A8 8 0 0 0 18 10M10 10h8" stroke="#4285F4"/></svg>';

// ---------------------------------------------------------------------------
// The document every page is
// ---------------------------------------------------------------------------

function logo(brand, size) {
  const url = brand.logo || brand.icon;
  const initial = `<span class="initial" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc((brand.name || '?').trim().charAt(0).toUpperCase() || '?')}</span>`;
  if (!url) return initial;
  return `<img class="logo" src="${esc(url)}" width="${size}" height="${size}" alt="">`;
}

const hidden = (m) => `<input type="hidden" name="_csrf" value="${esc(m.csrf)}">`;
/** A one-button form: how every action that changes something is sent. */
const button = (m, action, label, { cls = 'btn', fields = '' } = {}) =>
  `<form method="post" action="${esc(m.base + action)}">${hidden(m)}${fields}<button class="${cls}">${label}</button></form>`;

function document({ m, brand, title, body, bodyClass = '', script = '' }) {
  const t = theme(brand);
  const icon = brand.icon || brand.logo || `${m.base}icons/Icon-192.png`;
  const description = `${brand.name}: ${String(brand.welcome || '').replace(/\.$/, '')}.`;
  return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + `<title>${esc(title ? `${title} · ${brand.name}` : brand.name)}</title>`
    + `<meta name="description" content="${esc(description)}">`
    + `<meta name="theme-color" content="${t.colours.club}">`
    + '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">'
    + `<meta name="apple-mobile-web-app-title" content="${esc(brand.name)}">`
    + `<link rel="manifest" href="${esc(m.base)}manifest.webmanifest">`
    + `<link rel="icon" href="${esc(icon)}"><link rel="apple-touch-icon" href="${esc(icon)}">`
    + t.preload.map((u) => `<link rel="preload" href="${esc(u)}" as="font" type="font/woff2" crossorigin>`).join('')
    + `<style>${t.css}${CSS}</style></head>`
    + `<body class="${bodyClass}" data-base="${esc(m.base)}" data-csrf="${esc(m.csrf)}">${body}`
    + (script ? `<script nonce="${esc(m.nonce)}">${script}</script>` : '')
    + '</body></html>';
}

// A notification opens the app at #/inbox/<id>: the news it was about.
const OPENED_FROM_NOTIFICATION = "var h=location.hash.match(/^#\\/inbox(?:\\/([^/?#]+))?/);"
  + "if(h)location.replace(document.body.dataset.base+'news'+(h[1]?'/'+encodeURIComponent(h[1]):''));";

/** Whether the Classes tab belongs: the venue runs memberships with classes in a plan. */
function offersClasses(m) {
  if (!m) return false;
  if (m.plan && m.plan.includes_classes) return true;
  return (m.plans_for_sale || []).some((p) => p && p.includes_classes);
}

/** A signed-in page: the club's bar with the bell, the tabs, and the page. */
function signedIn({ m, brand, unread, classes, tab, title, body, script = '' }) {
  const tabs = [
    ['card', '', 'Card'],
    ['activity', 'activity', 'Activity'],
    ...(classes ? [['classes', 'classes', 'Classes']] : []),
    ['account', 'account', 'Account'],
    ['venue', 'venue', 'Venue'],
  ];
  const bar = `<header class="bar club"><a href="${esc(m.base)}">${logo(brand, 34)}</a>`
    + `<a class="name" href="${esc(m.base)}">${esc(brand.name)}</a>`
    + `<a class="bell" href="${esc(m.base)}news" aria-label="${unread > 0 ? `${unread} unread` : 'News'}">${icon('bell')}${unread > 0 ? `<b>${unread > 99 ? '99+' : unread}</b>` : ''}</a></header>`;
  const nav = `<nav class="tabs" aria-label="Sections">${tabs.map(([key, href, label]) =>
    `<a href="${esc(m.base + href)}"${key === tab ? ' aria-current="page"' : ''}><span>${icon(key)}</span>${label}</a>`).join('')}</nav>`;
  return document({
    m, brand, title,
    body: `${bar}${nav}<main>${body}${storeBadges(m, brand)}</main>`,
    script: OPENED_FROM_NOTIFICATION + script,
  });
}

const say = (text, bad = false) => (text ? `<p class="say${bad ? ' bad' : ''}" role="${bad ? 'alert' : 'status'}">${esc(text)}</p>` : '');
const row = (ico, title, sub, { value = '', cls = '' } = {}) =>
  `<div class="row${cls ? ` ${cls}` : ''}">${icon(ico)}<div class="t"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>${value ? `<div class="v">${value}</div>` : ''}</div>`;
/** A row that opens to show a form: the page's version of the app's dialogs. */
const opener = (ico, title, sub, inner, { open = false, cls = '', id = '' } = {}) =>
  `<details class="more"${open ? ' open' : ''}${id ? ` id="${id}"` : ''}><summary class="row${cls ? ` ${cls}` : ''}">${icon(ico)}<div class="t"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>${icon('chev', 'ico chev')}</summary><div class="body">${inner}</div></details>`;
const powered = '<p class="powered">Powered by Vesopa</p>';

/**
 * The venue's own phone app, as the official App Store and Google Play badges
 * (public/assets/badges), for a venue whose look names its store links. An
 * iPhone or iPad is shown only the App Store, an Android phone only Google
 * Play, a computer both. Nothing inside the app itself.
 */
function storeBadges(m, brand) {
  const look = venueLooks.lookFor(brand.slug);
  if (!look || (!look.ios_app && !look.android_app)) return '';
  const ua = (m && m.ua) || '';
  if (/VesopaLoyalty/.test(ua)) return '';
  const ios = /iPhone|iPad|iPod/.test(ua);
  const android = /Android/.test(ua);
  const badges = [];
  if (look.ios_app && !android) badges.push(`<a class="store" href="${esc(look.ios_app)}" rel="noopener"><img src="/assets/badges/app-store.svg" alt="Download on the App Store" width="120" height="40"></a>`);
  if (look.android_app && !ios) badges.push(`<a class="store" href="${esc(look.android_app)}" rel="noopener"><img src="/assets/badges/google-play.png" alt="Get it on Google Play" width="135" height="40"></a>`);
  if (!badges.length) return '';
  return `<section class="get-app" aria-label="Get the app"><p>Get the ${esc(brand.name)} app</p><div>${badges.join('')}</div></section>`;
}

// ---------------------------------------------------------------------------
// Signing in (sign_in.dart)
// ---------------------------------------------------------------------------

const LABEL = {
  password: 'Use a password', passkey: 'Use a passkey', code_sms: 'Text me a code',
  vesopa: 'Continue with Vesopa', code_email: 'Email me a code',
};

/** What the venue offers, which leads and which are underneath (SignInConfig). */
function config(signin) {
  const offered = new Set((signin && signin.methods && signin.methods.length) ? signin.methods : ['code_email']);
  const has = (x) => offered.has(x);
  const policy = (signin && signin.policy) || 'code_first';
  const leads = policy === 'password_first' && has('password') ? 'password'
    : policy === 'vesopa_first' && has('vesopa') ? 'vesopa' : 'code_email';
  const order = ['vesopa', 'passkey', 'password', 'code_sms', 'code_email'];
  return { offered, has, leads, order };
}

function signIn({ m, brand, ua, state }) {
  const c = config(brand.signin);
  const method = state.method && (c.has(state.method) || state.method === c.leads) ? state.method : c.leads;
  const stage = state.stage || 'start';
  const action = (step) => esc(`${m.base}signin/${step}`);
  const field = (name, label, attrs) => `<label class="field"><span>${label}</span><input name="${name}" ${attrs}></label>`;
  let form = '';

  if (stage === 'code' || stage === 'name') {
    const sms = method === 'code_sms';
    form = `<form method="post" action="${action(sms ? 'sms-verify' : 'verify')}">${hidden(m)}`
      + (sms ? `<input type="hidden" name="phone" value="${esc(state.phone)}">` : `<input type="hidden" name="email" value="${esc(state.email)}">`)
      + `<input type="hidden" name="stage" value="${stage}">`
      + field('code', sms ? 'Code' : 'Six-digit code', `class="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${sms ? 8 : 6}" autocomplete="one-time-code" required value="${esc(state.code)}"${stage === 'code' ? ' autofocus' : ''}`)
      + (stage === 'name' ? field('name', 'Your name', `type="text" autocomplete="name" autocapitalize="words" required autofocus value="${esc(state.name)}"`) : '')
      + `<button class="btn">${stage === 'name' ? 'Join' : 'Sign in'}</button></form>`
      + `<a class="link" href="${esc(`${m.base}?with=${method}`)}">Start again</a>`;
  } else if (method === 'code_sms') {
    form = `<form method="post" action="${action('sms')}">${hidden(m)}`
      + field('phone', 'Mobile number', `type="tel" autocomplete="tel" placeholder="07…" required autofocus value="${esc(state.phone)}"`)
      + '<button class="btn">Text me a code</button></form>';
  } else if (method === 'vesopa') {
    form = '<p>Sign in with the Vesopa account this venue gave you.</p>'
      + `<a class="btn" href="${esc(m.base)}vesopa">Continue with Vesopa</a>`;
  } else if (method === 'password') {
    form = `<form method="post" action="${action('password')}">${hidden(m)}`
      + field('email', 'Email address', `type="email" autocomplete="username" required autofocus value="${esc(state.email)}"`)
      + field('password', 'Password', 'type="password" autocomplete="current-password" required')
      + '<button class="btn">Sign in</button></form>';
  } else if (method === 'passkey') {
    form = field('email', 'Email address', `type="email" autocomplete="username webauthn" value="${esc(state.email)}"`).replace('</label>', '<small>Optional — your device may already know you.</small></label>')
      + '<button class="btn" type="button" data-passkey>Use a passkey</button>';
  } else {
    form = `<form method="post" action="${action('code')}">${hidden(m)}`
      + field('email', 'Email address', `type="email" autocomplete="email" required autofocus value="${esc(state.email)}"`)
      + '<button class="btn">Email me a code</button></form>';
  }

  /*
   * THE OTHER WAYS IN. The ones that need nothing typed are buttons with their
   * own mark and go on one tap; through Vesopa come Apple, Google, a passkey
   * and the phone, each straight there. The ones that need a form are links.
   */
  let others = '';
  if (stage === 'start') {
    const rest = [...c.offered].filter((x) => x !== method).sort((a, b) => c.order.indexOf(a) - c.order.indexOf(b));
    const links = rest.filter((x) => x !== 'vesopa' && x !== 'passkey');
    const viaVesopa = c.has('vesopa');
    const apple = /iPhone|iPad|iPod|Macintosh/.test(ua);
    const go = (idp) => esc(`${m.base}vesopa?idp=${idp}`);
    const ways = [];
    const appleWay = `<a class="way apple" href="${go('apple')}">${APPLE}Continue with Apple</a>`;
    const googleWay = `<a class="way" href="${go('google')}">${GOOGLE}Continue with Google</a>`;
    if (viaVesopa && apple) ways.push(appleWay);
    if (viaVesopa) ways.push(googleWay);
    if (viaVesopa && !apple) ways.push(appleWay);
    // The venue's own passkey needs this browser's script; Vesopa's is a page.
    if (rest.includes('passkey')) ways.push(`<button class="way" type="button" data-passkey hidden>${icon('fingerprint')}Use a passkey</button>`);
    else if (viaVesopa) ways.push(`<a class="way" href="${go('passkey')}">${icon('fingerprint')}Use a passkey</a>`);
    if (viaVesopa && !c.has('code_sms')) ways.push(`<a class="way" href="${go('phone')}">${icon('mobile')}Continue with your phone</a>`);
    if (ways.length || links.length) {
      others = '<div class="or">or</div>' + ways.join('')
        + (links.length ? `<div class="ways">${links.map((x) => `<a class="link" href="${esc(`${m.base}?with=${x}`)}">${LABEL[x]}</a>`).join('')}</div>` : '');
    }
  }

  const usesPasskey = /data-passkey/.test(form + others);
  const body = '<main class="gate club"><div class="in">'
    + logo(brand, 96)
    + `<h1>${esc(brand.name)}</h1><p class="welcome">${esc(brand.welcome)}</p>`
    + (state.note ? `<p class="note" role="status">${esc(state.note)}</p>` : '')
    + form
    + (state.error ? `<p class="err" role="alert">${esc(state.error)}</p>` : '')
    + (usesPasskey ? `<p class="err" role="alert" data-passkey-error hidden></p><form method="post" action="${action('passkey')}" data-passkey-form hidden>${hidden(m)}<input type="hidden" name="proof"></form>` : '')
    + others
    + storeBadges(m, brand)
    + powered
    + '</div></main>';
  return document({
    m, brand, title: 'Sign in', bodyClass: 'signin', body,
    script: OPENED_FROM_NOTIFICATION + (usesPasskey ? passkeySignInScript(m) : ''),
  });
}

/** Base64url to bytes and back, for WebAuthn. */
const B64 = "function b2u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var r=atob(s),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o.buffer}"
  + "function u2b(b){var s='',u=new Uint8Array(b);for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}"
  + 'var canPasskey=!!(window.PublicKeyCredential&&navigator.credentials&&window.isSecureContext);';

/** The passkey button: the options from the API, the browser's prompt, the answer posted back. */
function passkeySignInScript(m) {
  return B64
    + "var pk=document.querySelectorAll('[data-passkey]'),pf=document.querySelector('[data-passkey-form]'),pe=document.querySelector('[data-passkey-error]');"
    + 'if(canPasskey)pk.forEach(function(b){b.hidden=false;b.addEventListener("click",go)});'
    + 'async function go(){pe.hidden=true;try{'
    + "var e=document.querySelector('input[name=email]'),email=e&&/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(e.value)?e.value:null;"
    + `var r=await fetch(${JSON.stringify(`/loyalty/v1/app/${encodeURIComponent(m.slug)}/passkey/options`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(email?{email:email}:{})});`
    + 'var o=await r.json();if(!r.ok)throw new Error(o.error);var ch=o.challenge;o.challenge=b2u(o.challenge);'
    + '(o.allowCredentials||[]).forEach(function(c){c.id=b2u(c.id)});'
    + 'var c=await navigator.credentials.get({publicKey:o});if(!c)return;'
    + 'pf.elements.proof.value=JSON.stringify({challenge:ch,credential:{id:c.id,rawId:u2b(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),'
    + 'response:{clientDataJSON:u2b(c.response.clientDataJSON),authenticatorData:u2b(c.response.authenticatorData),signature:u2b(c.response.signature),userHandle:c.response.userHandle?u2b(c.response.userHandle):null}}});'
    + 'pf.submit()}catch(x){if(x&&(x.name==="NotAllowedError"||x.name==="AbortError"))return;pe.textContent=(x&&x.message)||"That did not work. Please try again.";pe.hidden=false}}';
}

// ---------------------------------------------------------------------------
// The card (card_page.dart)
// ---------------------------------------------------------------------------

/** The card number in fours: read aloud it goes wrong at about the sixth digit. */
const grouped = (v) => String(v).replace(/\s/g, '').replace(/(.{4})(?=.)/g, '$1 ');

function card({ m, brand, unread, classes, me, ua }) {
  const on = onColour(clubOf(brand).club);
  const points = Number(me.points) || 0;
  const worth = Number(me.points_value_minor) || 0;
  const minRedeem = Number(brand.points && brand.points.min_redeem) || 0;
  const scheme = me.scheme || null;
  const number = me.member_number ? `Member ${me.member_number}` : (me.card_number || (me.member_no != null ? `Member ${me.member_no}` : ''));
  const schemeColour = scheme && HEX.test(scheme.colour || '') ? scheme.colour : clubOf(brand).glow;
  const short = minRedeem > points ? minRedeem - points : 0;

  const front = `<div class="face front club"><div class="who"><h2>${esc(me.name)}</h2>`
    + (scheme && scheme.name ? `<span class="chip" style="background:${schemeColour};color:${onColour(schemeColour)};border:1px solid rgba(255,255,255,.6)">${esc(scheme.name)}</span>` : '')
    + (me.tier ? `<span class="chip" style="background:${clubOf(brand).glow};color:${onColour(clubOf(brand).glow)}">${esc(me.tier)}</span>` : '')
    + `</div><div class="qr" role="img" aria-label="Your membership QR code">${QR.svg(String(me.qr || ''), { size: 210 })}</div>`
    + `<div class="num">${esc(number)}</div><div class="till">Show this at the till</div>`
    + `<div class="pts"><b>${points}</b><span>${points === 1 ? 'point' : 'points'}</span></div>`
    + (points > 0 ? `<div class="worth">worth ${money(worth)}</div>` : '')
    + `<div class="flipnote">${icon('flip')}Tap the card to turn it over</div></div>`;

  const backRow = (label, value) => `<div class="r"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  const back = '<div class="face back club"><h2>Your card</h2>'
    + (me.card_number ? `<div class="lbl">Card number</div><div class="cardno">${esc(grouped(me.card_number))}</div>` : '')
    + (me.member_number ? backRow('Member number', me.member_number) : '')
    + (scheme && scheme.name ? backRow('Scheme', scheme.name) : '')
    + (scheme && scheme.summary ? backRow('Your rewards', scheme.summary) : '')
    + backRow('Points', String(points)) + backRow('Worth', money(worth))
    + (minRedeem > 0 ? backRow('Spend from', `${minRedeem} points`) : '')
    + (short > 0 ? `<div class="tip">${short} more point${short === 1 ? '' : 's'} and you can start spending them.</div>`
      : minRedeem > 0 ? '<div class="tip">You have enough to spend. Just say so at the till.</div>' : '')
    + (me.member_since ? `<div class="since">Member since ${esc(when(me.member_since, { time: false }))}</div>` : '')
    + `<div class="flipnote">${icon('flip')}Tap to go back to your code</div></div>`;

  // The card turns over with no script: a checkbox and its label.
  const turn = `<div class="cardbox"><input type="checkbox" id="turn" class="sr" aria-label="Turn the card over"><label for="turn" class="turn" style="color:${on}">${front}${back}</label></div>`;

  const wallet = [];
  if (/iPhone|iPad|iPod/.test(ua)) wallet.push(`<a href="${esc(m.base)}wallet/apple">${APPLE.replace('<svg ', '<svg width="20" height="20" ')}Add to Apple Wallet</a>`);
  if (/Android/.test(ua)) wallet.push(`<a href="${esc(m.base)}wallet/google">${GOOGLE.replace('<svg ', '<svg width="18" height="18" ')}Add to Google Wallet</a>`);

  const membership = me.membership || {};
  const expiry = membership.expiry || me.membership_expiry;
  const facts = [
    me.last_visit ? row('history', 'Last visit', '', { value: esc(when(me.last_visit, { time: false })) }) : '',
    me.member_since ? row('badge', 'Member since', '', { value: esc(when(me.member_since, { time: false })) }) : '',
    expiry ? row(membership.expired ? 'busy' : 'repeat', membership.expired ? 'Membership ran out' : 'Membership until', '', { value: esc(when(expiry, { time: false })) }) : '',
    minRedeem > 0 ? row('gift', 'Spend points from', '', { value: `${minRedeem} points` }) : '',
  ].join('');

  const hour = Number(local(new Date()).h);
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = String(me.name || '').trim().split(/\s+/)[0];
  const side = '<div class="side">'
    + `<div class="hello"><h1>${esc(first ? `${hello}, ${first}` : hello)}</h1><p>${esc(brand.welcome || brand.name)}</p></div>`
    + `<div class="tiles"><div class="tile">${icon('star')}<b>${points}</b><span>Points</span></div><div class="tile">${icon('repeat')}<b>${Number(me.visits) || 0}</b><span>Visits</span></div></div>`
    + (facts ? `<div class="panel facts">${facts}</div>` : '')
    + '</div>';

  return signedIn({
    m, brand, unread, classes, tab: 'card', title: 'Card',
    body: `<div class="home">${turn}${wallet.length ? `<div class="wallet">${wallet.join('')}</div>` : ''}${side}</div>`,
    script: nearbyRefreshScript(brand),
  });
}

/** Nearby offers, when this browser said yes: where the member is, on opening the card. */
function nearbyRefreshScript(brand) {
  if (!brand.location) return '';
  return "try{var k='nearby:'+document.body.dataset.base,t=Number(localStorage.getItem(k)||0);"
    + 'if(t&&Date.now()-t>36e5&&navigator.geolocation)navigator.geolocation.getCurrentPosition(function(p){'
    + "fetch(document.body.dataset.base+'venue/nearby',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':document.body.dataset.csrf},"
    + 'body:JSON.stringify({latitude:p.coords.latitude,longitude:p.coords.longitude})}).then(function(){localStorage.setItem(k,String(Date.now()))})},function(){},{maximumAge:6e5,timeout:1e4})}catch(e){}';
}

// ---------------------------------------------------------------------------
// Activity (history_page.dart)
// ---------------------------------------------------------------------------

const KIND = {
  earn: 'Points earned', redeem: 'Points spent', expire: 'Points expired',
  adjust: 'Adjusted by the venue', bonus: 'Bonus points', join: 'Welcome bonus',
};

function activity({ m, brand, unread, classes, history, error, paged }) {
  const items = (history && history.items) || [];
  let body;
  if (error) body = say(error, true);
  else if (!items.length) body = `<p class="empty">${paged ? 'Nothing older.' : 'Nothing yet. Your points will show here after your first visit.'}</p>`;
  else {
    body = `<ul class="list narrow">${items.map((t) => {
      const points = Number(t.points) || 0;
      const spend = Number(t.spend_minor) || 0;
      const value = Number(t.value_minor) || 0;
      const negative = points < 0 || t.kind === 'redeem' || t.kind === 'expire';
      const note = String(t.note || '').trim();
      const line = [when(t.created_at), spend > 0 ? `spent ${money(spend)}` : '', t.kind === 'redeem' && value > 0 ? `saved ${money(value)}` : '', note]
        .filter(Boolean).join(' · ');
      const rate = t.kind === 'earn' && spend > 0 && points > 0 ? points / (spend / 100) : null;
      const rows = [
        ['When', when(t.created_at)],
        spend > 0 ? ['You spent', money(spend)] : null,
        t.kind === 'redeem' && value > 0 ? ['You saved', money(value)] : null,
        rate != null ? ['Rate', `${rate.toFixed(points % spend === 0 ? 0 : 1)} points per £`] : null,
        t.balance_after != null ? ['Balance after', `${t.balance_after} points`] : null,
        note ? ['Where', note] : null,
      ].filter(Boolean);
      return `<li><details class="txn ${negative ? 'minus' : 'plus'}"><summary><span class="dot">${icon(negative ? 'minus' : 'plus')}</span>`
        + `<span class="t">${esc(KIND[t.kind] || 'Points')}<small>${esc(line)}</small></span>`
        + `<span class="n">${negative ? '-' : '+'}${Math.abs(points)}</span>${icon('chev', 'ico chev')}</summary>`
        + `<div class="body">${rows.map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}`
        + '<p class="hint">Anything here look wrong? The venue can check it against the till.</p></div></details></li>';
    }).join('')}</ul>`;
    if (history.more) {
      const last = items[items.length - 1];
      body += `<div class="more-btn"><a class="btn line" href="${esc(`${m.base}activity?before=${encodeURIComponent(new Date(last.created_at).toISOString())}`)}">Show older</a></div>`;
    }
  }
  return signedIn({ m, brand, unread, classes, tab: 'activity', title: 'Activity', body });
}

// ---------------------------------------------------------------------------
// News (inbox_page.dart)
// ---------------------------------------------------------------------------

const videoOf = (x) => String(x.video_embed_url || '').trim() || String(x.video_url || '').trim() || null;

function news({ m, brand, unread, classes, inbox, before, error }) {
  const items = (inbox && inbox.items) || [];
  let body = '<h1 class="sr">News</h1>';
  if (error) body += say(error, true);
  else if (!items.length) body += `<p class="empty">${before ? 'Nothing older.' : 'No news yet. Offers and news from the venue will appear here.'}</p>`;
  else {
    const ctx = before ? `?b=${encodeURIComponent(before)}` : '';
    body += `<div class="news">${items.map((x) => {
      const image = String(x.image_url || '').trim();
      const video = videoOf(x);
      const play = video ? `<span class="play"><i>${PLAY}</i></span>` : '';
      const pic = image ? `<div class="pic"><img src="${esc(image)}" alt="" loading="lazy">${play}</div>` : video ? `<div class="pic">${play}</div>` : '';
      return `<a class="story${x.read_at ? '' : ' unread'}" href="${esc(`${m.base}news/${encodeURIComponent(x.id)}${ctx}`)}">${pic}`
        + `<div class="txt"><h2>${esc(x.title)}</h2><p>${esc(x.body)}</p><small>${esc(when(x.sent_at, { time: false }))}</small></div></a>`;
    }).join('')}</div>`;
    if (inbox.mode === 'limit' && items.length >= (Number(inbox.limit) || 12)) {
      body += `<p class="hint" style="text-align:center">The newest ${items.length} are kept here.</p>`;
    }
    if (inbox.more) {
      const last = items[items.length - 1];
      const at = last.shown_at || last.sent_at;
      body += `<div class="more-btn"><a class="btn line" href="${esc(`${m.base}news?before=${encodeURIComponent(new Date(at).toISOString())}`)}">Show older</a></div>`;
    }
  }
  return signedIn({ m, brand, unread, classes, tab: null, title: 'News', body });
}

function message({ m, brand, unread, classes, message: x }) {
  const image = String(x.image_url || '').trim();
  const link = String(x.link_url || '').trim();
  const video = videoOf(x);
  const safe = (u) => (/^https?:\/\//i.test(u) ? u : null);
  const body = `<article class="msg"><a class="back-link" href="${esc(m.base)}news">${icon('back')}News</a>`
    + (image ? `<img src="${esc(image)}" alt="">` : '')
    + `<h1>${esc(x.title)}</h1><small>${esc(when(x.sent_at))}</small><p class="text">${esc(x.body)}</p>`
    + `<div class="actions">${video && safe(video) ? `<a class="btn" href="${esc(video)}" target="_blank" rel="noopener">Watch the video</a>` : ''}`
    + `${link && safe(link) ? `<a class="btn line" href="${esc(link)}" target="_blank" rel="noopener">${icon('external')}Find out more</a>` : ''}</div></article>`;
  return signedIn({ m, brand, unread, classes, tab: null, title: x.title || 'News', body });
}

// ---------------------------------------------------------------------------
// Classes (classes_page.dart)
// ---------------------------------------------------------------------------

const DONE_CLASSES = {
  booked: 'Booked. See you there.', waitlist: 'The class is full, so you are on the waiting list.',
  cancelled: 'Booking cancelled.', left: 'You have left the waiting list.',
};

/** 'YYYY-MM-DDTHH:mm', the venue's own clock: read as written. */
function classTime(v) {
  const x = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v || ''));
  return x ? { day: `${x[1]}-${x[2]}-${x[3]}`, clock: `${x[4]}:${x[5]}`, key: `${x[1]}${x[2]}${x[3]}${x[4]}${x[5]}` } : null;
}

function classes({ m, brand, unread, classes: hasClasses, list, error, done }) {
  const now = local(new Date());
  const nowKey = `${now.y}${String(now.mo).padStart(2, '0')}${String(now.d).padStart(2, '0')}${now.h}${now.mi}`;
  const days = new Map();
  for (const c of list || []) {
    const start = classTime(c.starts_at);
    if (!start) continue;
    const end = classTime(c.ends_at) || start;
    if (end.key < nowKey) continue;
    const mine = c.my_status;
    if (c.cancelled && (!mine || mine === 'cancelled')) continue;
    if (!days.has(start.day)) days.set(start.day, []);
    days.get(start.day).push({ c, start, end: classTime(c.ends_at) });
  }
  const title = (day) => {
    const [y, mo, d] = day.split('-').map(Number);
    const diff = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(now.y, now.mo - 1, now.d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return `${DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MONTHS[mo - 1]}`;
  };
  let body = `<div class="narrow">${say(DONE_CLASSES[done])}${say(error, true)}`;
  if (!days.size) body += '<p class="empty">No classes in the next two weeks.</p>';
  for (const day of [...days.keys()].sort()) {
    body += `<h2 class="day">${esc(title(day))}</h2>`;
    for (const { c, start, end } of days.get(day).sort((a, b) => (a.start.key < b.start.key ? -1 : 1))) {
      const mine = c.my_status || null;
      const spaces = Number(c.spaces) || 0;
      const waiting = Number(c.waiting) || 0;
      const started = start.key <= nowKey;
      const status = c.cancelled ? `Cancelled by the venue${c.note ? `: ${c.note}` : ''}`
        : mine === 'attended' ? 'You were here'
          : mine === 'booked' ? 'You are booked'
            : mine === 'waitlist' ? 'You are on the waiting list'
              : spaces > 0 ? `${plural(spaces, 'place')} left`
                : `Full${waiting > 0 ? `, ${waiting} waiting` : ''}`;
      const details = [`${start.clock}${end ? `-${end.clock}` : ''}`, c.instructor || '', c.room || ''].filter(Boolean).join(' · ');
      let act = '';
      if (!c.cancelled && !started) {
        if (mine === 'booked' || mine === 'waitlist') {
          act = button(m, `classes/${encodeURIComponent(c.id)}/cancel`, mine === 'waitlist' ? 'Leave' : 'Cancel', {
            cls: 'btn line small', fields: `<input type="hidden" name="was" value="${mine}">`,
          });
        } else if (!mine || mine === 'cancelled') {
          act = button(m, `classes/${encodeURIComponent(c.id)}/book`, spaces > 0 ? 'Book' : 'Waitlist', { cls: 'btn small' });
        }
      }
      const colour = HEX.test(c.colour || '') ? c.colour : 'var(--primary)';
      body += `<div class="class${mine === 'booked' || mine === 'waitlist' || mine === 'attended' ? ' mine' : ''}"><span class="stripe" style="background:${colour}"></span>`
        + `<div class="t${c.cancelled ? ' off' : ''}"><b>${esc(c.name || 'Class')}</b><small>${esc(details)}\n${esc(status)}</small></div>${act}</div>`;
    }
  }
  body += `${powered}</div>`;
  return signedIn({ m, brand, unread, classes: hasClasses, tab: 'classes', title: 'Classes', body });
}

// ---------------------------------------------------------------------------
// The account (account_page.dart, membership_section.dart)
// ---------------------------------------------------------------------------

const MEMBERSHIP_STATE = {
  active: 'verified', frozen: 'snow', pending: 'hourglass', expired: 'busy', cancelled: 'busy',
};

function membershipStateText(x) {
  const expiry = x.expiry;
  const left = Number(x.days_left);
  switch (x.state) {
    case 'active':
      if (!expiry) return 'Active';
      return `Active until ${when(expiry, { time: false })}${Number.isFinite(left) && left >= 0 && left <= 31 ? ` (${left === 0 ? 'last day' : `${plural(left, 'day')} left`})` : ''}`;
    case 'frozen': return x.frozen_until ? `Frozen until ${when(x.frozen_until, { time: false })}` : 'Frozen';
    case 'expired': return expiry ? `Expired on ${when(expiry, { time: false })}` : 'Expired';
    case 'pending': return 'Waiting for the venue to approve';
    case 'cancelled': return 'Cancelled';
    default: return 'Not a member yet';
  }
}

/** What renewing at the till means, said plainly rather than pretending to take a card. */
function tillRenewText({ fee, term, renewal, expired }) {
  const until = renewal ? `to ${when(renewal, { time: false })}` : term > 0 ? `for another ${plural(term, 'month')}` : '';
  return `${fee > 0 ? `It costs ${money(fee)}, ` : ''}paid at the till. Show your card and ask to renew; your membership then runs ${until} `
    + `and your points ${expired ? 'can be spent again' : 'carry on as they are'}.`;
}

function membershipPanel(m, member, me, payment) {
  if (member) {
    const x = member;
    const state = x.state || 'none';
    const plan = x.plan || null;
    const payer = x.payer !== false;
    const online = x.can_pay_online === true;
    const renewMinor = x.renew_minor != null ? Number(x.renew_minor) : null;
    const family = x.family || [];
    const forSale = x.plans_for_sale || [];
    const canRenew = payer && plan && ['active', 'frozen', 'expired'].includes(state);
    const planName = plan ? String(plan.name || '') : '';
    const bad = state === 'expired' || state === 'cancelled';
    const pay = (kind, amount, title, breakdown, schemeId, sub = '') => opener(kind === 'join' ? 'gift' : 'renew', esc(title), sub,
      `<p>${esc(breakdown)}.</p><p class="hint">You pay on Dojo's secure payment page. Come back here when you have paid and your membership will update.</p>`
      + button(m, 'account/pay', `Pay ${money(amount)}`, { fields: `<input type="hidden" name="kind" value="${kind}">${schemeId != null ? `<input type="hidden" name="scheme_id" value="${esc(schemeId)}">` : ''}` }));
    let html = row(MEMBERSHIP_STATE[state] || 'badge', esc(plan ? planName : 'No membership'), esc(membershipStateText(x)), { cls: bad ? 'bad' : '' });
    if (state === 'active' && x.frozen_from && x.frozen_until) html += row('snow', 'Freeze booked', esc(`${when(x.frozen_from, { time: false })} to ${when(x.frozen_until, { time: false })}`));
    if (x.member_number != null) html += row('badge', 'Member number', esc(x.member_number));
    if (x.joined_on && state !== 'none') html += row('history', 'Joined', esc(when(x.joined_on, { time: false })));
    if (family.length > 1) {
      html += row('family', 'Family on this membership', family.map((f) => esc(`${f.name || 'Member'}${f.payer ? ' (pays)' : ''}${f.state && f.state !== state ? ` - ${f.state}` : ''}`)).join('<br>'));
    }
    if (!payer && state !== 'none') html += row('info', 'Paid by the head of your family plan', '');
    if (payment) {
      html += row('hourglass', 'Payment started', 'Paid already? Check it to update your membership.')
        + `<div class="actions">${button(m, 'account/pay-check', 'Check payment', { cls: 'btn tonal small' })}${button(m, 'account/pay-forget', 'I did not pay', { cls: 'link' })}</div>`;
    }
    if (canRenew && !payment) {
      if (online && renewMinor != null && renewMinor >= 50) {
        html += pay('renew', renewMinor, `${state === 'expired' ? 'Renew' : 'Renew early'} for ${money(renewMinor)}`, money(renewMinor));
      } else {
        html += opener('renew', state === 'expired' ? 'Renew my membership' : 'How to renew', '',
          `<p>${esc(tillRenewText({ fee: renewMinor || 0, term: Number(plan.term_months) || 0, renewal: plan.season_ends, expired: state === 'expired' }))}</p>`);
      }
    }
    if (forSale.length && payer && !payment) {
      html += `<h3 class="day" style="font-size:.95rem;margin:10px 0 4px">${state === 'expired' ? 'Or choose another plan' : 'Join'}</h3>`;
      for (const p of forSale) {
        const fee = Number(p.fee_minor) || 0;
        const joining = Number(p.joining_fee_minor) || 0;
        const amount = p.join_minor != null ? Number(p.join_minor) : fee + joining;
        const term = Number(p.term_months) || 0;
        const lines = [
          `${money(fee)}${term > 0 ? ` for ${plural(term, 'month')}` : ''}${joining > 0 ? ` + ${money(joining)} joining fee` : ''}`,
          p.includes_classes ? 'Includes classes' : '',
          p.description || '',
        ].filter(Boolean).map(esc).join('<br>');
        html += online && amount >= 50
          ? pay('join', amount, `${p.name}`, joining > 0 ? `${money(fee)} membership + ${money(joining)} joining fee = ${money(amount)}` : money(amount), p.id, lines)
          : row('gift', esc(p.name), lines);
      }
      if (!online) html += '<p class="hint">Ask at the venue to join.</p>';
    }
    return `<section class="panel"><h2>Membership</h2>${html}</section>`;
  }

  // A venue that does not run memberships: what /me says about the card.
  const x = me.membership || {};
  const expiry = x.expiry || me.membership_expiry;
  const expired = x.expired === true;
  const term = Number(x.term_months) || 0;
  const fee = Number(x.fee_minor) || 0;
  const paid = fee > 0 || term > 0;
  if (!expiry && !paid) return '';
  const howLong = x.renewal_date ? `Memberships run to ${when(x.renewal_date, { time: false })} each year.`
    : term > 0 ? `A membership lasts ${plural(term, 'month')}.` : '';
  let html = expiry
    ? row(expired ? 'busy' : 'repeat', expired ? 'Ran out' : 'Runs until', esc(when(expiry, { time: false })), { cls: expired ? 'bad' : '' })
    : row('repeat', 'No end date on your membership', '');
  if (paid) html += row('renew', fee > 0 ? `Renewing costs ${money(fee)}` : 'Renewing', esc(howLong));
  html += opener('renew', expired ? 'Renew my membership' : expiry ? 'Renew early' : 'How to renew', '',
    `<p>${esc(tillRenewText({ fee, term, renewal: x.renewal_date, expired }))}</p>`);
  return `<section class="panel"><h2>Membership</h2>${html}</section>`;
}

const PLATFORM = { web: 'Web browser', windows: 'Windows app', android: 'Android', ios: 'iPhone or iPad' };

function account({ m, brand, unread, classes: hasClasses, member, account: a, me, deletion, payment, state }) {
  const canEdit = a.can_edit !== false;
  const methods = a.methods || [];
  const name = String(me.name || a.name || '').trim();
  const initials = name ? name.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') : '?';
  const photo = me.photo_url
    ? `<img class="avatar" src="${esc(me.photo_url)}" alt="">`
    : `<span class="avatar">${esc(initials)}</span>`;

  // ---- You
  const upload = `<form method="post" enctype="multipart/form-data" action="${esc(`${m.base}account/photo?_csrf=${encodeURIComponent(m.csrf)}`)}">`
    + '<label class="field"><span>Choose a photograph</span><input type="file" name="image" accept="image/jpeg,image/png,image/webp" required></label>'
    + '<button class="btn small">Upload</button></form>'
    + (me.photo_url ? `<p class="hint">Your card will show your initials instead if you remove it.</p>${button(m, 'account/photo-remove', 'Remove', { cls: 'btn line small' })}` : '');
  let you = `<details class="more"><summary class="row">${photo}<div class="t"><b>Your photo</b><small>${me.photo_url ? 'Shown on your card at the till' : 'Add one so the venue knows it is you'}</small></div>${icon('chev', 'ico chev')}</summary><div class="body">${upload}</div></details>`;
  you += canEdit
    ? opener('badge', 'Name', esc(a.name), `<form method="post" action="${esc(m.base)}account/name">${hidden(m)}<label class="field"><span>Your name</span><input type="text" name="name" autocomplete="name" required value="${esc(a.name)}"></label><button class="btn small">Save</button></form>`)
    : row('badge', 'Name', esc(a.name));
  // Not editable here: an email address IS the way back into the membership.
  you += row('mail', 'Email address', esc(a.email), { value: `<span title="Ask at the venue to change this">${icon('lock')}</span>` });
  const phoneText = !a.phone ? 'Not added' : a.phone_verified ? `${a.phone} · confirmed` : `${a.phone} · not confirmed yet`;
  if (canEdit && a.phone_verified) {
    you += opener('mobile', 'Mobile number', esc(phoneText), button(m, 'account/phone-remove', 'Remove', { cls: 'btn line small' }));
  } else if (canEdit) {
    const sent = !!state.phone;
    const inner = sent
      ? `<form method="post" action="${esc(m.base)}account/phone-verify">${hidden(m)}<input type="hidden" name="phone" value="${esc(state.phone)}">`
        + `<p class="hint">Enter the code we texted to ${esc(state.phone)}.</p><label class="field"><span>Code from the text</span><input class="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label><button class="btn small">Confirm</button></form>`
      : `<form method="post" action="${esc(m.base)}account/phone">${hidden(m)}<label class="field"><span>Mobile number</span><input type="tel" name="phone" autocomplete="tel" placeholder="07…" required></label><button class="btn small">Text me a code</button></form>`;
    you += opener('mobile', 'Mobile number', esc(phoneText), inner, { open: sent, id: 'phone' });
  } else {
    you += row('mobile', 'Mobile number', esc(phoneText));
  }
  if (a.vesopa_linked) you += row('verified', 'Vesopa account', 'Connected');

  // ---- Signing in
  const offersPassword = methods.includes('password');
  const offersPasskey = methods.includes('passkey');
  const passkeys = a.passkeys || [];
  let security = '';
  if (offersPassword) {
    const form = `<form method="post" action="${esc(m.base)}account/password">${hidden(m)}`
      + (a.has_password ? '<label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>' : '')
      + '<label class="field"><span>New password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required><small>At least 8 characters. A phrase you will remember beats a short muddle.</small></label>'
      + '<button class="btn small">Save</button></form>';
    security += canEdit
      ? opener('lock', 'Password', a.has_password ? 'Set' : 'Not set — you sign in with a code', form)
      : row('lock', 'Password', a.has_password ? 'Set' : 'Not set — you sign in with a code');
  }
  if (offersPasskey) {
    for (const k of passkeys) {
      const sub = k.last_used_at ? `Last used ${when(k.last_used_at, { time: false })}` : `Added ${when(k.created_at, { time: false })}`;
      security += row('fingerprint', esc(k.name || 'Passkey'), esc(sub), {
        value: canEdit ? button(m, 'account/passkey-remove', 'Remove', { cls: 'link', fields: `<input type="hidden" name="id" value="${esc(k.id)}">` }) : '',
      });
    }
    if (canEdit) {
      security += `<button type="button" class="row link" data-add-passkey hidden style="width:100%;text-decoration:none;color:inherit;text-align:left">${icon('fingerprint')}<span class="t"><b>Add a passkey</b><small>Sign in with your face, fingerprint or device PIN.</small></span>${icon('chev')}</button>`
        + `<p class="say bad" data-passkey-error hidden></p><form method="post" action="${esc(m.base)}account/passkey" data-passkey-form hidden>${hidden(m)}<input type="hidden" name="proof"></form>`
        + `<noscript>${row('info', 'Passkeys', 'Switch on JavaScript in this browser to add one.')}</noscript>`;
    }
  }

  // ---- Where you are signed in
  const devices = a.devices || [];
  const devicesHtml = devices.map((d) => row(d.current ? 'check' : 'devices', esc(PLATFORM[d.platform] || 'Device'),
    esc(d.current ? 'This device' : `Last used ${when(d.last_seen_at, { time: false })}`))).join('')
    + (devices.length > 1 ? `<div class="actions">${button(m, 'account/others', `${icon('logout')}Sign out everywhere else`, { cls: 'btn line small' })}</div>` : '');

  // ---- This device
  const leave = `<form method="post" action="${esc(m.base)}signout">${hidden(m)}<button class="row link" style="width:100%;text-decoration:none;color:inherit;text-align:left">${icon('logout')}<span class="t"><b>Sign out</b></span></button></form>`
    + opener('trash', 'Remove the app from my membership', '',
      '<p>Every device you signed in on is signed out, notifications stop and nearby offers are switched off. Your membership and points stay with the venue.</p>'
      + button(m, 'leave', 'Remove', { cls: 'btn bad small' }), { cls: 'bad' });

  // ---- Your data
  const request = deletion && deletion.request;
  const choices = (deletion && deletion.day_choices) || [7, 15, 30];
  const manage = `https://auth.vesopa.com/delete-account/${encodeURIComponent(m.slug)}`;
  const data = request
    ? `<a class="row bad" href="${esc(/^https:\/\//.test(request.manage_url || '') ? request.manage_url : manage)}" target="_blank" rel="noopener">${icon('clock')}<div class="t"><b>Deletion requested</b><small>${esc(request.mode === 'review'
      ? 'Our team will delete your account and data soon, and email you when it is done.'
      : `Your account and data will be deleted on ${when(request.due_at, { time: false })}. You can cancel until then from the email we sent you.`)}</small></div>${icon('external')}</a>`
    : opener('trash', 'Delete my account and data', 'Your membership details, photo, card and sign-in.',
      `<form method="post" action="${esc(m.base)}account/deletion">${hidden(m)}`
      + '<p>We delete your name, email address, phone number and photo, your card and member number, your password and passkeys, the devices you signed in on, your notifications, nearby offers and inbox.</p>'
      + '<p class="hint">The venue keeps its sales and points records for tax, with your name removed, and gift card balances so they can still be used. Your points and membership cannot be brought back.</p>'
      + '<fieldset><legend><b>When</b></legend>'
      + `<label class="choice"><input type="radio" name="mode" value="scheduled" checked><span>Automatically after <select name="days" aria-label="Days">${choices.map((d) => `<option value="${Number(d)}"${Number(d) === 30 ? ' selected' : ''}>${Number(d)} days</option>`).join('')}</select><small>Nothing is deleted until then, and you can cancel.</small></span></label>`
      + '<label class="choice"><input type="radio" name="mode" value="review"><span>As soon as possible<small>Our team deletes it, normally within two working days.</small></span></label></fieldset>'
      + '<label class="choice"><input type="checkbox" name="understood" required><span>I understand that once it is deleted it cannot be brought back.</span></label>'
      + `<div class="actions"><button class="btn bad">Request deletion</button><a class="link" href="${esc(manage)}" target="_blank" rel="noopener">More about deleting your data</a></div></form>`,
      { cls: 'bad' });

  const body = '<div class="narrow">'
    + say(state.note) + say(state.error, true)
    + `<section class="panel"><h2>You</h2>${you}</section>`
    + membershipPanel(m, member, me, payment)
    + (security ? `<section class="panel"><h2>Signing in</h2>${security}</section>` : '')
    + (devices.length ? `<section class="panel"><h2>Where you are signed in</h2>${devicesHtml}</section>` : '')
    + `<section class="panel"><h2>This device</h2>${leave}</section>`
    + `<section class="panel"><h2>Your data</h2>${data}</section>`
    + `${powered}</div>`;
  return signedIn({
    m, brand, unread, classes: hasClasses, tab: 'account', title: 'Account', body,
    script: offersPasskey && canEdit ? addPasskeyScript() : '',
  });
}

/** Add a passkey: the options from this site (they need the session), the browser's prompt, the answer posted back. */
function addPasskeyScript() {
  return B64
    + "var ab=document.querySelector('[data-add-passkey]'),pf=document.querySelector('[data-passkey-form]'),pe=document.querySelector('[data-passkey-error]'),d=document.body.dataset;"
    + 'if(ab&&canPasskey){ab.hidden=false;ab.addEventListener("click",async function(){pe.hidden=true;try{'
    + "var r=await fetch(d.base+'account/passkey-options',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':d.csrf},body:'{}'});"
    + 'var o=await r.json();if(!r.ok)throw new Error(o.error);var ch=o.challenge;o.challenge=b2u(o.challenge);o.user.id=b2u(o.user.id);'
    + '(o.excludeCredentials||[]).forEach(function(c){c.id=b2u(c.id)});'
    + 'var c=await navigator.credentials.create({publicKey:o});if(!c)return;'
    + 'pf.elements.proof.value=JSON.stringify({challenge:ch,credential:{id:c.id,rawId:u2b(c.rawId),type:c.type,'
    + 'transports:c.response.getTransports?c.response.getTransports():[],clientExtensionResults:c.getClientExtensionResults(),'
    + 'response:{clientDataJSON:u2b(c.response.clientDataJSON),attestationObject:u2b(c.response.attestationObject)}}});pf.submit()'
    + '}catch(x){if(x&&(x.name==="NotAllowedError"||x.name==="AbortError"))return;pe.textContent=(x&&x.message)||"That did not work. Please try again.";pe.hidden=false}})}';
}

// ---------------------------------------------------------------------------
// The venue (venue_page.dart)
// ---------------------------------------------------------------------------

const LINKS = {
  website: ['globe', 'Website'], booking: ['classes', 'Book'], menu: ['activity', 'Menu'], phone: ['call', 'Call'],
  email: ['mail', 'Email'], facebook: ['globe', 'Facebook'], instagram: ['photo', 'Instagram'], x: ['globe', 'X'], tiktok: ['globe', 'TikTok'],
};

function venue({ m, brand, unread, classes: hasClasses }) {
  const href = (key, value) => (key === 'phone' ? `tel:${String(value).replace(/\s/g, '')}`
    : key === 'email' ? `mailto:${value}` : /^https?:\/\//i.test(value) ? value : `https://${value}`);
  const loc = brand.location;
  let body = brand.hero ? `<img class="hero" src="${esc(brand.hero)}" alt="">` : '';
  body += `<div class="narrow"><div class="venue-head"><h1>${esc(brand.venue || brand.name)}</h1><p>${esc(brand.welcome)}</p></div><div class="panel">`;
  if (brand.address) {
    body += loc
      ? `<a class="row" href="${esc(`https://www.google.com/maps/dir/?api=1&destination=${loc.latitude},${loc.longitude}`)}" target="_blank" rel="noopener">${icon('place')}<div class="t"><b>${esc(brand.address)}</b></div>${icon('near')}</a>`
      : row('place', esc(brand.address), '');
  }
  if (brand.hours) body += row('clock', esc(brand.hours), '');
  for (const [key, value] of Object.entries(brand.links || {})) {
    if (!LINKS[key] || !value) continue;
    body += `<a class="row" href="${esc(href(key, value))}"${key === 'phone' || key === 'email' ? '' : ' target="_blank" rel="noopener"'}>${icon(LINKS[key][0])}<div class="t"><b>${LINKS[key][1]}</b><small>${esc(value)}</small></div></a>`;
  }
  body += '</div><section class="panel"><h2>Your settings</h2>';
  const canPush = !!(brand.push && brand.push.web && brand.push.web.vapid_public_key);
  body += `<div class="switch">${icon('bell')}<div class="t"><b>Notifications</b><small data-push-note>${canPush ? 'Offers and news as they happen.' : 'Not available on this device. Our news is always in News.'}</small></div>`
    + `<button type="button" class="toggle" aria-pressed="false" aria-label="Notifications" data-push disabled></button></div>`;
  if (loc) {
    body += `<div class="switch">${icon('near')}<div class="t"><b>Offers when I'm nearby</b><small data-near-note>Uses your location only while the app is open, and forgets it after a day.</small></div>`
      + '<button type="button" class="toggle" aria-pressed="false" aria-label="Offers when I\'m nearby" data-near disabled></button></div>';
  }
  body += `<noscript><p class="hint">Switch on JavaScript in this browser to change these.</p></noscript></section>${powered}</div>`;
  return signedIn({
    m, brand, unread, classes: hasClasses, tab: 'venue', title: 'Venue', body,
    script: venueScript(canPush ? brand.push.web.vapid_public_key : null),
  });
}

/** This browser's own two switches: notifications and nearby offers. */
function venueScript(vapid) {
  return B64
    + "var d=document.body.dataset,ps=document.querySelector('[data-push]'),ns=document.querySelector('[data-near]');"
    + "function post(w,b){return fetch(d.base+'venue/'+w,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':d.csrf},body:JSON.stringify(b||{})}).then(function(r){if(!r.ok)throw new Error('That did not work. Please try again.')})}"
    + "function set(b,on){b.setAttribute('aria-pressed',on?'true':'false')}"
    + (vapid
      ? `var key=${JSON.stringify(vapid)};`
        + "if('serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window){"
        + "navigator.serviceWorker.getRegistration(d.base).then(function(g){return g&&g.pushManager.getSubscription()}).then(function(s){set(ps,!!s);ps.disabled=false});"
        + "ps.addEventListener('click',async function(){ps.disabled=true;try{var g=await navigator.serviceWorker.register(d.base+'push-sw.js',{scope:d.base});"
        + "var s=await g.pushManager.getSubscription();if(s){var e=s.endpoint;await s.unsubscribe();await post('push-off',{endpoint:e});set(ps,false)}"
        + "else{if(await Notification.requestPermission()!=='granted'){document.querySelector('[data-push-note]').textContent='Notifications were not allowed. You can still read all our news in News.';return}"
        + "await navigator.serviceWorker.ready;s=await g.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b2u(key)});await post('push',{subscription:s.toJSON()});set(ps,true)}"
        + "}catch(x){document.querySelector('[data-push-note]').textContent=x.message}finally{ps.disabled=false}})}"
      : '')
    + "if(ns&&navigator.geolocation){var k='nearby:'+d.base,on=false;try{on=!!localStorage.getItem(k)}catch(e){}set(ns,on);ns.disabled=false;"
    + "ns.addEventListener('click',function(){ns.disabled=true;var note=document.querySelector('[data-near-note]');"
    + "if(ns.getAttribute('aria-pressed')==='true'){post('nearby-off').then(function(){try{localStorage.removeItem(k)}catch(e){}set(ns,false)}).catch(function(x){note.textContent=x.message}).finally(function(){ns.disabled=false});return}"
    + "navigator.geolocation.getCurrentPosition(function(p){post('nearby',{latitude:p.coords.latitude,longitude:p.coords.longitude}).then(function(){try{localStorage.setItem(k,String(Date.now()))}catch(e){}set(ns,true)})"
    + ".catch(function(x){note.textContent=x.message}).finally(function(){ns.disabled=false})},function(){note.textContent='Location was not allowed, so nearby offers stay off.';ns.disabled=false},{timeout:15e3})})}";
}

// ---------------------------------------------------------------------------
// Small pages
// ---------------------------------------------------------------------------

/** Something to say instead of the app: members only, paused, a fault. */
function notice({ m, brand, text, signOut = false }) {
  const body = '<main class="gate club"><div class="in">' + logo(brand, 96)
    + `<h1>${esc(brand.name)}</h1><p class="welcome">${esc(text)}</p>`
    + (signOut ? button(m, 'signout', 'Sign out') : `<a class="btn" href="${esc(m.base)}">Try again</a>`)
    + `${powered}</div></main>`;
  return document({ m, brand, title: null, bodyClass: 'signin', body });
}

/** A form whose token did not match: an old tab, or somebody else's page. */
function expired(m) {
  return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Please try again</title></head><body style="font:16px/1.5 system-ui,sans-serif;padding:32px;max-width:520px;margin:auto">'
    + `<h1 style="font-size:1.3rem">Please try again</h1><p>That page had been open too long, so nothing was changed.</p><p><a href="${esc(m.base)}">Back to your card</a></p></body></html>`;
}

module.exports = {
  signIn, card, activity, news, message, classes, account, venue, notice, expired,
  offersClasses, theme, config, when, money, mix, esc,
};
