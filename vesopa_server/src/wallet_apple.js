const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const G = require('./wallet_google');

/**
 * Apple Wallet: building and signing a `.pkpass`.
 *
 * WHAT A .pkpass ACTUALLY IS
 *
 * A ZIP archive of small files, and nothing more clever than that:
 *
 *     pass.json        what the card says, and what it looks like
 *     icon.png @2x @3x the small mark, shown in notifications and the list
 *     logo.png  @2x    the mark across the top of the card
 *     strip.png @2x    the wide band of artwork behind the primary field
 *     manifest.json    a SHA-1 of every other file in the archive
 *     signature        a detached PKCS#7 of manifest.json
 *
 * The signature is what makes it a pass rather than a zip: iOS verifies it
 * against the Pass Type ID certificate, the Apple WWDR intermediate, and
 * Apple's root, and refuses the whole thing if any one of them is wrong. There
 * is no partial failure and no diagnostic — a bad pass is "Safari cannot
 * download this file", every time, whatever is wrong with it. That is why
 * everything below is strict and says exactly what it is missing.
 *
 * WHY THERE IS NO LIBRARY HERE
 *
 * Two dependencies would normally do this: one to sign PKCS#7 and one to write
 * a ZIP. Neither is in this project's dependencies, and adding them for eight
 * small files is not worth it — so the ZIP is written directly against `zlib`
 * (about eighty lines, and the format has not changed since 1989) and the
 * signature is handed to the `openssl` binary, which is on any machine that is
 * already terminating TLS.
 *
 * The alternative — a pure-JS CMS implementation — is a great deal more code in
 * the one place where being subtly wrong produces no error message at all.
 *
 * THE PRIVATE KEYS ARE NOT IN THIS REPOSITORY AND MUST NEVER BE
 *
 * `passes_and_oauth/` holds the five **public** certificates, which cannot sign
 * anything. Signing needs the matching private key, supplied at runtime as a
 * `.p12` per pass type plus Apple's WWDR intermediate — see [readConfig] for
 * the environment variables and `passes_and_oauth/README.md` for where they
 * come from.
 */

/** Apple's team identifier, from the certificates in `passes_and_oauth/`. */
const APPLE_TEAM_ID = 'G238FR2ZC9';

/**
 * Where the signing material is looked for.
 *
 * A directory of `.p12` files rather than five environment variables holding
 * base64: a key in an environment variable ends up in `ps`, in a crash report
 * and in a process dump, and rotating one means a redeploy. A directory can be
 * mode 0600, owned by the service user, and swapped without touching the app.
 */
function readConfig(env = process.env) {
  const dir = String(env.APPLE_WALLET_DIR || '').trim();
  const wwdr = String(env.APPLE_WWDR_CERT || '').trim();
  const passphrase = String(env.APPLE_WALLET_P12_PASSWORD || '');
  const webServiceUrl = String(env.APPLE_WALLET_WEB_SERVICE_URL || '').trim();

  // Where the public certificates live. They are committed, so this defaults to
  // them and a deployment normally sets only the two secrets above.
  const certDir = String(
    env.APPLE_WALLET_CERT_DIR ||
      path.join(__dirname, '..', '..', 'passes_and_oauth')
  ).trim();

  const problems = [];
  if (!dir) {
    problems.push('APPLE_WALLET_DIR is not set (the folder holding the .p12)');
  } else if (!existsSafely(dir)) {
    problems.push(`APPLE_WALLET_DIR points at ${dir}, which is not there`);
  }
  if (!wwdr) {
    problems.push('APPLE_WWDR_CERT is not set (Apple’s WWDR intermediate, PEM)');
  } else if (!existsSafely(wwdr)) {
    problems.push(`APPLE_WWDR_CERT points at ${wwdr}, which is not there`);
  }

  // Checked once here rather than discovered on the first customer who asks
  // for a pass. `openssl version` is cheap and its absence is fatal.
  let openssl = '';
  try {
    openssl = String(execFileSync('openssl', ['version'], { timeout: 5000 })).trim();
  } catch {
    problems.push('the `openssl` binary is not on PATH, so a pass cannot be signed');
  }

  // A shared bundle, if there is one. Keychain Access exports a certificate and
  // its key together as a .p12 and offers no way to export a bare private key,
  // so "one .p12 per pass type" means five exports — and all five CSRs came
  // from one keypair, which means one export is genuinely enough.
  //
  // The private key is taken from whichever bundle is present and paired with
  // the *public* certificate for the kind being signed, which is already in the
  // repository. See signingMaterial().
  const shared = dir && existsSafely(dir)
    ? findBundle(dir, { certDir, passphrase })
    : '';

  if (dir && existsSafely(dir) && !shared) {
    problems.push(
      `no .p12 in ${dir} holds the key for these pass certificates — check ` +
        `APPLE_WALLET_P12_PASSWORD, and that the bundle was exported from the ` +
        `certificate Apple issued rather than from another CSR`
    );
  }

  return {
    dir,
    certDir,
    shared,
    wwdr,
    passphrase,
    webServiceUrl,
    openssl,
    teamId: String(env.APPLE_TEAM_ID || APPLE_TEAM_ID).trim(),
    configured: problems.length === 0,
    problems,
  };
}

