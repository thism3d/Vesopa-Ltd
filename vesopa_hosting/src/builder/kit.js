/**
 * Vesopa Studio's kit: what every website built by talking is made of.
 *
 * A site is plain data -- a name, a language, a theme and an ordered list of
 * sections, each one piece of HTML -- and this file is the only place that
 * turns it into a page. The live preview and the published site both come
 * from here (the browser fetches /build/site.css; render() inlines nothing
 * else), so what the customer watches being built is what goes live.
 *
 *   PRESETS      colour and type pairings the designer model starts from
 *   FONTS        the Google Fonts it may use, with the weights to load
 *   ICONS        line icons, drawn by CSS masks: <i class="v-i" data-i="cake">
 *   siteCss()    the design system (public/assets/studio/site.css) + icons
 *   theme()      a validated theme from whatever the model or browser sent
 *   sanitise()   one section's HTML, with anything active taken out
 *   normalise()  a whole site, validated, from the browser
 *   render()     the finished index.html
 *
 * WHY SANITISE WHEN THE PREVIEW CANNOT RUN SCRIPT. The preview frame has no
 * script at all (its own CSP and sandbox), but the published page is served
 * from the customer's domain to the public. Nothing a model writes gets to
 * run there either: no script, no event handlers, no frames, no forms that
 * post somewhere, no javascript: links.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const PRESETS = {
  bakery:   { label: 'Warm bakery',   colors: { bg: '#FBF6EE', surface: '#FFFFFF', ink: '#2B1D12', muted: '#7A6553', accent: '#C0692A', accentInk: '#FFFFFF', soft: '#F3E6D3' }, fonts: { heading: 'Fraunces', body: 'Inter' }, radius: 18 },
  fresh:    { label: 'Fresh green',   colors: { bg: '#F4FAF5', surface: '#FFFFFF', ink: '#14301F', muted: '#5C7465', accent: '#2F8F4E', accentInk: '#FFFFFF', soft: '#DDF0E2' }, fonts: { heading: 'DM Serif Display', body: 'DM Sans' }, radius: 16 },
  midnight: { label: 'Midnight',      colors: { bg: '#0E1116', surface: '#171B22', ink: '#F2F4F7', muted: '#9AA4B2', accent: '#7C9CFF', accentInk: '#0E1116', soft: '#1B2029' }, fonts: { heading: 'Space Grotesk', body: 'Inter' }, radius: 14 },
  lime:     { label: 'Vesopa lime',   colors: { bg: '#111111', surface: '#1A1A1A', ink: '#F5F5F0', muted: '#A3A39A', accent: '#A5C715', accentInk: '#10130A', soft: '#1E2118' }, fonts: { heading: 'Outfit', body: 'Inter' }, radius: 16 },
  coastal:  { label: 'Coastal',       colors: { bg: '#F2F7FA', surface: '#FFFFFF', ink: '#0F2A3A', muted: '#56717F', accent: '#1C7FA6', accentInk: '#FFFFFF', soft: '#D8EAF2' }, fonts: { heading: 'Playfair Display', body: 'Source Sans 3' }, radius: 12 },
  blush:    { label: 'Blush',         colors: { bg: '#FFF6F5', surface: '#FFFFFF', ink: '#3A1F24', muted: '#8B6A70', accent: '#C94C6E', accentInk: '#FFFFFF', soft: '#FBE1E5' }, fonts: { heading: 'Cormorant Garamond', body: 'Nunito Sans' }, radius: 22 },
  studio:   { label: 'Minimal',       colors: { bg: '#FFFFFF', surface: '#F6F6F4', ink: '#111111', muted: '#6B6B66', accent: '#111111', accentInk: '#FFFFFF', soft: '#F1F1EC' }, fonts: { heading: 'Instrument Serif', body: 'Inter' }, radius: 6 },
  spice:    { label: 'Spice',         colors: { bg: '#1B120E', surface: '#261A15', ink: '#FFF4E6', muted: '#C9A98E', accent: '#E0A33B', accentInk: '#1B120E', soft: '#2A1D17' }, fonts: { heading: 'Playfair Display', body: 'Lato' }, radius: 10 },
  bold:     { label: 'Bold',          colors: { bg: '#FFFDF7', surface: '#FFFFFF', ink: '#161616', muted: '#5E5E5E', accent: '#FF5A1F', accentInk: '#FFFFFF', soft: '#FFEBDD' }, fonts: { heading: 'Bricolage Grotesque', body: 'Inter' }, radius: 20 },
};

/** Family -> the weights worth loading. Anything else falls back to a preset's. */
const FONTS = {
  'Inter': '400;500;600;700',
  'DM Sans': '400;500;700',
  'DM Serif Display': '400',
  'Fraunces': '400;600;700',
  'Space Grotesk': '400;500;700',
  'Outfit': '400;600;700',
  'Playfair Display': '400;600;700',
  'Source Sans 3': '400;600;700',
  'Cormorant Garamond': '500;600;700',
  'Nunito Sans': '400;600;700',
  'Instrument Serif': '400',
  'Lato': '400;700',
  'Poppins': '400;500;600;700',
  'Merriweather': '400;700',
  'Bricolage Grotesque': '400;600;800',
  'Hind Siliguri': '400;500;600;700',
  'Tiro Bangla': '400',
  'Noto Serif Bengali': '400;600;700',
};
/** Faces without Bengali glyphs are followed by one that has them on a Bangla site. */
const BENGALI_FALLBACK = { heading: 'Noto Serif Bengali', body: 'Hind Siliguri' };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const COLOR_KEYS = ['bg', 'surface', 'ink', 'muted', 'accent', 'accentInk', 'soft'];

