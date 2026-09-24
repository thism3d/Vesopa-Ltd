/**
 * Deep links: does a refresh still land on the page you were looking at?
 *
 * The back office routes client-side, so every one of its URLs is a promise the
 * *server* has to keep: press F5 on /reports/schedules and something has to
 * answer with the app shell, or the page 404s and the only way back is the
 * dashboard.
 *
 * That is exactly what happened. The fallback pattern ended `[a-z0-9-]*$` — one
 * segment, no slash — so thirty-five one-word routes refreshed perfectly and
 * the two report pages, the only ones with a slash in them, did not. A fault
 * that hits two pages out of thirty-seven reads as "refresh is broken
 * sometimes" and is nobody's idea of reproducible.
 *
 * Both halves of the fix are guarded here, because both are the kind of thing
 * the next route added will quietly break:
 *
 *   1. Every path in app.js's own ROUTES table is served the shell. Read out of
 *      app.js rather than listed again here — a second copy of the routes is a
 *      copy that goes stale, and going stale is the bug.
 *   2. The fallback is the LAST app.get in server.js. It matches broadly enough
 *      to cover /reports/schedules, which means it also matches
 *      /reports/end-of-day — a real JSON endpoint. Express matches in
 *      registration order, so being last is what keeps that route working. Put
 *      anything after it and a till asking for its end-of-day figures gets a
 *      page of HTML.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (...parts) =>
  fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

const server = read('src', 'server.js');
const app = read('public', 'app.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Back office: deep links and refresh\n');

// ---- The fallback itself ---------------------------------------------------

const found = /app\.get\(\s*(\/\^[^\n]*?\/),\s*sendShell\s*\)/.exec(server);

check('there is a deep-link fallback to find', () => {
  assert.ok(found, 'no `app.get(<pattern>, sendShell)` in server.js');
});

// eslint-disable-next-line no-eval -- the pattern is read out of our own source
const fallback = found ? eval(found[1]) : null;

/** Every path the browser can be sitting on, from the client's own table. */
const clientRoutes = (() => {
  const block = app.slice(app.indexOf('const ROUTES = {'), app.indexOf('const viewForPath'));
  return [...block.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]);
})();

check('the client has routes to check', () => {
  assert.ok(clientRoutes.length > 20, `only found ${clientRoutes.length}`);
});

check('every page the app can be on survives a refresh', () => {
  const lost = clientRoutes.filter((route) => !fallback.test(route));
  assert.deepStrictEqual(lost, [], 'these 404 on F5 instead of opening the app');
});

check('and a multi-segment route is not a special case', () => {
  // The whole of the original bug, stated as a rule: nested paths are ordinary.
  assert.ok(fallback.test('/reports/schedules'));
  assert.ok(fallback.test('/reports/financial-summary'));
  assert.ok(fallback.test('/some/route/added/later'));
});

check('an API path is never answered with a page of HTML', () => {
  // A fetch() that gets HTML fails with a JSON parse error a long way from the
  // cause, so these stay excluded even though ordering would also cover them.
  for (const route of [
    '/api/reports/catalogue',
    '/api/anything',
    '/till/products',
    '/orders',
    '/health',
  ]) {
    assert.ok(!fallback.test(route), `${route} would be served the shell`);
  }
});

check('and neither is a file', () => {
  for (const file of ['/app.js', '/style.css', '/assets/vesopa_logo.png', '/products.json']) {
    assert.ok(!fallback.test(file), `${file} would be served the shell`);
  }
});

check('a segment that merely starts with an excluded word is still a page', () => {
  // The exclusions are anchored to whole segments, so this is a page name and
  // not an accidental API path.
  assert.ok(fallback.test('/apiary'));
  assert.ok(fallback.test('/orders-report'));
});

// ---- Where it is declared --------------------------------------------------