/**
 * The same answer, worked out once.
 *
 * [readConfig] opens every `.p12` in the wallet directory and shells out to
 * openssl twice per file to find the one whose key fits the certificates. That
 * is right at start-up and wrong on a request, so anything asking mid-flight —
 * the Google half, deciding whether an "Add to Apple Wallet" button would work
 * — asks this instead.
 *
 * Cached for the life of the process, which matches how the certificates are
 * treated everywhere else here: they are read when the server starts, and
 * swapping them is a restart.
 */
let cachedConfigValue = null;
function cachedConfig(env = process.env) {
  if (!cachedConfigValue) cachedConfigValue = readConfig(env);
  return cachedConfigValue;
}

/** Forget it. For tests. */
function resetConfig() {
  cachedConfigValue = null;
}

/**
 * The signing bundle in [dir]: the one whose key actually fits the
 * certificates.
 *
 * CHOSEN BY TESTING, NOT BY NAME
 *
 * This started out picking by filename and it picked the wrong file on the
 * first real folder it saw. That folder held two exports — one matching these
 * pass certificates and one from an unrelated CSR — and the wrong one sorted
 * first. Keychain Access names its exports after whatever was selected, so the
 * names carry no reliable information about which key is which.
 *
 * So every candidate is opened and its public half compared against a real
 * certificate. It costs two openssl calls per file, once, at start-up — against
 * the alternative, which is signing every pass with a key that does not belong
 * to its certificate and producing cards that install on nobody's phone and
 * report nothing anywhere.
 *
 * Returns '' when nothing matches, which [readConfig] turns into a problem the
 * back office can show. That is a far better failure than a plausible guess.
 */
function findBundle(dir, { certDir, passphrase }) {
  const named = [SHARED_P12, ...Object.values(P12_FILES)].map((n) =>
    path.join(dir, n)
  );

  let loose = [];
  try {
    loose = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.p12'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    loose = [];
  }

  // Named first, so a venue that has deliberately laid the folder out the
  // documented way gets the file it named — but still only if it verifies.
  const candidates = [...new Set([...named, ...loose])].filter(existsSafely);
  if (!candidates.length) return '';

  const reference = certificatePublicKey(certDir);
  if (!reference) {
    // No certificate to check against. Nothing can be verified, so the named
    // convention is all there is to go on.
    return candidates[0];
  }

  for (const candidate of candidates) {
    if (bundlePublicKey(candidate, passphrase) === reference) return candidate;
  }
  return '';
}

/**
 * Whether this openssl understands `-legacy`, worked out once by asking it.
 *
 * OpenSSL 3 needs the flag to read a Keychain-exported .p12 (RC2/3DES moved to
 * the legacy provider). OpenSSL 1.x and LibreSSL -- which is what macOS ships,
 * and what a developer's machine therefore runs -- have no such flag and fail
 * the whole command with a usage message when handed it.
 *
 * Both are real: OpenSSL 3.0 on the Debian box, 1.0.2/LibreSSL in front of it.
 * Guessing from `openssl version` means parsing a version string; asking the
 * binary what it accepts is shorter and cannot be wrong. The answer is cached
 * because it costs a process and cannot change while this one is running.
 */
let legacyFlagSupported = null;
function pkcs12LegacyArgs() {
  if (legacyFlagSupported === null) {
    try {
      execFileSync('openssl', ['pkcs12', '-help'], { stdio: 'pipe', timeout: 10000 });
      legacyFlagSupported = false;
    } catch (e) {
      // `pkcs12 -help` exits non-zero on every version; the usage text it
      // prints is what actually says whether the flag exists.
      const usage = String(e.stderr || '') + String(e.stdout || '');
      legacyFlagSupported = usage.includes('-legacy');
    }
  }
  return legacyFlagSupported ? ['-legacy'] : [];
}

/** The public half of one of the pass certificates, as a fingerprint. */
function certificatePublicKey(certDir) {
  for (const file of Object.values(CER_FILES)) {
    const cer = path.join(certDir, file);
    if (!existsSafely(cer)) continue;
    try {
      return fingerprint(
        execFileSync('openssl', ['x509', '-inform', 'DER', '-in', cer, '-pubkey', '-noout'], {
          stdio: 'pipe',
          timeout: 10000,
        })
      );
    } catch {
      // Try the next certificate; they all share one key.
    }
  }
  return '';
}

