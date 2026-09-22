/**
 * Cache-busting for the browser assets.
 *
 * WHY THIS EXISTS.
 *
 * `express.static` serves everything under public/ with `max-age=7d` in
 * production, and the URLs carry no version. That combination means a deploy
 * that changes a stylesheet or a script does NOT reach anybody who has visited
 * before: their browser keeps the old copy for up to a week and never asks.
 *
 * The failure is quiet and it is worse than a plain stale page, because HTML is
 * not cached. A returning customer gets NEW markup with OLD CSS and OLD
 * JavaScript — so a page can render with elements that the stylesheet has never
 * heard of, and a script can look for markup that is no longer there. It looks
 * like a bug in the release, it cannot be reproduced by whoever shipped it
 * (their cache is warm with the new files), and "try a hard refresh" is the
 * support answer nobody should ever have to give.
 *
 * The fix is a version in the URL. `/assets/css/app.css?v=k3f9a1` is a
 * different URL from `?v=9b2c04`, so a changed stamp is fetched and an
 * unchanged one is still served from cache. The long max-age is then correct
 * rather than dangerous.
 *
 * ONE STAMP FOR EVERYTHING, not one per file. It is the newest modification
 * time under public/assets, so it changes when anything changes. Per-file
 * hashes would re-fetch less on a deploy that touched one file — a saving of a
 * few kilobytes, once, against having to hash every asset at boot and keep a
 * manifest in step. Not worth it for a site this size.
 *
 * Computed once at startup. The assets cannot change under a running process
 * without a deploy, and a deploy restarts it.
 */

const fs = require('node:fs');
const path = require('node:path');

const ASSET_ROOT = path.join(__dirname, '..', 'public', 'assets');

function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* a file that vanished mid-walk is not worth failing a boot over */
      }
    }
  }
  return newest;
}

/*
 * Base 36 keeps it short and URL-safe. Falling back to the boot time means a
 * stamp still changes on every deploy even if the walk finds nothing — which is
 * the safe direction to fail in: too many fetches, never a stale one.
 */
const VERSION = Math.round(newestMtime(ASSET_ROOT) || Date.now()).toString(36);

/**
 * @param {string} url  an absolute path under /assets, e.g. '/assets/css/app.css'
 * @returns the same path with the version appended
 */
function asset(url) {
  if (!url) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + VERSION;
}

module.exports = { asset, VERSION, ASSET_ROOT };
