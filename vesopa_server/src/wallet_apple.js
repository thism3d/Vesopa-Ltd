const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http2 = require('http2');
const { execFileSync } = require('child_process');
const { WalletError, PASS_TYPES } = require('./wallet_google');

/**
 * The Apple half of the pass system: signing a .pkpass, and the PassKit web
 * service that lets a pass already on someone's phone learn that its points
 * or balance changed without the customer doing anything.
 *
 * Where wallet_google.js hands Google a class and an object over REST and
 * gets a save link back, Apple has no server of its own to call: this module
 * builds the whole package — pass.json, artwork, manifest.json, a detached
 * PKCS#7 signature — as a zip, and *we* are the server a phone talks to
 * afterwards.
 *
 * Three things Apple requires that Google does not:
 *
 *   the file itself must be signed        a byte-for-byte manifest of every
 *                                          file in the package, signed with
 *                                          the pass type certificate, or
 *                                          Wallet refuses to install it.
 *   a place a phone can ask "what changed"  webServiceURL + authenticationToken
 *                                          in pass.json point a phone at
 *                                          walletApplePublicRoutes below.
 *   a way to tell a phone to ask           APNs. A Pass Type ID certificate
 *                                          doubles as its own push credential
 *                                          — no separate push cert or .p8 key
 *                                          is needed, which is the one mercy
 *                                          in this half of the integration.
 */

const PUSH_HOST = 'api.push.apple.com';
const PUSH_PORT = 443;

// Vesopa's own artwork, used when a venue has not set a logo of its own or
// when theirs cannot be fetched. A pass with no icon.png does not install at
// all, so there has to be something here that always works.
const ASSET_DIR = path.join(__dirname, '..', '..', 'passes_and_oauth', 'assets');
const ASSET_FILES = ['icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png'];

// How long a fetched merchant logo is reused before being fetched again. A
// venue changing its logo sees it on cards minted after this; without the
// cache every single mint would hit their CDN.
const LOGO_TTL_MS = 60 * 60 * 1000;
const LOGO_MAX_BYTES = 1024 * 1024;

/**
 * Reads the Apple credentials out of the environment.
 *
 * Never throws on a missing configuration, for the same reason wallet_google's
 * readConfig does not: an office with Apple Wallet unset must still be able to
 * sell, and the routes answer 503 with a reason instead.
 */
