/**
 * Is the running server actually serving the files that are on its disk?
 *
 *     node tool/check-deployed.js [https://backoffice.vesopaepos.com]
 *
 * WHY THIS EXISTS
 *
 * Because uploading `public/` is not deploying it, and the failure is silent.
 *
 * The shell is read once at start-up and every asset URL in it is stamped with
 * a hash of that file's contents (see src/assets.js -- it exists because an
 * iPad went on serving a stylesheet from days earlier and no gesture on iOS
 * reliably clears that). Two consequences follow, and the second one is the
 * trap:
 *
 *   1. A change to `index.html` is not served until pm2 restarts, because the
 *      shell is a constant.
 *   2. A change to `app.js` IS on disk and IS served to anyone who asks for it
 *      -- but the shell still names the OLD hash, so every browser that already
 *      has `/app.js?v=<old>` keeps using its cached copy. Nothing looks broken.
 *      curl fetches the new file happily. The people using the back office see
 *      last week's code.
 *
 * That is a whole afternoon of "I deployed it, why can't I see it", and it has
 * now happened twice: the Gym page shipped invisible because index.html was
 * uploaded without a restart, and the fix for it was equally invisible for the
 * same reason.
 *
 * WHAT IT DOES
 *
 * Hashes the local files the same way the server does, fetches the live shell,
 * and compares the two. Anything that differs is a file the running process has
 * not picked up.
 *
 * Exit code 1 when a restart is needed, so it can go in a deploy script.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'https://backoffice.vesopaepos.com';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// The same set src/assets.js versions, and the same hash. Kept deliberately
// small rather than imported: this has to be able to run against a server whose
// code is a different version from this checkout, which is exactly the state it
// is diagnosing.
const VERSIONED = new Set(['.css', '.js', '.mjs']);

function hashFile(file) {
  return crypto
    .createHash('sha1')
    .update(fs.readFileSync(file))
    .digest('hex')
    .slice(0, 10);
}

function localVersions() {
  const versions = new Map();
  for (const entry of fs.readdirSync(PUBLIC_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!VERSIONED.has(path.extname(entry.name).toLowerCase())) continue;
    versions.set(`/${entry.name}`, hashFile(path.join(PUBLIC_DIR, entry.name)));
  }
  return versions;
}

async function main() {
  const shell = await fetch(BASE, { headers: { 'Cache-Control': 'no-cache' } })
    .then((r) => r.text());

  const served = new Map();
  for (const m of shell.matchAll(/(?:href|src)="(\/[^"?]+)\?v=([a-f0-9]+)"/g)) {
    served.set(m[1], m[2]);
  }

  const local = localVersions();
  const stale = [];

  for (const [file, hash] of local) {
    const live = served.get(file);
    if (live === undefined) continue; // not referenced by the shell
    if (live !== hash) stale.push({ file, live, hash });
  }

  // The shell itself, which carries no version of its own. Compared on a marker
  // rather than byte-for-byte, because the served copy has been rewritten.
  const localShell = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const localViews = [...localShell.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  const servedViews = [...shell.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  const missingViews = localViews.filter((v) => !servedViews.includes(v));

  console.log(`\n${BASE}\n`);

  if (!stale.length && !missingViews.length) {
    console.log('  ok  the running server is serving what is on its disk');
    console.log(`      ${local.size} versioned assets, ${servedViews.length} views\n`);
    return;
  }

  for (const s of stale) {
    console.log(`  STALE  ${s.file}`);
    console.log(`         on disk ${s.hash}, the shell still names ${s.live}`);
    console.log('         browsers holding the old URL will not refetch it');
  }
  if (missingViews.length) {
    console.log(`  STALE  index.html — the served shell is missing: ${missingViews.join(', ')}`);
  }

  console.log(
    '\n  The process has not re-read public/. Restart it:\n' +
      '    pm2 restart vesopa_backoffice\n'
  );
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
