/**
 * Inline SVG icons.
 *
 * A module rather than an EJS partial. `include` compiles the included file in
 * its own scope, so a `const icon = …` declared inside one is invisible to the
 * template that included it — which fails at render time, not at boot, on
 * whichever page you happen not to have opened. Exposed once as
 * `res.locals.icon`, which every view and every partial can see.
 *
 * Inline rather than an icon font or a sprite sheet: a hosting homepage that
 * waits on a font request has an empty first paint, and the whole set used here
 * is smaller than the request that would fetch it.
 */

const PATHS = {
  check: '<path d="M20 6L9 17l-5-5"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  bolt: '<path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20 15 15 0 010-20z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2.5 6.5L12 13l9.5-6.5"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  backup: '<path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 3v6h-6"/>',
  headset: '<path d="M4 13v-1a8 8 0 0116 0v1"/><rect x="2" y="13" width="5" height="7" rx="2"/><rect x="17" y="13" width="5" height="7" rx="2"/><path d="M22 18v1a3 3 0 01-3 3h-4"/>',
  rocket: '<path d="M5 13c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M14.5 4.5C17 2 21 3 21 3s1 4-1.5 6.5L13 16l-5-5 6.5-6.5z"/><circle cx="15.5" cy="8.5" r="1.4"/>',
  chart: '<path d="M3 21h18"/><rect x="5" y="11" width="4" height="7" rx="1"/><rect x="11" y="6" width="4" height="12" rx="1"/><rect x="17" y="14" width="4" height="4" rx="1"/>',
  wordpress: '<circle cx="12" cy="12" r="10"/><path d="M3.5 9h6M8 9l3.5 9L15 9M12.5 9h5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6.5V12l3.5 2"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  ticket: '<path d="M3 9V6a2 2 0 012-2h14a2 2 0 012 2v3a3 3 0 000 6v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3a3 3 0 000-6z"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.9 14.6a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.2a1.6 1.6 0 00-2.7-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3.9a2 2 0 110-4h.2a1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.2a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7h.2a2 2 0 110 4h-.2a1.6 1.6 0 00-1.5 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  external: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  warning: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2z"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l3 3"/>',

  // ---- Domain catalogue shelves --------------------------------------------
  // One per category in domain-catalogue.js. Drawn to the same 24px grid and
  // 2px stroke as everything above so a filter bar of nineteen of them reads as
  // one set rather than nineteen borrowed glyphs.
  flag: '<path d="M4 22V4M4 5h11l-1.5 3.5L15 12H4"/>',
  briefcase: '<rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M2.5 12.5h19"/>',
  code: '<path d="M9 18l-6-6 6-6M15 6l6 6-6 6"/>',
  cart: '<circle cx="9.5" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 12.3a1.5 1.5 0 001.5 1.2h8.6a1.5 1.5 0 001.5-1.2L21 7H6"/>',
  brush: '<path d="M14 3l7 7-8.5 8.5a3 3 0 01-1.6.8L6 20l.7-4.9a3 3 0 01.8-1.6z"/><path d="M12 5l7 7"/>',
  play: '<circle cx="12" cy="12" r="10"/><path d="M10 8.5l6 3.5-6 3.5z"/>',
  cup: '<path d="M4 8h13v6a5 5 0 01-5 5H9a5 5 0 01-5-5z"/><path d="M17 9.5h1.5a2.5 2.5 0 010 5H17M3 22h15"/>',
  heart: '<path d="M12 20.5S3.5 15 3.5 8.9A4.6 4.6 0 0112 6.6a4.6 4.6 0 018.5 2.3c0 6.1-8.5 11.6-8.5 11.6z"/>',
  coins: '<ellipse cx="9" cy="6.5" rx="6.5" ry="3"/><path d="M2.5 6.5v5c0 1.7 2.9 3 6.5 3s6.5-1.3 6.5-3v-5"/><path d="M15.5 10.4c3.3.3 6 1.5 6 3.1v4c0 1.7-2.9 3-6.5 3-2.6 0-4.9-.7-6-1.7"/>',
  home: '<path d="M3 10.5L12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 001 1h11a1 1 0 001-1V9.5"/><path d="M10 21v-6h4v6"/>',
  plane: '<path d="M2 13.5l20-8.5-8.5 20-2.5-8z"/><path d="M11 17l-2.5-8"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 01-10 0z"/><path d="M7 6H4.5a2.5 2.5 0 005 .5M17 6h2.5a2.5 2.5 0 01-5 .5"/><path d="M12 14v4M8.5 21h7"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 016.5 2H20v16H6.5A2.5 2.5 0 004 20.5z"/><path d="M4 20.5A2.5 2.5 0 016.5 18H20v4H6.5A2.5 2.5 0 014 19.5z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 5.2a3.5 3.5 0 010 6.6M18 14.5a6.5 6.5 0 013.5 5.5"/>',
  scales: '<path d="M12 3v18M7 21h10M12 6l-7 1.5M12 6l7 1.5"/><path d="M2 14l3-6.5L8 14a3 3 0 01-6 0zM16 14l3-6.5 3 6.5a3 3 0 01-6 0z"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  tag: '<path d="M3 12.5V4a1 1 0 011-1h8.5l8 8-9.5 9.5z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  wallet: '<rect x="2.5" y="5.5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M17 15h1.5"/>',
  bitcoin: '<circle cx="12" cy="12" r="10"/><path d="M9.5 7.5h4a2.25 2.25 0 010 4.5h-4zM9.5 12h4.3a2.25 2.25 0 010 4.5H9.5zM9.5 7.5v9M11.3 5.5v2M11.3 16.5v2M14 5.5v2M14 16.5v2"/>',

  // ---- File manager --------------------------------------------------------
  // Same 24px grid and 2px stroke as everything above, so a toolbar of them
  // reads as one set. `folder`, `code`, `search`, `dots` and `lock` are reused
  // from further up rather than drawn twice.
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  'file-plus': '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M12 12v5M9.5 14.5h5"/>',
  'folder-plus': '<path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 11.5v5M9.5 14h5"/>',
  upload: '<path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/><path d="M12 16V4M7.5 8.5L12 4l4.5 4.5"/>',
  download: '<path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/><path d="M12 4v12M7.5 11.5L12 16l4.5-4.5"/>',
  trash: '<path d="M4 6.5h16"/><path d="M9 6.5V4.5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M6.5 6.5L7.5 20a1.5 1.5 0 001.5 1.4h6a1.5 1.5 0 001.5-1.4l1-13.5"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
  pencil: '<path d="M4 20l4.5-1 10-10a2.1 2.1 0 10-3-3l-10 10z"/><path d="M14.5 6.5l3 3"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 5.5V5a2 2 0 00-2-2H5.5a2 2 0 00-2 2v8a2 2 0 002 2H6"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 11-2.6-6.1"/><path d="M20.5 3.5v5h-5"/>',
  save: '<path d="M5 3.5h11L20.5 8v11a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 19V5A1.5 1.5 0 015 3.5z"/><path d="M8 3.5v6h7v-6M8 20.5V15h8v5.5"/>',
  eye: '<path d="M1.8 12S5.5 5.5 12 5.5 22.2 12 22.2 12 18.5 18.5 12 18.5 1.8 12 1.8 12z"/><circle cx="12" cy="12" r="3.2"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="M3.5 17l5-5 3.5 3.5 3-2.5 5.5 5"/>',
  box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  scissors: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8 7.5L20 18M20 6L8 16.5"/>',
};

/**
 * @param {string} name  a key from PATHS. An unknown name renders an empty
 *                       <svg> rather than throwing, so a typo in a template
 *                       leaves a gap instead of a 500.
 * @param {number} size  px, applied to both width and height
 */
function icon(name, size = 22) {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${PATHS[name] || ''}</svg>`
  );
}

module.exports = { icon, PATHS };