/** A theme the page can trust, from a preset name plus any overrides. */
function theme(input = {}, base = null) {
  const start = base && base.colors ? base : PRESETS.bakery;
  const preset = input.preset && PRESETS[input.preset] ? PRESETS[input.preset] : null;
  const from = preset || start;
  const out = {
    preset: preset ? input.preset : (base && base.preset) || 'bakery',
    colors: { ...from.colors },
    fonts: { ...from.fonts },
    radius: from.radius,
  };
  // A preset named now resets colours and fonts; overrides then apply on top.
  if (!preset && base) {
    out.colors = { ...base.colors };
    out.fonts = { ...base.fonts };
    out.radius = base.radius;
  }
  const colors = input.colors && typeof input.colors === 'object' ? input.colors : {};
  for (const k of COLOR_KEYS) if (HEX.test(String(colors[k] || ''))) out.colors[k] = String(colors[k]);
  const fonts = input.fonts && typeof input.fonts === 'object' ? input.fonts : {};
  if (FONTS[fonts.heading]) out.fonts.heading = fonts.heading;
  if (FONTS[fonts.body]) out.fonts.body = fonts.body;
  const r = Number(input.radius);
  if (Number.isFinite(r)) out.radius = Math.max(0, Math.min(40, Math.round(r)));
  return out;
}

function themeCss(t, lang) {
  const c = t.colors;
  const bn = lang === 'bn';
  const face = (name, fallback) => `"${name}"${bn ? `, "${fallback}"` : ''}`;
  return `:root{--bg:${c.bg};--surface:${c.surface};--ink:${c.ink};--muted:${c.muted};--accent:${c.accent};--accent-ink:${c.accentInk};--soft:${c.soft};--radius:${t.radius}px;--font-h:${face(t.fonts.heading, BENGALI_FALLBACK.heading)};--font-b:${face(t.fonts.body, BENGALI_FALLBACK.body)}}`;
}