/**
 * The public half of a bundle's private key, or '' if it cannot be opened.
 *
 * The passphrase goes through the environment rather than the command line: an
 * argument is visible in `ps` to every account on the machine for as long as
 * the call runs.
 *
 * `-legacy` when the local openssl has it: a .p12 exported by macOS Keychain
 * is encrypted with 3DES, which OpenSSL 3 moved out of the default provider,
 * and without the flag a correct passphrase reads as an unsupported algorithm.
 * See pkcs12LegacyArgs() for why it cannot simply always be passed.
 */
function bundlePublicKey(bundle, passphrase) {
  try {
    const key = execFileSync(
      'openssl',
      ['pkcs12', '-in', bundle, '-nocerts', '-nodes', '-passin', 'env:VESOPA_P12_PASS',
       ...pkcs12LegacyArgs()],
      {
        stdio: 'pipe',
        timeout: 10000,
        env: { ...process.env, VESOPA_P12_PASS: passphrase || '' },
      }
    );
    return fingerprint(
      execFileSync('openssl', ['pkey', '-pubout'], {
        input: key,
        stdio: 'pipe',
        timeout: 10000,
      })
    );
  } catch {
    return '';
  }
}

const fingerprint = (buffer) =>
  crypto.createHash('sha256').update(String(buffer).trim()).digest('hex');

