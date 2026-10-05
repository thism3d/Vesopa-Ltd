/**
 * Our own Windows installers, beside the Microsoft Store (2026-10-05).
 *
 * "I think for a time being if we just store the exe on a drive or cloud that
 * I can access to download and install. If anyone has an issue I can
 * downgrade them or upgrade." (Nicki Tidbell)
 *
 * Built and signed on the owner's PC (tool/build-installers.ps1), copied to
 * this box and registered by scripts/add-release.js. Every version stays, so
 * a downgrade is installing an older one, by hand from Downloads or by the
 * app itself once its venue is set to that version under Versions.
 *
 * Two ways a file leaves here:
 *   /downloads/:id          a signed-in admin with releases.download
 *   /dl/:id/:sig/:file      a device told to update. The signature is an HMAC
 *                           of the release, so the address works without a
 *                           sign-in and cannot be guessed or walked.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');

/** The apps, in the order Downloads lists them. `role` is the roles.js app. */
const APPS = [
  { key: 'till', label: 'Vesopa EPOS (till)', short: 'Till', role: 'epos' },
  { key: 'kitchen', label: 'Vesopa Kitchen', short: 'Kitchen', role: 'epos' },
  { key: 'display', label: 'Vesopa Customer Display', short: 'Display', role: 'epos' },
  { key: 'express', label: 'Vesopa Express (kiosk)', short: 'Express', role: 'epos' },
  { key: 'loyalty', label: 'Vesopa Loyalty', short: 'Loyalty', role: 'loyalty' },
];
const BY_KEY = Object.fromEntries(APPS.map((a) => [a.key, a]));

function normalise(v) {
  const parts = String(v || '').trim().split('+')[0].split('.').map((p) => Number.parseInt(p, 10));
  if (!parts.length || parts.length > 4 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join('.');
}

/** Newest first. */
function byVersion(a, b) {
  const x = a.version.split('.').map(Number);
  const y = b.version.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] || 0) - (x[i] || 0);
    if (d) return d;
  }
  return 0;
}

const safeFile = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.exe$/.test(String(name || ''));

async function list({ app = null, withdrawn = false } = {}) {
  const where = [];
  const params = [];
  if (app) { where.push('app = ?'); params.push(app); }
  if (!withdrawn) where.push('withdrawn_at IS NULL');
  const rows = await db.all(`SELECT * FROM adm_releases ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);
  return rows.sort(byVersion);
}

async function get(id) {
  return db.one('SELECT * FROM adm_releases WHERE id = ?', [Number(id) || 0]);
}

async function find(app, version) {
  return db.one('SELECT * FROM adm_releases WHERE app = ? AND version = ? AND withdrawn_at IS NULL', [app, normalise(version)]);
}

function fileOf(release) {
  return path.join(config.RELEASES_DIR, release.app, release.file);
}

function sign(release) {
  if (!config.RELEASES_SECRET) return null;
  return crypto.createHmac('sha256', config.RELEASES_SECRET)
    .update(`${release.id}:${release.sha256}`).digest('hex').slice(0, 40);
}

/** The address a device is given. Null until RELEASES_SECRET is set. */
function deviceUrl(release) {
  const sig = sign(release);
  return sig ? `${config.BASE_URL}/dl/${release.id}/${sig}/${encodeURIComponent(release.file)}` : null;
}

function signatureOk(release, sig) {
  const want = sign(release);
  if (!want || typeof sig !== 'string' || sig.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Put an uploaded installer in place and record it. Used by
 * scripts/add-release.js on the box; refuses to replace a version that is
 * already there, because a device may be part way through fetching it and its
 * hash is already in the back office.
 */
async function add({ app, version, source, signed = false, notes = null, by = null }) {
  if (!BY_KEY[app]) throw new Error(`No app called ${app}. One of: ${APPS.map((a) => a.key).join(', ')}.`);
  const v = normalise(version);
  if (!v) throw new Error(`${version} is not a version number.`);
  const file = path.basename(source);
  if (!safeFile(file)) throw new Error(`${file}: an installer is a .exe with a plain name.`);
  const existing = await db.one('SELECT * FROM adm_releases WHERE app = ? AND version = ?', [app, v]);
  if (existing) throw new Error(`${BY_KEY[app].short} ${v} is already there (added ${existing.added_at}). Bump the version.`);
  const dir = path.join(config.RELEASES_DIR, app);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists.`);
  fs.copyFileSync(source, dest);
  const size = fs.statSync(dest).size;
  const sha256 = await sha256Of(dest);
  const r = await db.run(
    'INSERT INTO adm_releases (app, version, file, size, sha256, signed, notes, added_by) VALUES (?,?,?,?,?,?,?,?)',
    [app, v, file, size, sha256, signed ? 1 : 0, notes ? String(notes).slice(0, 4000) : null, by]
  );
  return get(r.insertId);
}

async function withdraw(id, back = false) {
  await db.run(`UPDATE adm_releases SET withdrawn_at = ${back ? 'NULL' : 'UTC_TIMESTAMP()'} WHERE id = ?`, [Number(id)]);
}

const size = (bytes) => `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;

module.exports = { APPS, BY_KEY, normalise, byVersion, list, get, find, fileOf, deviceUrl, signatureOk, sha256Of, add, withdraw, size, safeFile };