function fontsHref(t, lang) {
  const families = new Set([t.fonts.heading, t.fonts.body]);
  if (lang === 'bn') { families.add(BENGALI_FALLBACK.heading); families.add(BENGALI_FALLBACK.body); }
  const q = [...families].filter((f) => FONTS[f]).map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${FONTS[f]}`).join('&');
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}

// ---------------------------------------------------------------------------
// Icons: 24px line drawings, painted with a CSS mask so they take the text colour
// ---------------------------------------------------------------------------

const ICONS = {
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14l-1.5 7 5-2.5 5 2.5-1.5-7"/>',
  bag: '<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  cake: '<path d="M4 20h16v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2zM4 15c2 1.5 4 1.5 6 0s4-1.5 6 0 3 1 4 0M12 11V7"/><path d="M12 3.5c.8.8 1 1.6.5 2.3a.7.7 0 0 1-1 0c-.5-.7-.3-1.5.5-2.3z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  coffee: '<path d="M4 9h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6zM17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3"/>',
  facebook: '<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z"/>',
  gift: '<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M12 8v13M3 12h18M12 8c-2-4-6-4-6-1.5S10 8 12 8zm0 0c2-4 6-4 6-1.5S14 8 12 8z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  heart: '<path d="M12 20s-7-4.4-9.3-8.6C1.2 8.5 3 5 6.4 5c2 0 3.6 1.2 5.6 3.3C14 6.2 15.6 5 17.6 5 21 5 22.8 8.5 21.3 11.4 19 15.6 12 20 12 20z"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>',
  leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19c3-5 6-8 10-10"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5L20 19M8.5 15.5L20 5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  utensils: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-3 4.5-3 8h3v10"/>',
  whatsapp: '<path d="M4 20l1.3-4A8.5 8.5 0 1 1 8.4 19z"/><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.8-2-1-1 1a4 4 0 0 1-2.3-2.3l1-1-1-2z"/>',
  wifi: '<path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1"/>',
};

function iconCss() {
  return Object.entries(ICONS).map(([name, body]) => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${body.replace(/"/g, "'")}</svg>`;
    const uri = svg.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23');
    return `.v-i[data-i="${name}"]{--i:url("data:image/svg+xml,${uri}")}`;
  }).join('\n');
}

let cssCache = null;
/** The whole design system, as one stylesheet. Read once. */
function siteCss() {
  if (!cssCache) {
    const base = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'assets', 'studio', 'site.css'), 'utf8');
    cssCache = `${base}\n/* icons */\n${iconCss()}\n`;
  }
  return cssCache;
}

// ---------------------------------------------------------------------------
// Sanitising a section
// ---------------------------------------------------------------------------

