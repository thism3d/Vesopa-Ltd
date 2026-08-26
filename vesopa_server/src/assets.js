/**
 * Static assets that change their own URL when their contents change.
 *
 * THE PROBLEM THIS SOLVES, because it is a support call and not a nicety.
 *
 * `/style.css` is one URL for ever. A browser that has it will keep using the
 * copy it has, and an iPad in particular will hold one for days. So a fix
 * deployed on Tuesday reaches a manager on Friday, and in between they are
 * looking at a layout we have already corrected and reporting it again. There
 * is no gesture in mobile Safari that reliably clears it — "hard refresh" is a
 * desktop idea — so telling a venue to clear their cache is telling them to do
 * something they cannot do.
 *
 * The only reliable answer is to make the URL different. `/style.css?v=9f2c1a…`
 * is a URL the browser has never seen, so it fetches it, and the HTML that
 * points at it is served with `no-store` so *that* is never stale either.
 *
 * WHY A CONTENT HASH RATHER THAN A TIMESTAMP OR A VERSION NUMBER.
 *
 * A deploy timestamp would work and would also throw away every cached asset on
 * every deploy, including the eleven that did not change — so every venue
 * re-downloads the whole back office because one line of CSS moved. A hash of
 * the file's own bytes changes when, and only when, the file changes. Nothing
 * to remember and nothing to bump.
 *
 * A hand-maintained constant is the option that does not work, and vesopa_web
 * is the proof: it has carried `APP_VERSION = '1.3.2.0'` on some of its assets
 * for long enough that the number no longer means anything, and the assets
 * without it were never busted at all.
 *
 * WHEN IT IS COMPUTED.
 *
 * Once, at boot. A deploy replaces the files and restarts pm2, so boot is
 * exactly the moment the answer changes. Reading a few hundred kilobytes once
 * per process start costs nothing; doing it per request would cost a stat on
 * the path of every page load.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * What is worth hashing.
 *
 * Deliberately not everything. `public/uploads` is venue content — a logo, a
 * product picture — written at runtime, already carrying a unique filename, and
 * potentially thousands of files. Hashing it at boot would slow every restart
 * for no gain, so an upload URL passes through untouched.
 */
const VERSIONED = new Set([
  '.css', '.js', '.mjs',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.webm', '.json', '.webmanifest',
]);

/** Directories under the public root that are never stamped. */
const SKIP_DIRS = new Set(['uploads', 'node_modules']);

/**
 * Ten hex characters of SHA-1 over the file's bytes.
 *
 * Not a security boundary — nobody is attacking a cache key — so the shortest
 * thing that will not collide across a few hundred files is the right length.
 * A full 40 characters in every URL is noise in the page source.
 */
function hashFile(file) {
  return crypto
    .createHash('sha1')
    .update(fs.readFileSync(file))
    .digest('hex')
    .slice(0, 10);
}

/**
 * Build the map of URL path -> content hash for one public directory.
 *
 * An unreadable file is skipped rather than fatal. A back office that will not
 * start because one asset could not be hashed is a worse outcome than one that
 * serves that asset without a version on it.
 */
function scan(root) {
  const versions = new Map();

  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, `${prefix}${entry.name}/`);
        continue;
      }
      if (!VERSIONED.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        versions.set(`${prefix}${entry.name}`, hashFile(full));
      } catch {
        // Skipped, as above.
      }
    }
  };

  walk(root, '/');
  return versions;
}

/**
 * The versioner for one public directory.
 *
 * `buildId` is a hash of every hash — one value that changes whenever anything
 * does, for the places that want a single number rather than a per-file one.
 */
function assetVersions(root) {
  const versions = scan(root);

  const buildId = crypto
    .createHash('sha1')
    .update([...versions.entries()].sort().join('|'))
    .digest('hex')
    .slice(0, 10);

  /** `/style.css` -> `/style.css?v=9f2c1a4b6d`, or unchanged if unknown. */
  function stamp(url) {
    if (typeof url !== 'string' || !url.startsWith('/')) return url;
    // Anything that already carries a query is left alone: it is either
    // already versioned or it means something to the server.
    if (url.includes('?') || url.includes('#')) return url;
    const version = versions.get(url);
    return version ? `${url}?v=${version}` : url;
  }

  /**
   * Put a version on every local asset in a page of HTML.
   *
   * Done to the markup rather than in the markup, and that is the whole point:
   * there is one place to get right instead of one per `<link>`, and a template
   * somebody adds next year is covered without anybody remembering this file
   * exists. The alternative — `?v=<%= VERSION %>` typed by hand at each call
   * site — is the thing that is already half-done and half-wrong on the public
   * site.
   *
   * Only `href` and `src`, only values starting `/`, and only files the scan
   * knows about. An external URL, a `mailto:`, an anchor and an upload all fall
   * straight through.
   */
  function rewrite(html) {
    return String(html).replace(
      /\b(href|src)="(\/[^"?#>]*)"/g,
      (whole, attr, url) => {
        const stamped = stamp(url);
        return stamped === url ? whole : `${attr}="${stamped}"`;
      }
    );
  }

  return { versions, buildId, stamp, rewrite };
}

/**
 * Cache headers that match the URLs above.
 *
 * The pairing is the point, and each half is wrong without the other:
 *
 *   a request carrying ?v=   the bytes at this URL can never change, because a
 *                            change would make it a different URL. Cache it for
 *                            a year and never revalidate.
 *   everything else          might change under the same name. Revalidate.
 *
 * `immutable` is what stops the browser sending a conditional request on every
 * navigation — without it a returning visitor still pays a round trip per asset
 * to be told nothing moved.
 *
 * Passed to `express.static` as `setHeaders` rather than mounted as a
 * middleware in front of it, and that is not a style choice: `express.static`
 * writes its own `Cache-Control` from its `maxAge` option, so a header set
 * before it is simply overwritten. This runs after, which is the only place it
 * survives.
 *
 * `res.req` because `setHeaders` is handed the response and the path, not the
 * request — and the version lives in the query string.
 */
function staticCache(res) {
  const query = res.req && res.req.query;
  if (query && query.v) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

module.exports = { assetVersions, staticCache };
