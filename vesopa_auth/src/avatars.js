/**
 * Profile pictures: taken from the provider where there is one, uploaded where
 * there is not.
 *
 * THE PICTURE IS COPIED, NOT LINKED, and that is the important decision.
 *
 * Google and GitHub both hand over a URL on their own servers, and it is
 * tempting to store the URL and be done. Three reasons not to:
 *
 *   1. Every page showing the avatar would tell Google or GitHub that this
 *      person is on a Vesopa page right now. We would be leaking our users'
 *      browsing to a third party to save ourselves a download.
 *   2. The Content-Security-Policy on this site is `img-src 'self' data:`.
 *      Remote avatars would need that opened up, on the one origin where the
 *      sign-in form lives.
 *   3. Those URLs rot. A person changes their Google picture and the old URL
 *      404s, leaving a broken image where their face was.
 *
 * So the image is fetched once, checked, and written into our own uploads
 * directory.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('./db');

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT = 8000;

const TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function ensureDirectory() {
  fs.mkdirSync(UPLOADS, { recursive: true });
}

/**
 * Is this URL safe to fetch?
 *
 * The URL comes from an identity provider rather than from a user, so this is
 * defence in depth rather than the main event — but "fetch whatever this JSON
 * says" is how server-side request forgery starts, and a provider that is
 * compromised or simply wrong should not be able to make this server open a
 * connection to something on its own network.
 */
function safeToFetch(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) || // no bare IPs: a name is expected here
    host === '[::1]'
  ) {
    return null;
  }
  return url;
}

/** Write the bytes and point the user row at them. Returns the public path. */
async function store(userId, publicId, buffer, contentType) {
  const extension = TYPES[String(contentType).split(';')[0].trim().toLowerCase()];
  if (!extension) throw new Error(`unsupported image type: ${contentType}`);
  if (!buffer || !buffer.length || buffer.length > MAX_BYTES) {
    throw new Error('image is empty or too large');
  }

  ensureDirectory();

  /*
   * A random suffix in the filename, not just the user id.
   *
   * Without it the path is guessable from the public id, so anybody who knows
   * somebody's Vesopa id could fetch their photograph. It also means a new
   * upload lands at a new URL, so nobody's browser shows them the old picture
   * out of its cache.
   */
  const name = `${publicId}-${crypto.randomBytes(8).toString('hex')}${extension}`;
  fs.writeFileSync(path.join(UPLOADS, name), buffer, { mode: 0o644 });

  const previous = await db.one('SELECT avatar_path FROM users WHERE id = ?', [userId]);
  const publicPath = `/uploads/avatars/${name}`;
  await db.execute('UPDATE users SET avatar_path = ? WHERE id = ?', [publicPath, userId]);

  // Tidy up the one it replaced. Failure here is not worth an error: a stray
  // file costs some disk, a thrown exception costs the person their upload.
  if (previous && previous.avatar_path && previous.avatar_path.startsWith('/uploads/avatars/')) {
    try {
      fs.unlinkSync(path.join(UPLOADS, path.basename(previous.avatar_path)));
    } catch {
      /* already gone, or never there */
    }
  }

  return publicPath;
}

/**
 * Copy a provider's picture.
 *
 * Never throws. A missing profile picture must not be able to stop somebody
 * signing in — this runs at the end of account creation, when they are already
 * authenticated and waiting.
 */
async function storeFromUrl(userId, publicId, value) {
  const url = safeToFetch(value);
  if (!url) return null;

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { accept: 'image/*' },
    });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!TYPES[contentType.split(';')[0].trim().toLowerCase()]) return null;

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    // Checked again after the download: content-length is a claim, and a
    // provider serving a very large image should cost us nothing.
    if (buffer.length > MAX_BYTES) return null;

    return await store(userId, publicId, buffer, contentType);
  } catch (error) {
    console.warn('[avatars] could not copy provider picture:', error.message);
    return null;
  }
}

/**
 * Microsoft is the awkward one: no picture in the ID token.
 *
 * The photograph lives behind Microsoft Graph and needs an access token and the
 * User.Read scope. A personal account often has no photo at all, and Graph
 * answers 404 — which is normal and not an error.
 */
async function storeFromMicrosoftGraph(userId, publicId, accessToken) {
  if (!accessToken) return null;
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return null; // 404 simply means they have not set one

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_BYTES) return null;

    return await store(userId, publicId, buffer, contentType);
  } catch (error) {
    console.warn('[avatars] could not fetch Microsoft photo:', error.message);
    return null;
  }
}

/** Remove the picture entirely. */
async function clear(userId) {
  const row = await db.one('SELECT avatar_path FROM users WHERE id = ?', [userId]);
  await db.execute("UPDATE users SET avatar_path = '' WHERE id = ?", [userId]);
  if (row && row.avatar_path && row.avatar_path.startsWith('/uploads/avatars/')) {
    try {
      fs.unlinkSync(path.join(UPLOADS, path.basename(row.avatar_path)));
    } catch {
      /* already gone */
    }
  }
}

module.exports = { store, storeFromUrl, storeFromMicrosoftGraph, clear, MAX_BYTES, TYPES };
