/**
 * An application's logo.
 *
 * `applications.logo_path` has been in the schema since the first day and the
 * consent screen has always rendered it — with a fallback to Vesopa's own mark
 * when it is empty. Nothing ever SET it, so every consent screen showed the
 * fallback and every application looked identical to the person being asked.
 *
 * THAT IS A SECURITY PROBLEM AS WELL AS A COSMETIC ONE. The consent screen is
 * where somebody decides whether to hand an application their email address,
 * and the only things on it that identify the application are its name, its
 * links and its mark. A screen with no mark is one a person skims; worse, when
 * every application looks the same, none of them looks unfamiliar — which is
 * exactly the recognition that ought to make somebody stop.
 *
 * The rules are avatars.js's rules, for the same reasons: stored here rather
 * than hot-linked, because `img-src` on this origin is `'self' data:` and
 * opening it up on the domain that holds the sign-in form to save a download is
 * not a trade worth making. And a remote logo would tell the developer's server
 * every time anybody sees a Vesopa consent screen.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('./db');

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads', 'logos');

/*
 * Smaller than an avatar's allowance. A logo is drawn at 48 pixels on the
 * consent screen and 34 in a list; anything approaching a megabyte is a
 * photograph somebody has uploaded by mistake, and it is kinder to refuse it
 * than to serve it to every person who ever signs into that application.
 */
const MAX_BYTES = 512 * 1024;

/*
 * No GIF, and no SVG.
 *
 * SVG is the one that matters: it is a document, not an image. It can carry
 * script, and it is served from this origin — so an SVG logo is a stored
 * cross-site scripting hole on the domain that holds every Vesopa session,
 * uploaded through a form we hand to third-party developers. Every image
 * pipeline that has been caught out by this allowed SVG "because it scales".
 *
 * GIF is excluded for a duller reason: an animated logo on a consent screen is
 * a way to draw the eye away from the sentence that says what is being granted.
 */
const TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/**
 * What the bytes actually are, rather than what the upload claimed.
 *
 * `Content-Type` is chosen by whoever is uploading. Checking the magic number
 * is what stops a file called `logo.png`, declared as `image/png`, containing
 * something else entirely — and it costs four bytes of comparison.
 */
function sniff(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function store(applicationId, clientId, buffer, declaredType) {
  if (!buffer || !buffer.length) throw new Error('empty image');
  if (buffer.length > MAX_BYTES) throw new Error('image is too large');

  const actual = sniff(buffer);
  if (!actual) throw new Error('unsupported image type');
  // Both must agree. A mismatch is either a broken client or somebody probing.
  if (TYPES[String(declaredType).split(';')[0].trim().toLowerCase()] !== TYPES[actual]) {
    throw new Error('unsupported image type');
  }

  fs.mkdirSync(UPLOADS, { recursive: true });

  /*
   * A random suffix, so a new upload lands at a new URL. Without it a
   * developer who replaces their logo sees the old one for as long as anybody's
   * browser has it cached — including, most confusingly, their own.
   */
  const name = `${clientId}-${crypto.randomBytes(6).toString('hex')}${TYPES[actual]}`;
  fs.writeFileSync(path.join(UPLOADS, name), buffer, { mode: 0o644 });

  const previous = await db.one('SELECT logo_path FROM applications WHERE id = ?', [applicationId]);
  const publicPath = `/uploads/logos/${name}`;
  await db.execute('UPDATE applications SET logo_path = ? WHERE id = ?', [
    publicPath,
    applicationId,
  ]);

  remove(previous && previous.logo_path);
  return publicPath;
}

/** Delete a stored file, quietly. A stray file costs disk; a throw costs an upload. */
function remove(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/logos/')) return;
  try {
    fs.unlinkSync(path.join(UPLOADS, path.basename(publicPath)));
  } catch {
    /* already gone, or never there */
  }
}

async function clear(applicationId) {
  const previous = await db.one('SELECT logo_path FROM applications WHERE id = ?', [applicationId]);
  await db.execute("UPDATE applications SET logo_path = '' WHERE id = ?", [applicationId]);
  remove(previous && previous.logo_path);
}

module.exports = { store, clear, MAX_BYTES, TYPES, sniff };