function existsSafely(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * The public certificate for each kind, as committed in `passes_and_oauth/`.
 */
const CER_FILES = {
  loyalty: 'loyalty_pass.cer',
  customer: 'membership_pass.cer',
  giftcard: 'giftcard_pass.cer',
  staff: 'staffcard_pass.cer',
  promo: 'promotion_pass.cer',
};

/**
 * The `.p12` for one kind of pass, and the one bundle that covers all five.
 *
 * Per-kind names match `passes_and_oauth/` — `loyalty_pass.p12` beside
 * `loyalty_pass.cer` — and are looked for first. `vesopa_wallet.p12` is the
 * simpler arrangement: one export from Keychain Access, whose private key signs
 * every kind because all five certificates were issued from one CSR.
 */
const SHARED_P12 = 'vesopa_wallet.p12';

const P12_FILES = {
  loyalty: 'loyalty_pass.p12',
  customer: 'membership_pass.p12',
  giftcard: 'giftcard_pass.p12',
  staff: 'staffcard_pass.p12',
  promo: 'promotion_pass.p12',
};

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/**
 * Apple wants `rgb(r, g, b)`, not `#RRGGBB`, and silently ignores a colour it
 * cannot parse — which presents as a card in the default white, not as an
 * error. So every colour goes through here.
 */
function rgb(hex, fallback) {
  const value = String(hex || '').trim().replace(/^#/, '');
  const full = value.length === 3
    ? value.split('').map((c) => c + c).join('')
    : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return fallback;
  const n = parseInt(full, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Vesopa's own palette, used wherever a venue has not chosen its own. */
const BRAND = {
  background: 'rgb(17, 17, 17)',
  foreground: 'rgb(242, 244, 240)',
  label: 'rgb(165, 199, 21)',
};

// ---------------------------------------------------------------------------
// pass.json
// ---------------------------------------------------------------------------

const money = (minor, currency) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currency || 'GBP',
  }).format((Number(minor) || 0) / 100);

/**
 * Build the `pass.json` for one card.
 *
 * The field layout differs per kind because the *question the holder is asking*
 * differs. Somebody opening a loyalty card wants their points; somebody opening
 * a gift card wants the balance and nothing else; somebody showing a staff card
 * wants their name legible across a room. The primary field is whichever of
 * those it is, because that is the one iOS renders large.
 *
 * The barcode is the same on all five, and that is the point of the whole
 * exercise: it carries the card number, so a phone at the counter scans to
 * exactly what a piece of plastic would.
 */
/**
 * The points ledger, written the way a customer reads it.
 *
 *     Earned      +12   ->  340      2 Sep, £24.50
 *
 * One line per movement, on the back of the card, because "why is my balance
 * that number" is the question staff are asked and cannot answer without going
 * to a screen. The arrow is the running balance after the movement, which is
 * what makes the list explain the number on the front rather than just
 * decorate it.
 */
function historyLines(history) {
  const WORD = { earn: 'Earned', redeem: 'Redeemed', adjust: 'Adjusted', expire: 'Expired' };
  return (history || [])
    .filter((h) => h && h.at)
    .map((h) => {
      const when = new Date(h.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const moved = `${h.points > 0 ? '+' : ''}${h.points}`;
      const spend = h.spend_minor ? `, ${money(h.spend_minor, 'GBP')}` : '';
      return `${WORD[h.kind] || h.kind}  ${moved} → ${h.balance_after}      ${when}${spend}`;
    })
    .join('\n');
}

/**
 * Where the venue is, so the card offers itself on the lock screen.
 *
 * iOS shows a pass on the lock screen when the phone is near one of these,
 * which is the single feature that turns a card somebody installed once into
 * a card they actually use. Silently ignored by Wallet when the coordinates
 * are absent, so a venue that has not set them loses nothing else.
 *
 * `maxDistance` is metres and deliberately generous: the point is to have the
 * card ready as somebody walks in, not to wait until they are at the counter.
 */
function relevantLocations(brand) {
  const lat = Number(brand.latitude);
  const lon = Number(brand.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return [{
    latitude: lat,
    longitude: lon,
    relevantText: `${brand.issuer_name || 'Your card'} — show this at the till`,
  }];
}

function buildPassJson({ kind, config, brand, subject, serial, authToken }) {
  const type = G.PASS_TYPES[kind];
  if (!type) throw new Error(`Unknown pass kind "${kind}"`);

  const background = rgb(brand.hex_background, BRAND.background);
  const foreground = rgb(brand.hex_foreground, BRAND.foreground);
  const label = rgb(brand.hex_label, BRAND.label);

  const organisation = brand.issuer_name || 'Vesopa';

  const pass = {
    formatVersion: 1,
    passTypeIdentifier: type.appleType,
    teamIdentifier: config.teamId,
    serialNumber: serial,
    organizationName: organisation,
    description: `${organisation} ${type.label}`,
    logoText: brand.program_name || organisation,

    backgroundColor: background,
    foregroundColor: foreground,
    labelColor: label,

    // The card number, and nothing decorative around it. `message` is what a
    // scanner reads; `altText` is what a human reads underneath when the
    // scanner will not cooperate, which at a busy counter it sometimes will
    // not.
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: String(subject.card_number || subject.id),
        messageEncoding: 'iso-8859-1',
        altText: String(subject.card_number || ''),
      },
      // Code 128 as well, because a supermarket-style laser scanner cannot read
      // a QR at all. iOS shows the first format the device supports and Apple
      // recommends listing both.
      {
        format: 'PKBarcodeFormatCode128',
        message: String(subject.card_number || subject.id),
        messageEncoding: 'iso-8859-1',
        altText: String(subject.card_number || ''),
      },
    ],
  };

  if (config.webServiceUrl) {
    // What lets a pass update itself in somebody's pocket. Both are required
    // together — Apple ignores one without the other — so they are set
    // together or not at all.
    pass.webServiceURL = config.webServiceUrl;
    pass.authenticationToken = authToken;
  }

  const back = [];
  const push = (list, key, label, value, extra) => {
    if (value === undefined || value === null || value === '') return;
    list.push({ key, label, value, ...(extra || {}) });
  };

  if (brand.homepage_url) {
    push(back, 'website', 'Website', brand.homepage_url);
  }
  if (brand.support_phone) {
    push(back, 'phone', 'Contact', brand.support_phone);
  }
  if (brand.terms) {
    push(back, 'terms', 'Terms', String(brand.terms));
  }

  const body = {
    headerFields: [],
    primaryFields: [],
    secondaryFields: [],
    auxiliaryFields: [],
    backFields: back,
  };

  // ---- The modern keys ------------------------------------------------------
  //
  // Everything below is optional in the format and ignored by Wallet when it is
  // absent, so a venue that has filled nothing in still gets a working card.

  // Where the card is useful. Puts it on the lock screen as somebody arrives.
  const locations = relevantLocations(brand);
  if (locations) {
    pass.locations = locations;
    pass.maxDistance = 150;
  }

  // What the card *means*, in Apple's own vocabulary rather than as display
  // text. Only tags Apple actually defines are set: a made-up key is ignored,
  // and a real key holding the wrong kind of thing is worse than none.
  const semantics = {};
  if (organisation) semantics.venueName = organisation;
  if (brand.support_phone) semantics.venuePhoneNumber = String(brand.support_phone);
  if (kind === 'giftcard' && Number.isFinite(Number(subject.balance_minor))) {
    // A currencyAmount, not a string: this is the form Siri and the Wallet
    // search field can read, and the one that survives a currency that is not
    // sterling.
    semantics.balance = {
      amount: (Number(subject.balance_minor) / 100).toFixed(2),
      currencyCode: subject.currency || 'GBP',
    };
  }
  if (Object.keys(semantics).length) pass.semantics = semantics;

  // A staff card identifies a person and should not be AirDropped to another.
  // Apple has no way to enforce that; this is the flag that asks.
  if (kind === 'staff') pass.sharingProhibited = true;

  // Suppresses the strip-image shine on the styles that have one. Every card
  // Apple ships itself has been flat since iOS 7; the gloss dates a pass.
  pass.suppressStripShine = true;

  switch (kind) {
    case 'loyalty': {
      push(body.primaryFields, 'points', 'Points', Number(subject.points) || 0);
      push(body.secondaryFields, 'member', 'Member', subject.name);
      if (subject.tier) push(body.secondaryFields, 'tier', 'Tier', subject.tier);
      if (subject.member_no) {
        push(body.auxiliaryFields, 'number', 'Member no.', subject.member_no);
      }
      if (subject.discount) {
        push(body.auxiliaryFields, 'discount', 'Your discount', subject.discount);
      }
      push(back, 'since', 'Member since', subject.member_since);
      // The ledger behind the number on the front. `PKTextAlignmentLeft` so the
      // columns line up as columns rather than drifting to the middle.
      const ledger = historyLines(subject.history);
      if (ledger) {
        push(back, 'history', 'Recent points', ledger, {
          textAlignment: 'PKTextAlignmentLeft',
        });
      }
      break;
    }

    case 'customer': {
      push(body.primaryFields, 'member', 'Member', subject.name);
      if (subject.member_no) {
        push(body.secondaryFields, 'number', 'Member no.', subject.member_no);
      }
      if (subject.tier) push(body.secondaryFields, 'tier', 'Tier', subject.tier);
      if (subject.discount) {
        push(body.auxiliaryFields, 'discount', 'Your discount', subject.discount);
      }
      push(back, 'since', 'Member since', subject.member_since);
      break;
    }

    case 'giftcard': {
      push(
        body.primaryFields,
        'balance',
        'Balance',
        money(subject.balance_minor, subject.currency)
      );
      if (subject.name) push(body.secondaryFields, 'for', 'For', subject.name);
      if (subject.expires_on) {
        push(body.auxiliaryFields, 'expires', 'Expires', subject.expires_on);
      }
      push(back, 'issued', 'Issued', subject.issued_on);
      break;
    }

    case 'staff': {
      push(body.primaryFields, 'name', 'Staff', subject.name);
      push(body.secondaryFields, 'role', 'Role', subject.role || 'Staff');
      push(body.auxiliaryFields, 'number', 'Card', subject.card_number);
      break;
    }

    case 'promo': {
      push(body.primaryFields, 'offer', 'Offer', subject.title);
      if (subject.details) push(body.secondaryFields, 'detail', '', subject.details);
      if (subject.ends_on) {
        push(body.auxiliaryFields, 'ends', 'Ends', subject.ends_on);
      }
      break;
    }

    default:
      break;
  }

  // A voided pass greys out in the wallet rather than vanishing. The holder
  // needs to see that the card was theirs and is spent — a card that silently
  // disappears reads as a bug in the wallet, and they ring the venue about it.
  if (subject.state && subject.state !== 'ACTIVE') pass.voided = true;

  if (subject.expires_on) pass.expirationDate = `${subject.expires_on}T23:59:59Z`;

  pass[type.appleStyle] = body;
  return pass;
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/**
 * The images that go in the archive.
 *
 * The artwork in `assets/wallet/` is one strip per kind of pass — generated
 * once, cropped to Apple's ratio by `tools/wallet_art`, and committed. It is
 * what makes a card look designed rather than generated, and it is the reason
 * the loyalty strip is the fallback for a kind whose own art is missing: a
 * branded band in the wrong mood beats a flat rectangle.
 *
 * A venue's own artwork is not read here yet — `epos_wallet_settings` holds
 * URLs for Google, which fetches them itself, and Apple needs *bytes* at
 * specific pixel sizes. Sizing an arbitrary upload without an image codec is
 * the missing half, and Node has none. See the note in tools/wallet_art.
 */
function artworkFor(kind, brand, assetsDir) {
  const files = {};

  const read = (name) => {
    const candidate = path.join(assetsDir, `${name}.png`);
    if (!existsSafely(candidate)) return null;
    try {
      return fs.readFileSync(candidate);
    } catch {
      return null;
    }
  };

  // @1x and @2x, and deliberately not @3x.
  //
  // A pass is downloaded over mobile data by somebody standing at a counter,
  // and these are photographic gradients, which PNG compresses badly: the three
  // scales together come to about 900KB per card against 340KB for two. An @3x
  // device upscaling an @2x gradient by half is a difference nobody can see —
  // unlike the wait, which they can. `tools/wallet_art` still produces the @3x
  // files, so shipping them later is a one-line change rather than a re-render.
  for (const [target, suffix] of [
    ['strip.png', ''],
    ['strip@2x.png', '@2x'],
  ]) {
    const art = read(`strip_${kind}${suffix}`) || read(`strip_loyalty${suffix}`);
    if (art) files[target] = art;
  }

  for (const [target, suffix] of [
    ['logo.png', ''],
    ['logo@2x.png', '@2x'],
  ]) {
    const art = read(`logo${suffix}`);
    if (art) files[target] = art;
  }

  // The icon is the one image Apple will not do without: an archive missing it
  // is rejected outright, with no message naming the file. So it falls back to
  // something generated here, which cannot fail.
  const background = rgb(brand.hex_background, BRAND.background);
  files['icon.png'] = read('icon') || solidPng(29, 29, background);
  files['icon@2x.png'] = read('icon@2x') || solidPng(58, 58, background);

  return files;
}

/**
 * A solid PNG, written by hand.
 *
 * The last-resort icon. It is forty lines against a library, and it is only
 * ever reached on a deployment with no artwork at all — but a pass with no
 * `icon.png` is rejected by Apple with no explanation, so there has to be
 * something here that cannot fail.
 */
function solidPng(width, height, cssRgb) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(cssRgb) || [];
  const r = Number(m[1]) || 17;
  const g = Number(m[2]) || 17;
  const b = Number(m[3]) || 17;

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * The detached PKCS#7 over `manifest.json`.
 *
 * `-binary` so the manifest is signed byte for byte rather than as text with
 * line endings normalised, and `-outform DER` because Apple will not read PEM
 * here. Getting either wrong produces a pass that fails to install with no
 * message naming the signature.
 *
 * There is deliberately NO `-noattr`. An earlier version of this file had it,
 * on the belief that Apple did not expect authenticated attributes; the
 * opposite is true. Apple's own `signpass`, and every library that signs passes
 * in production, emit the signed attributes -- contentType, messageDigest and
 * signingTime -- and a signature without them verifies perfectly under
 * `openssl smime -verify` while Wallet refuses the pass in silence. Valid to
 * openssl, rejected by the phone, no error anywhere: that was the bug, and it
 * cost a day, so it is worth the paragraph.
 *
 * The manifest goes to a temp file rather than stdin: `openssl smime` reads its
 * input by name, and the alternative is a pipe whose failure mode is a hang.
 */
function sign(manifest, kind, config) {
  const perKind = path.join(config.dir, P12_FILES[kind]);
  const bundle = existsSafely(perKind) ? perKind : config.shared;

  if (!bundle || !existsSafely(bundle)) {
    throw new Error(
      `No signing key for a ${kind} pass. Put ${P12_FILES[kind]} — or a single ` +
        `${SHARED_P12} covering all five — in APPLE_WALLET_DIR. ` +
        `See passes_and_oauth/README.md.`
    );
  }

  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vesopa-pkpass-'));
  const manifestPath = path.join(work, 'manifest.json');
  const signaturePath = path.join(work, 'signature');
  const certPath = path.join(work, 'cert.pem');
  const keyPath = path.join(work, 'key.pem');

  try {
    fs.writeFileSync(manifestPath, manifest);

    // The bundle is split rather than handed to `smime` directly, because
    // `openssl smime` takes a PEM certificate and key and not a PKCS#12. Both
    // land in a directory this process created and deletes.
    //
    // `-legacy` when this openssl has it -- see pkcs12LegacyArgs(). A .p12
    // exported by macOS Keychain uses RC2/3DES, which OpenSSL 3 moved to the
    // legacy provider; without the flag the export reads as "unsupported" and
    // looks like a wrong passphrase.
    // Through the environment, never as `pass:...` on the argv. An argument
    // is visible in `ps` to every account on the machine for as long as the
    // call runs, and this box is shared with other tenants — so a command
    // line here would leak the Wallet passphrase on every pass signed.
    run(
      ['pkcs12', '-in', bundle, '-nocerts', '-nodes', '-out', keyPath,
       '-passin', 'env:VESOPA_P12_PASS', ...pkcs12LegacyArgs()],
      'read the private key',
      { VESOPA_P12_PASS: config.passphrase || '' }
    );

    // The certificate comes from the *public* .cer for this kind, not from the
    // bundle. A shared bundle carries one certificate and would sign all five
    // kinds with it — and a .pkpass whose passTypeIdentifier does not match its
    // signing certificate is rejected by Apple with an error that names no
    // field at all.
    const cer = path.join(config.certDir, CER_FILES[kind]);
    if (!existsSafely(cer)) {
      throw new Error(`No certificate for a ${kind} pass: expected ${cer}`);
    }
    run(['x509', '-inform', 'DER', '-in', cer, '-out', certPath],
        'read the certificate');

    // Refused before anything is signed, because the failure it prevents is the
    // silent one: a pass signed by a key that does not match its certificate
    // installs on nobody's phone and reports nothing anywhere.
    assertKeyMatchesCert(keyPath, certPath, kind);

    run(['smime', '-binary', '-sign',
         '-certfile', config.wwdr,
         '-signer', certPath,
         '-inkey', keyPath,
         '-in', manifestPath,
         '-out', signaturePath,
         '-outform', 'DER'], 'sign the pass');

    return fs.readFileSync(signaturePath);
  } finally {
    // The private key was on disk for the length of one signature. Removed in a
    // `finally` so a failed sign does not leave it there.
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      // Nothing further to do; the directory is inside the system temp folder.
    }
  }
}

/**
 * Run openssl, and say what was being attempted when it fails.
 *
 * openssl's own messages are about providers and store routines. On their own
 * they send somebody looking in the wrong place — "unsupported" for a Keychain
 * export means the legacy provider, not a corrupt file.
 *
 * [extraEnv] is merged into the child environment, which is how a passphrase
 * reaches openssl without appearing in `ps`.
 */
function run(args, what, extraEnv) {
  try {
    execFileSync('openssl', args, {
      timeout: 15000,
      stdio: 'pipe',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim().split('\n')[0];
    throw new Error(`Could not ${what}: ${detail}`);
  }
}

/**
 * Whether this key actually belongs to this certificate.
 *
 * Compared by public key, which is the only thing the two have in common. The
 * check exists because the arrangement that makes setup easy — one bundle for
 * five certificates — is also the one where a mismatch is possible, and a
 * mismatch produces a pass that is perfectly formed and installs on nothing.
 */
function assertKeyMatchesCert(keyPath, certPath, kind) {
  const publicKeyOf = (args) =>
    crypto
      .createHash('sha256')
      .update(String(execFileSync('openssl', args, { stdio: 'pipe' })))
      .digest('hex');

  const fromKey = publicKeyOf(['pkey', '-in', keyPath, '-pubout']);
  const fromCert = publicKeyOf(['x509', '-in', certPath, '-pubkey', '-noout']);

  if (fromKey !== fromCert) {
    throw new Error(
      `The signing key does not belong to the ${kind} certificate. All five ` +
        `certificates have to come from the same CSR for one bundle to sign ` +
        `them all; otherwise use one .p12 per pass type.`
    );
  }
}

// ---------------------------------------------------------------------------
// The same material, for APNs
// ---------------------------------------------------------------------------

/**
 * The certificate and key for one pass type, as PEM, in memory.
 *
 * WHY THIS EXISTS BESIDE sign() RATHER THAN INSIDE IT
 *
 * A Pass Type ID certificate is two things at once: what signs a `.pkpass`, and
 * the TLS client certificate that authenticates to APNs when telling a phone
 * that pass has changed. There is no separate push certificate and no `.p8` —
 * Apple issues one credential and it does both jobs.
 *
 * [sign] needs the pair on disk, because `openssl smime` reads its inputs by
 * name. Node's TLS wants them as strings and will not read a file for you. The
 * two could be one function with a flag; they are not, deliberately. [sign] is
 * the code path whose failure mode is a pass that installs on nothing and says
 * nothing, it took a day to get right once, and it is not worth reopening to
 * save twenty lines here.
 *
 * NOTHING TOUCHES THE DISK
 *
 * [sign] writes the key to a temp file for the length of one signature because
 * openssl leaves it no choice. Here there is a choice, so the key exists only
 * as a string in this process: a long-lived APNs connection would otherwise
 * mean a private key sitting in the system temp folder for the life of the
 * server, on a box shared with about twenty other tenants.
 *
 * The passphrase goes through the environment for the same reason it does in
 * [sign] — an argument is visible in `ps` to every account on the machine.
 */
function pemForKind(kind, config) {
  if (!CER_FILES[kind]) throw new Error(`Unknown pass kind "${kind}"`);

  const perKind = path.join(config.dir, P12_FILES[kind]);
  const bundle = existsSafely(perKind) ? perKind : config.shared;
  if (!bundle || !existsSafely(bundle)) {
    throw new Error(
      `No signing key for a ${kind} pass, so nothing can authenticate to APNs ` +
        `for ${CER_FILES[kind]}. Put ${P12_FILES[kind]} — or a single ` +
        `${SHARED_P12} covering all five — in APPLE_WALLET_DIR.`
    );
  }

  const cer = path.join(config.certDir, CER_FILES[kind]);
  if (!existsSafely(cer)) {
    throw new Error(`No certificate for a ${kind} pass: expected ${cer}`);
  }

  // `-legacy` when this openssl has it, for the same Keychain/3DES reason the
  // rest of this file documents. See pkcs12LegacyArgs().
  const keyOut = execFileSync(
    'openssl',
    ['pkcs12', '-in', bundle, '-nocerts', '-nodes',
     '-passin', 'env:VESOPA_P12_PASS', ...pkcs12LegacyArgs()],
    {
      stdio: 'pipe',
      timeout: 15000,
      env: { ...process.env, VESOPA_P12_PASS: config.passphrase || '' },
    }
  );

  // `openssl pkcs12` prints the bag attributes — friendly name, local key id —
  // above the PEM block. Node's TLS rejects the whole string when they are left
  // on, with an error about the key rather than about the preamble, so only the
  // block itself is kept.
  const key = pemBlock(String(keyOut), 'PRIVATE KEY');
  if (!key) {
    throw new Error(
      `Read ${path.basename(bundle)} but found no private key in it — check ` +
        `APPLE_WALLET_P12_PASSWORD.`
    );
  }

  const leaf = String(
    execFileSync('openssl', ['x509', '-inform', 'DER', '-in', cer], {
      stdio: 'pipe',
      timeout: 15000,
    })
  );

  // The WWDR intermediate is appended to the leaf rather than passed as a CA.
  // `ca` in Node's TLS options is what *verifies the server*; APNs' own chain
  // is public and already trusted, and overriding it here would mean this
  // connection stopped trusting Apple the day Apple rotated. What APNs needs
  // from us is the chain for our own certificate, which is what a multi-PEM
  // `cert` is — leaf first, then the intermediate that issued it.
  const chain = [pemBlock(leaf, 'CERTIFICATE')];
  if (config.wwdr && existsSafely(config.wwdr)) {
    try {
      const wwdr = pemBlock(fs.readFileSync(config.wwdr, 'utf8'), 'CERTIFICATE');
      if (wwdr) chain.push(wwdr);
    } catch {
      // A missing intermediate is survivable here in a way it is not when
      // signing: APNs may already hold it. Left out rather than made fatal.
    }
  }

  return { cert: chain.join('\n'), key };
}

/** The first PEM block of a given type, without whatever surrounds it. */
function pemBlock(text, label) {
  const match = new RegExp(
    `-----BEGIN [^-]*${label}-----[\\s\\S]*?-----END [^-]*${label}-----`
  ).exec(String(text));
  return match ? match[0] : '';
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Write a ZIP.
 *
 * Deflate, no directory entries, no ZIP64, no encryption — the whole of what a
 * `.pkpass` is allowed to be. Written out rather than pulled in because the
 * format is small and fixed, and because the two zip libraries in this tree are
 * transitive dependencies of something else, which is not a thing to build a
 * feature on.
 *
 * The date is fixed rather than "now": two passes minted from the same data
 * should be byte-identical, which makes a difference exactly once — when
 * somebody is trying to work out whether a pass changed.
 */
function zip(files) {
  const DOS_TIME = 0;
  const DOS_DATE = 0x21;

  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(content, { level: 9 });
    const sum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBytes, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);

    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

// ---------------------------------------------------------------------------

/**
 * Build one signed `.pkpass`.
 *
 * Returns the archive bytes plus the serial and token, which the caller records
 * so the pass can be recognised and updated later.
 */
function buildPkpass({ kind, config, brand, subject, assetsDir, serial, authToken }) {
  const useSerial = serial || crypto.randomUUID();
  const useToken = authToken || crypto.randomBytes(24).toString('hex');

  const passJson = buildPassJson({
    kind,
    config,
    brand,
    subject,
    serial: useSerial,
    authToken: useToken,
  });

  const files = {
    'pass.json': Buffer.from(JSON.stringify(passJson, null, 2), 'utf8'),
    ...artworkFor(kind, brand, assetsDir),
  };

  // SHA-1, and not because it is a good hash. It is what Apple specifies and
  // what iOS checks against; anything stronger is simply rejected.
  const manifest = {};
  for (const [name, content] of Object.entries(files)) {
    manifest[name] = crypto.createHash('sha1').update(content).digest('hex');
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

  files['manifest.json'] = manifestBytes;
  files.signature = sign(manifestBytes, kind, config);

  return {
    bytes: zip(files),
    serial: useSerial,
    authToken: useToken,
    passTypeIdentifier: G.PASS_TYPES[kind].appleType,
  };
}

module.exports = {
  APPLE_TEAM_ID,
  P12_FILES,
  CER_FILES,
  SHARED_P12,
  findBundle,
  readConfig,
  cachedConfig,
  resetConfig,
  pemForKind,
  pemBlock,
  buildPassJson,
  buildPkpass,
  artworkFor,
  solidPng,
  zip,
  crc32,
  rgb,
  BRAND,
};