/** Elements removed with everything inside them. */
const DROP_WHOLE = /<(script|style|iframe|frame|frameset|object|embed|applet|template|noscript|svg|math|textarea|select|canvas|audio|video|link|meta|base|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DROP_OPEN = /<\/?(script|style|iframe|frame|frameset|object|embed|applet|template|noscript|svg|math|textarea|select|canvas|audio|video|link|meta|base|form|input|option|param|source|track)\b[^>]*>/gi;

const TAGS = new Set(['header', 'footer', 'section', 'nav', 'main', 'article', 'aside', 'div', 'span', 'p', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'small', 'br', 'hr', 'img', 'figure', 'figcaption', 'blockquote', 'cite', 'address', 'details', 'summary', 'time', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd', 'mark', 's', 'u', 'sup', 'sub', 'q', 'abbr', 'picture', 'button']);
const VOID = new Set(['br', 'hr', 'img']);
const ATTRS = new Set(['class', 'id', 'title', 'role', 'data-i', 'data-emoji', 'data-photo', 'data-photo-id', 'datetime', 'colspan', 'rowspan', 'open', 'loading', 'width', 'height', 'alt', 'href', 'src', 'target', 'rel', 'style', 'lang', 'dir']);

function escAttr(v) {
  return String(v).replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeUrl(value, kind) {
  const v = String(value || '').trim().replace(/[ -\s]+/g, '');
  if (kind === 'src') return /^https:\/\/[^\s"'<>]+$/i.test(v) || /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(v) ? v : '';
  if (/^(https?:|mailto:|tel:|#|\/(?!\/))/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return ''; // javascript:, data:, anything else with a scheme
  return v;
}

function safeStyle(value) {
  const v = String(value || '');
  if (/url\s*\(|expression|behaviou?r|@import|javascript:|<|>/i.test(v)) return '';
  return v.slice(0, 400);
}

/** One section's HTML with everything that could act taken out. */
function sanitise(html) {
  let s = String(html || '').slice(0, 80000);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  let before;
  do { before = s; s = s.replace(DROP_WHOLE, ''); } while (s !== before);
  s = s.replace(DROP_OPEN, '');
  return s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (all, close, rawName, rawAttrs) => {
    let name = rawName.toLowerCase();
    if (!TAGS.has(name)) return '';
    if (name === 'button') name = 'span'; // nothing on a static page for a button to do
    if (close) return VOID.has(name) ? '' : `</${name}>`;
    const attrs = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(rawAttrs))) {
      const key = m[1].toLowerCase();
      if (!ATTRS.has(key) && !/^aria-[a-z-]+$/.test(key)) continue;
      let val = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '';
      if (key === 'href') { if (name !== 'a') continue; val = safeUrl(val, 'href'); if (!val) continue; }
      if (key === 'src') { if (name !== 'img') continue; val = safeUrl(val, 'src'); if (!val) continue; }
      if (key === 'target' && val !== '_blank') continue;
      if (key === 'style') { val = safeStyle(val); if (!val) continue; }
      attrs.push(val === '' && key === 'open' ? 'open' : `${key}="${escAttr(val)}"`);
    }
    if (name === 'a' && attrs.some((a) => a === 'target="_blank"') && !attrs.some((a) => a.startsWith('rel='))) attrs.push('rel="noopener"');
    if (name === 'img' && !attrs.some((a) => a.startsWith('src='))) return '';
    return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  }).trim();
}

// ---------------------------------------------------------------------------
// A whole site
// ---------------------------------------------------------------------------

const SECTION_ID = /^[a-z][a-z0-9-]{0,30}$/;
const MAX_SECTIONS = 30;

function blankSite() {
  return { v: 1, name: '', description: '', lang: 'en', theme: theme({ preset: 'bakery' }), sections: [] };
}

/** A site from the browser, validated field by field. */
function normalise(input) {
  const s = input && typeof input === 'object' ? input : {};
  const out = blankSite();
  out.name = String(s.name || '').slice(0, 80);
  out.description = String(s.description || '').slice(0, 300);
  out.lang = s.lang === 'bn' ? 'bn' : 'en';
  // A stored theme always carries its preset and every colour, so reading it
  // back through theme() reproduces it exactly.
  out.theme = theme(s.theme || {});
  const seen = new Set();
  for (const sec of Array.isArray(s.sections) ? s.sections : []) {
    const id = String(sec && sec.id || '');
    if (!SECTION_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.sections.push({ id, html: sanitise(sec.html) });
    if (out.sections.length >= MAX_SECTIONS) break;
  }
  return out;
}

function esc(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The published page. `cssHref` points at the stylesheet published beside it;
 * without one the CSS is inlined (a single-file download).
 */
function render(site, { cssHref = null } = {}) {
  const s = normalise(site);
  const css = cssHref ? `<link rel="stylesheet" href="${esc(cssHref)}">` : `<style>${siteCss()}</style>`;
  const body = s.sections.map((sec) => sec.html).join('\n\n');
  return `<!doctype html>
<html lang="${s.lang === 'bn' ? 'bn' : 'en-GB'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.name || 'Welcome')}</title>
${s.description ? `<meta name="description" content="${esc(s.description)}">\n` : ''}<meta name="generator" content="Vesopa Studio">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(fontsHref(s.theme, s.lang))}">
${css}
<style>${themeCss(s.theme, s.lang)}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

module.exports = { PRESETS, FONTS, ICONS, SECTION_ID, siteCss, theme, themeCss, fontsHref, sanitise, normalise, blankSite, render };
