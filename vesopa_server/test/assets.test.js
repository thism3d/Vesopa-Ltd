/**
 * Asset versioning: does a deployed change actually reach a device?
 *
 * The fault behind this was reported from an iPad, and it is the one that makes
 * every other fix look like it did not work: a layout corrected and deployed
 * was still not visible days later, because Safari was serving the `/style.css`
 * it already had. There is no reliable way to clear that from a phone or a
 * tablet, so the URL has to change instead.
 *
 * No browser and no server here — `assetVersions` is a pure function of a
 * directory, so it is tested against a directory. What is checked is the set of
 * things that would each, on their own, put us back where we started:
 *
 *   * a file that changed keeps its old URL             -> the fix never lands
 *   * a file that did not change gets a new URL         -> every venue
 *                                                          re-downloads
 *                                                          everything, forever
 *   * an upload or an external URL gets rewritten       -> broken images
 *   * the page that names the URLs is itself cached     -> versioning is moot
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assetVersions, staticCache } = require('../src/assets');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ok  ', name);
    passed++;
  } catch (e) {
    console.error('  FAIL', name);
    throw e;
  }
}

/** A throwaway public/ to hash. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-assets-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

(async () => {
  console.log('\nasset versioning');

  const base = {
    'style.css': 'body { color: red }',
    'app.js': 'console.log(1)',
    'index.html': '<link href="/style.css"><script src="/app.js"></script>',
    'assets/logo.png': 'PNG-BYTES',
    'uploads/venue-logo.png': 'PNG-BYTES',
  };

  test('every asset gets a version, and the page is rewritten to match', () => {
    const root = fixture(base);
    const a = assetVersions(root);

    assert.match(a.stamp('/style.css'), /^\/style\.css\?v=[0-9a-f]{10}$/);
    assert.match(a.stamp('/assets/logo.png'), /^\/assets\/logo\.png\?v=[0-9a-f]{10}$/);

    const html = a.rewrite(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
    assert.ok(html.includes(a.stamp('/style.css')), html);
    assert.ok(html.includes(a.stamp('/app.js')), html);
  });

  test('a changed file gets a new URL — which is the whole point', () => {
    const root = fixture(base);
    const before = assetVersions(root).stamp('/style.css');

    fs.writeFileSync(path.join(root, 'style.css'), 'body { color: blue }');
    const after = assetVersions(root).stamp('/style.css');

    assert.notStrictEqual(
      after,
      before,
      'the stylesheet changed and its URL did not, so nobody would ever see it'
    );
  });

  test('an unchanged file keeps its URL — which is the other half', () => {
    // A deploy timestamp would pass the check above and fail this one, and the
    // cost is real: every venue re-downloads every asset on every deploy
    // because one line of CSS moved.
    const root = fixture(base);
    const before = assetVersions(root).stamp('/app.js');

    fs.writeFileSync(path.join(root, 'style.css'), 'body { color: green }');
    const after = assetVersions(root).stamp('/app.js');

    assert.strictEqual(after, before, 'an untouched file was given a new URL');
  });

  test('the same bytes hash the same wherever they are', () => {
    const root = fixture({ ...base, 'copy.css': base['style.css'] });
    const a = assetVersions(root);
    assert.strictEqual(
      a.stamp('/style.css').split('=')[1],
      a.stamp('/copy.css').split('=')[1]
    );
  });

  test('venue uploads are left alone', () => {
    // Runtime content: already uniquely named, potentially thousands of files,
    // and hashing it would add a directory walk to every restart.
    const root = fixture(base);
    const a = assetVersions(root);
    assert.strictEqual(a.stamp('/uploads/venue-logo.png'), '/uploads/venue-logo.png');
    assert.strictEqual(
      a.rewrite('<img src="/uploads/venue-logo.png">'),
      '<img src="/uploads/venue-logo.png">'
    );
  });

  test('nothing that is not a local asset is touched', () => {
    const root = fixture(base);
    const a = assetVersions(root);
    for (const html of [
      '<a href="/products">Products</a>',
      '<img src="https://cdn.example.com/style.css">',
      '<a href="mailto:hello@vesopa.co.uk">mail</a>',
      '<a href="#features">features</a>',
      '<link href="/style.css?v=already">',
    ]) {
      assert.strictEqual(a.rewrite(html), html, html);
    }
  });

  test('a page link that shares a name with an asset is still a page link', () => {
    // The back office routes client-side and owns /products as a page. It is
    // not a file, it is not in the map, and it must come out unchanged.
    const root = fixture(base);
    assert.strictEqual(
      assetVersions(root).rewrite('<a href="/products">x</a>'),
      '<a href="/products">x</a>'
    );
  });

  test('the build id moves when anything moves, and not otherwise', () => {
    const root = fixture(base);
    const before = assetVersions(root).buildId;
    assert.strictEqual(assetVersions(root).buildId, before, 'not stable');

    fs.writeFileSync(path.join(root, 'app.js'), 'console.log(2)');
    assert.notStrictEqual(assetVersions(root).buildId, before, 'did not move');
  });

  test('an empty or missing directory is not fatal', () => {
    // A back office that will not start because an asset could not be read is a
    // worse outcome than one that serves it without a version.
    const a = assetVersions(path.join(os.tmpdir(), 'vesopa-does-not-exist'));
    assert.strictEqual(a.versions.size, 0);
    assert.strictEqual(a.stamp('/style.css'), '/style.css');
    assert.strictEqual(a.rewrite('<link href="/style.css">'), '<link href="/style.css">');
  });

  test('a versioned request is cached for a year, an unversioned one is not', () => {
    const headers = {};
    const res = (query) => ({
      req: { query },
      setHeader: (k, v) => (headers[k] = v),
    });

    staticCache(res({ v: 'abc123' }));
    assert.strictEqual(headers['Cache-Control'], 'public, max-age=31536000, immutable');

    delete headers['Cache-Control'];
    staticCache(res({}));
    assert.strictEqual(
      headers['Cache-Control'],
      undefined,
      'an unversioned URL must keep the default, revalidating policy'
    );
  });

  test('the shell that names every URL is itself never stored', () => {
    // Versioning the stylesheet achieves nothing if the page pointing at it is
    // the cached one — it names the old URL. Read from the server rather than
    // asserted in the abstract, so the two cannot drift apart.
    const server = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'server.js'),
      'utf8'
    );
    assert.ok(
      /Cache-Control['"],\s*['"]no-store/.test(server),
      'the app shell is not served with no-store'
    );
    assert.ok(
      server.includes('assets.rewrite('),
      'the app shell is served without its asset URLs being versioned'
    );
  });

  console.log(`\nasset versioning: ${passed}/${passed} passed\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