check('the fallback is the last route in server.js', () => {
  const at = server.indexOf(found[0]);
  const after = [...server.slice(at + found[0].length).matchAll(/\napp\.get\(/g)];
  assert.deepStrictEqual(
    after.map((m) => m[0].trim()),
    [],
    'a route declared after the fallback can never be reached — the fallback ' +
      'matches broadly and Express takes the first match'
  );
});

check('and the routes it would otherwise swallow are declared before it', () => {
  const at = server.indexOf(found[0]);
  // /reports/end-of-day matches the pattern. It works only because it is
  // registered first, so this is the assertion that keeps a till's end-of-day
  // figures from becoming a page of HTML.
  const endOfDay = server.indexOf("app.get('/reports/end-of-day'");
  assert.ok(endOfDay > -1, 'the end-of-day route has moved or been renamed');
  assert.ok(fallback.test('/reports/end-of-day'), 'no longer overlapping — check this test');
  assert.ok(endOfDay < at, 'end-of-day is now unreachable behind the fallback');
});

check('the printed table codes are not swallowed by the fallback', () => {
  // /t/<32 hex> is what is printed on a card and screwed to a table, and it
  // matches the fallback pattern exactly — lower-case letters, digits, two
  // segments. It reaches the menu only because dineinPageRoutes() is mounted
  // first, so this is the assertion standing between a customer's scan and a
  // page of back office HTML.
  const card = '/t/' + 'a1b2c3d4'.repeat(4);
  assert.ok(fallback.test(card), 'no longer overlapping — check this test');

  const at = server.indexOf(found[0]);
  const pages = server.search(/app\.use\(dineinPageRoutes\(/);
  assert.ok(pages > -1, 'the dine-in pages are no longer mounted');
  assert.ok(pages < at, 'a scanned table code would be answered with the back office');
});

check('and neither is a venue address or an order link', () => {
  assert.ok(fallback.test('/m/the-bridge'));
  assert.ok(fallback.test('/o/' + 'f'.repeat(32)));
  const at = server.indexOf(found[0]);
  assert.ok(server.search(/app\.use\(dineinPageRoutes\(/) < at);
});

check('the dine-in pages are mounted ahead of the static middleware too', () => {
  // express.static answers before anything after it, and a file that happened
  // to be called `t` would otherwise shadow every table on the estate.
  const pages = server.search(/app\.use\(dineinPageRoutes\(/);
  const statics = server.indexOf('app.use(express.static(PUBLIC_DIR');
  assert.ok(statics > -1, 'the static middleware has moved');
  assert.ok(pages < statics, 'the dine-in pages are behind express.static');
});

check('a nav press works wherever inside the button it lands', () => {
  // This read data-view off the clicked element, which worked only while a nav
  // button held nothing but a bare text node. A <span> was put inside them for
  // an icon-only rail; from then on clicking the words hit the span, which
  // carries no data-view, and the press did nothing — while clicking the
  // padding around them still worked. A nav that answers about one press in
  // three, which is how it was reported.
  //
  // closest() is what makes it survive anything being put inside a button, and
  // sooner or later something will be.
  assert.ok(
    app.includes("t.closest?.('[data-view]')"),
    'the nav branch reads the clicked element rather than the button around it'
  );
  assert.ok(
    !app.includes('if (t.dataset.view)'),
    'the old element-only test is back'
  );
});

check('nothing wraps a nav button’s text any more', () => {
  // The span that caused it belonged to a design that was replaced. Comments
  // are stripped first, because the note explaining all this names it.
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!code.includes('nav-word'), 'nav-word is back in the code');
});

// ---- Every page in the rail can actually be got to -------------------------
//
// The other direction, and the one that was missing.
//
// The checks above go ROUTES -> server: every path app.js knows about is served
// the shell. Nothing went the other way -- nav button -> ROUTES -- and the Gym
// page shipped through that gap. It was added to the rail with `hidden` on it
// (to be revealed once a venue switched the gym on), and it was never added to
// ROUTES. So the button was invisible, /gym fell through to the dashboard, and
// the only switch that turns the gym on lives on the page nobody could open.
// A whole feature, unreachable, with every one of its own tests passing.
//
// Three things have to line up for a view to exist at all, and now all three
// are asserted for every button in the rail.

const html = read('public', 'index.html');

const navViews = [...html.matchAll(/<button class="nav" data-view="([^"]+)"([^>]*)>/g)]
  .map((m) => ({ view: m[1], attrs: m[2] }));

check('there are nav buttons to check', () => {
  assert.ok(navViews.length > 20, `found ${navViews.length} nav buttons`);
});

check('every page in the rail has a section to show', () => {
  const missing = navViews
    .filter((n) => !html.includes(`id="view-${n.view}"`))
    .map((n) => n.view);
  assert.deepStrictEqual(missing, [], `no <section id="view-..."> for: ${missing}`);
});

check('every page in the rail has a URL of its own', () => {
  // Without one, the address bar says /dashboard whatever you are looking at,
  // a refresh throws the page away, and the page cannot be linked to or
  // bookmarked -- or reached at all if its button is ever hidden.
  const routes = app.slice(app.indexOf('const ROUTES'), app.indexOf('const viewForPath'));
  const missing = navViews
    .filter((n) => !new RegExp(`\\b${n.view}:\\s*'`).test(routes))
    .map((n) => n.view);
  assert.deepStrictEqual(missing, [], `not in ROUTES: ${missing}`);
});

check('no page in the rail is hidden in the markup', () => {
  // `hidden` here is a page nobody can navigate to. Whether a role may see a
  // view is applyAccess's job and it does it at runtime; a hidden attribute in
  // the file is a page that is off for everybody, including the person who
  // needs to switch it on.
  const hidden = navViews.filter((n) => /\bhidden\b/.test(n.attrs)).map((n) => n.view);
  assert.deepStrictEqual(hidden, [], `hidden in index.html: ${hidden}`);
});

console.log(`\n${passed} checks passed`);
