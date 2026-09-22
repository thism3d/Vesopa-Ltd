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

console.log(`\n${passed} checks passed`);