function readConfig(env = process.env) {
  const problems = [];
  const dir = String(
    env.APPLE_WALLET_DIR || path.join(__dirname, '..', '..', 'passes_and_oauth')
  ).trim();
  const p12Path = String(
    env.APPLE_WALLET_P12 || path.join(dir, 'Vesopa Software Ltd Pass Key.p12')
  );
  const p12Password = String(env.APPLE_WALLET_P12_PASSWORD || '');
  const wwdrPath = String(env.APPLE_WWDR_CERT || path.join(dir, 'wwdr.pem'));
  const teamIdentifier = String(env.APPLE_TEAM_IDENTIFIER || 'G238FR2ZC9').trim();
  const organizationName = String(env.APPLE_WALLET_ORG_NAME || 'Vesopa').trim();
  // The pass update web service. Apple requires https:// with no query string,
  // and refuses to poll it at all if it is missing — a pass with no
  // webServiceURL never learns its balance changed.
  const webServiceBase = String(env.BACKOFFICE_URL || '').replace(/\/+$/, '');

  if (!p12Password) problems.push('APPLE_WALLET_P12_PASSWORD is not set');
  if (!fs.existsSync(p12Path)) problems.push(`No signing key at "${p12Path}"`);
  if (!fs.existsSync(wwdrPath)) {
    problems.push(
      `No WWDR intermediate at "${wwdrPath}" — see passes_and_oauth/README.md to fetch it`
    );
  }
  if (!webServiceBase || !/^https:\/\//i.test(webServiceBase)) {
    problems.push('BACKOFFICE_URL must be a public https:// address (Apple polls it for updates)');
  }

  const certFiles = {};
  for (const [kind, t] of Object.entries(PASS_TYPES)) {
    const p = path.join(dir, t.appleCertFile);
    if (!fs.existsSync(p)) problems.push(`No certificate for "${kind}" at "${p}"`);
    certFiles[kind] = p;
  }

  return {
    dir,
    p12Path,
    p12Password,
    wwdrPath,
    teamIdentifier,
    organizationName,
    webServiceBase,
    certFiles,
    configured: problems.length === 0,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The keyring: the .p12's private key and each kind's certificate, extracted
// once to PEM files a subprocess can point openssl at. Node has no built-in
// PKCS#12 or PKCS#7 support, so both extraction and signing shell out.
// ---------------------------------------------------------------------------

/**
 * Pulls the private key out of the .p12, as PEM.
 *
 * Keychain exports a .p12 with the old RC2/3DES algorithms, which OpenSSL 3
 * refuses unless told `-legacy` — and which OpenSSL 1.x and LibreSSL read
 * happily but reject the flag for, because it does not exist there. Both
 * toolchains are in play (a Mac in front of this code, Linux behind it), so
 * the flag is tried and then dropped rather than guessed at from a version
 * string.
 *
 * The password goes through an environment variable rather than an argument,
 * so it never appears in `ps` output.
 */
function extractKey(config) {
  const args = ['pkcs12', '-in', config.p12Path, '-nocerts', '-nodes', '-passin', 'env:VESOPA_P12_PW'];
  const options = { env: { ...process.env, VESOPA_P12_PW: config.p12Password } };
  try {
    // stderr silenced only here: an openssl that has no -legacy answers with
    // its whole usage message, which is noise rather than a fault.
    return execFileSync('openssl', [...args.slice(0, 5), '-legacy', ...args.slice(5)], {
      ...options,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return execFileSync('openssl', args, options);
  }
}

/**
 * Materialises the keyring for one config, in a private temp directory.
 *
 * Cached on the config object: a keyring is expensive to build (one openssl
 * process per certificate) and cheap to reuse for the life of the server.
 */
function loadKeyring(config) {
  if (config._keyring) return config._keyring;
  if (!config.configured) {
    throw new WalletError(`Apple Wallet is not configured: ${config.problems.join('; ')}`, 503);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesopa-wallet-apple-'));
  const keyPemPath = path.join(dir, 'key.pem');
  fs.writeFileSync(keyPemPath, extractKey(config), { mode: 0o600 });

  const certPemPaths = {};
  for (const [kind, certPath] of Object.entries(config.certFiles)) {
    const outPath = path.join(dir, `${kind}.pem`);
    const pem = execFileSync('openssl', ['x509', '-inform', 'der', '-in', certPath]);
    fs.writeFileSync(outPath, pem);
    certPemPaths[kind] = outPath;
  }

  const keyring = { dir, keyPemPath, certPemPaths, wwdrPath: config.wwdrPath };
  config._keyring = keyring;
  return keyring;
}

/** A detached PKCS#7 signature over `data`, DER-encoded, the way Wallet wants it. */
function signManifest(keyring, kind, data) {
  const certPath = keyring.certPemPaths[kind];
  if (!certPath) throw new WalletError(`Unknown pass kind "${kind}"`, 400);
  return execFileSync(
    'openssl',
    [
      'smime', '-sign', '-binary', '-noattr',
      '-signer', certPath,
      '-inkey', keyring.keyPemPath,
      '-certfile', keyring.wwdrPath,
      '-outform', 'DER',
    ],
    { input: data, maxBuffer: 16 * 1024 * 1024 }
  );
}

// ---------------------------------------------------------------------------
// pass.json — the same subject shape loadSubject() in wallet.js already
// produces for Google, laid out for Apple's fields instead.
// ---------------------------------------------------------------------------

/** "#a5c715" -> "rgb(165, 199, 21)". Apple takes rgb(), never hex. */
function hexToRgb(hex, fallbackHex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const h = m ? m[1] : fallbackHex;
  const n = parseInt(h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** A stable serial per office+kind+subject, so re-issuing updates the same pass. */
function serialFor(office, kind, subjectId) {
  return crypto.createHash('sha1').update(`${office}:${kind}:${String(subjectId)}`).digest('hex');
}

/** A fresh authentication token. Generated once per pass and then kept forever
 * — see mint() in wallet.js. Changing it after a phone has registered breaks
 * that phone's ability to fetch updates, because it keeps sending the old one. */
function newAuthToken() {
  return crypto.randomBytes(16).toString('hex');
}

function fields(pairs) {
  return pairs
    .filter(([, , v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([key, label, value]) => ({ key, label, value }));
}

function barcodes(value) {
  if (!value) return undefined;
  const message = String(value);
  return [
    { format: 'PKBarcodeFormatQR', message, messageEncoding: 'iso-8859-1', altText: message },
    { format: 'PKBarcodeFormatCode128', message, messageEncoding: 'iso-8859-1', altText: message },
  ];
}

/** backFields shared by every kind: how to reach the venue, and the terms. */
function backFields(brand, subject, extra = []) {
  return fields([
    ['website', 'Website', brand.homepage_url],
    ['phone', 'Contact', brand.support_phone],
    ...extra,
    ['terms', 'Terms', brand.terms],
  ]);
}

/**
 * Builds pass.json for one pass. Mirrors buildPass() in wallet_google.js in
 * shape and inputs, but the two cannot share a body: Apple's fields nest under
 * one of storeCard/generic/coupon and Google's are flat resources.
 */
function buildPassJson({ kind, config, brand = {}, subject = {}, serialNumber, authenticationToken }) {
  const t = PASS_TYPES[kind];
  if (!t) throw new WalletError(`Unknown pass kind "${kind}"`, 400);

  const issuerName = brand.issuer_name || config.organizationName;
  const programName = brand.program_name || issuerName;
  const barcodeValue = subject.card_number || subject.id;

  const pass = {
    formatVersion: 1,
    passTypeIdentifier: t.appleType,
    teamIdentifier: config.teamIdentifier,
    serialNumber,
    organizationName: issuerName,
    description: `${issuerName} ${t.label}`,
    logoText: programName,
    backgroundColor: hexToRgb(brand.hex_background, '111111'),
    foregroundColor: 'rgb(242, 244, 240)',
    labelColor: 'rgb(165, 199, 21)',
    webServiceURL: `${config.webServiceBase}/apple-wallet`,
    authenticationToken,
    barcodes: barcodes(barcodeValue),
  };

  if (subject.expires_on) pass.expirationDate = `${subject.expires_on}T23:59:59Z`;
  if (subject.state === 'EXPIRED' || subject.state === 'INACTIVE') pass.voided = true;

  const body = { headerFields: [] };

  if (kind === 'loyalty') {
    body.primaryFields = fields([['points', 'Points', Number(subject.points || 0)]]);
    body.secondaryFields = fields([
      ['member', 'Member', subject.name],
      ['tier', 'Tier', subject.tier],
    ]);
    body.auxiliaryFields = fields([
      ['number', 'Member no.', subject.member_no],
      ['discount', 'Your discount', subject.discount],
    ]);
    body.backFields = backFields(brand, subject, [['since', 'Member since', subject.member_since]]);
  } else if (kind === 'customer') {
    body.primaryFields = fields([['member', 'Member', subject.name]]);
    body.secondaryFields = fields([
      ['number', 'Member no.', subject.member_no],
      ['tier', 'Tier', subject.tier],
    ]);
    body.auxiliaryFields = fields([['discount', 'Your discount', subject.discount]]);
    body.backFields = backFields(brand, subject, [['since', 'Member since', subject.member_since]]);
  } else if (kind === 'giftcard') {
    const money = `${subject.currency === 'GBP' || !subject.currency ? '£' : subject.currency + ' '}${(
      Number(subject.balance_minor || 0) / 100
    ).toFixed(2)}`;
    body.primaryFields = fields([['balance', 'Balance', money]]);
    body.secondaryFields = fields([['for', 'For', subject.name]]);
    body.auxiliaryFields = fields([['expires', 'Expires', subject.expires_on]]);
    body.backFields = backFields(brand, subject, [['issued', 'Issued', subject.issued_on]]);
  } else if (kind === 'staff') {
    body.primaryFields = fields([['name', 'Staff', subject.name]]);
    body.secondaryFields = fields([['role', 'Role', subject.role]]);
    body.auxiliaryFields = fields([['number', 'Card', subject.card_number]]);
    body.backFields = backFields(brand, subject);
  } else if (kind === 'promo') {
    body.primaryFields = fields([['offer', 'Offer', subject.title]]);
    body.secondaryFields = fields([['detail', '', subject.details]]);
    body.auxiliaryFields = fields([['ends', 'Ends', subject.ends_on]]);
    body.backFields = backFields(brand, subject);
  }

  pass[t.appleStyle] = body;
  return pass;
}

// ---------------------------------------------------------------------------
// The zip. STORE (no compression) rather than DEFLATE: the manifest hashes
// the uncompressed bytes either way, so compression buys nothing but a CRC
// table this file would otherwise not need, and a `.pkpass` is a handful of
// small PNGs and a page of JSON — there is nothing here worth shrinking.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** `files` is `{ name: Buffer }`. Returns the whole .pkpass as one Buffer. */
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * A PNG's dimensions, read straight out of the IHDR chunk that every PNG
 * begins with. Eight bytes of signature, then a chunk header, then width and
 * height as big-endian 32-bit integers — which is the whole reason this does
 * not need an image library.
 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const artworkCache = new Map();
function artwork(name) {
  if (!artworkCache.has(name)) {
    artworkCache.set(name, fs.readFileSync(path.join(ASSET_DIR, name)));
  }
  return artworkCache.get(name);
}

/**
 * The venue's own logo, as PNG bytes, or null to fall back to Vesopa's.
 *
 * Refused rather than embedded when it is not a PNG: Apple's pass format
 * takes PNG only, and a JPEG renamed .png produces a pass that installs and
 * then shows a blank space where the logo was, which is worse than showing
 * the default. The magic number is checked rather than the file extension,
 * because the extension is whatever the merchant typed.
 *
 * Anything that goes wrong here — unreachable host, a redirect to an HTML
 * error page, a 4MB hero shot — returns null and the card still gets built.
 * A logo is not worth failing a customer's card over.
 */
const logoCache = new Map();
async function merchantLogo(url) {
  if (!/^https:\/\//i.test(String(url || ''))) return null;

  const hit = logoCache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;

  let data = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
      if (isPng && buf.length <= LOGO_MAX_BYTES) data = buf;
    }
  } catch {
    data = null;
  }

  logoCache.set(url, { data, expires: Date.now() + LOGO_TTL_MS });
  return data;
}

/**
 * Builds the signed .pkpass for one pass, as a Buffer.
 *
 * Everything a phone will hash is assembled first — pass.json plus the
 * bundled artwork — then manifest.json is built from their SHA-1s (SHA-1,
 * not SHA-256: this is the one place Apple still requires it, and always
 * has), and the manifest itself is what gets signed. The signature covers
 * the manifest, not the files directly, which is why a single-byte change to
 * pass.json without rebuilding the manifest fails silently on a phone rather
 * than loudly here.
 */
async function buildPkpass({ kind, config, brand = {}, subject, serialNumber, authenticationToken }) {
  const keyring = loadKeyring(config);
  const passJson = buildPassJson({ kind, config, brand, subject, serialNumber, authenticationToken });

  const files = {
    'pass.json': Buffer.from(JSON.stringify(passJson), 'utf8'),
  };
  for (const name of ASSET_FILES) files[name] = artwork(name);

  // The venue's logo replaces Vesopa's on the face of the card. Both @1x and
  // @2x are given the same bytes: Apple scales what it is handed, and a
  // merchant has one logo, not two.
  //
  // The icon is deliberately NOT replaced unless the logo is close to square.
  // icon.png is the one image a pass cannot install without, and it is shown
  // at 29x29 — a 4:1 wordmark squeezed into that slot is unreadable, and on
  // older iOS an icon far outside the expected proportions is a plausible
  // cause of a pass that silently refuses to install. A venue that wants its
  // own icon should upload a square logo.
  const logo = await merchantLogo(brand.logo_url);
  if (logo) {
    files['logo.png'] = logo;
    files['logo@2x.png'] = logo;
    const size = pngSize(logo);
    if (size && size.width / size.height >= 0.7 && size.width / size.height <= 1.4) {
      files['icon.png'] = logo;
      files['icon@2x.png'] = logo;
    }
  }

  const manifest = {};
  for (const [name, data] of Object.entries(files)) {
    manifest[name] = crypto.createHash('sha1').update(data).digest('hex');
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  files['manifest.json'] = manifestBuf;
  files['signature'] = signManifest(keyring, kind, manifestBuf);

  return zipStore(files);
}

// ---------------------------------------------------------------------------
// APNs. A push is nothing but "check for updates" — it carries no payload —
// so a phone that is offline when it arrives simply polls next time it can,
// which is why a failed push here is logged and swallowed rather than thrown:
// the pass will still update, only later than it could have.
// ---------------------------------------------------------------------------

/**
 * Sends one silent push. `pushToken` is what the device handed the
 * registration endpoint below; `kind` picks which pass type's certificate
 * authenticates the connection, because Apple ties a push credential to the
 * topic it is allowed to push — here, the pass type identifier itself.
 */
function push(config, kind, pushToken) {
  return new Promise((resolve) => {
    let keyring;
    try {
      keyring = loadKeyring(config);
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }

    const t = PASS_TYPES[kind];
    const client = http2.connect(`https://${PUSH_HOST}:${PUSH_PORT}`, {
      key: fs.readFileSync(keyring.keyPemPath),
      cert: fs.readFileSync(keyring.certPemPaths[kind]),
    });

    client.on('error', (e) => resolve({ ok: false, error: e.message }));

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${encodeURIComponent(pushToken)}`,
      'apns-topic': t.appleType,
      'apns-push-type': 'background',
      'content-type': 'application/json',
    });

    let status = 0;
    req.on('response', (headers) => {
      status = headers[':status'];
    });
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      client.close();
      resolve(status === 200 ? { ok: true } : { ok: false, error: body || `HTTP ${status}` });
    });
    req.on('error', (e) => {
      client.close();
      resolve({ ok: false, error: e.message });
    });

    req.end('{}');
  });
}

module.exports = {
  PUSH_HOST,
  ASSET_DIR,
  readConfig,
  loadKeyring,
  signManifest,
  buildPassJson,
  buildPkpass,
  serialFor,
  newAuthToken,
  hexToRgb,
  pngSize,
  zipStore,
  crc32,
  push,
};
