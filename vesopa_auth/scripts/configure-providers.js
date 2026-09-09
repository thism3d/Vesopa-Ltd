/**
 * Put the social sign-in credentials into .env, reading them from the files the
 * providers issued rather than from anybody's clipboard.
 *
 *     node scripts/configure-providers.js
 *
 * Run ON THE SERVER. Nothing secret is printed: the output says which providers
 * are now configured and which are still waiting for a credential, and never
 * the credential itself.
 *
 * Idempotent, and idempotent in the careful sense — a value already present in
 * .env is left exactly as it is. Somebody who has pasted a secret by hand must
 * not have it overwritten by a deploy.
 */

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const ENV = path.join(APP, '.env');
const KEYS = path.join(APP, 'keys');

function readEnv() {
  if (!fs.existsSync(ENV)) return {};
  const values = {};
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    values[key.trim()] = rest.join('=').trim();
  }
  return values;
}

const current = readEnv();
const additions = [];

function set(key, value) {
  if (!value) return false;
  if (current[key]) {
    console.log(`  · ${key} already set`);
    return false;
  }
  additions.push(`${key}=${value}`);
  console.log(`  ✓ ${key}`);
  return true;
}

// ---------------------------------------------------------------------------
// Google — the credentials file Google Cloud downloads for you
// ---------------------------------------------------------------------------
console.log('▶ Google');
const googleFile = fs
  .readdirSync(APP)
  .find((name) => name.startsWith('client_secret_') && name.endsWith('.json'));

if (googleFile) {
  const parsed = JSON.parse(fs.readFileSync(path.join(APP, googleFile), 'utf8'));
  const section = parsed.web || parsed.installed || {};
  set('GOOGLE_CLIENT_ID', section.client_id);
  set('GOOGLE_CLIENT_SECRET', section.client_secret);

  /*
   * Check the redirect URI Google has on file. A mismatch here is the single
   * most common reason "sign in with Google" fails, and Google's own error
   * page says only `redirect_uri_mismatch` without saying what it expected.
   */
  const expected = 'https://auth.vesopa.com/auth/google/callback';
  const registered = section.redirect_uris || [];
  if (!registered.includes(expected)) {
    console.log(`  ! Google does not list ${expected}`);
    console.log(`    it has: ${registered.join(', ') || 'none'}`);
    console.log('    Add it in Google Cloud Console → Credentials, or sign-in will fail.');
  } else {
    console.log('  ✓ redirect URI registered with Google');
  }
} else {
  console.log('  ! no client_secret_*.json found');
}

// ---------------------------------------------------------------------------
// Apple — the .p8 signing key
// ---------------------------------------------------------------------------
console.log('▶ Apple');
const appleKey = fs.readdirSync(APP).find((name) => /^AuthKey_.*\.p8$/.test(name));
if (appleKey) {
  fs.mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const destination = path.join(KEYS, appleKey);
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(path.join(APP, appleKey), destination);
    fs.chmodSync(destination, 0o600);
    console.log(`  ✓ key copied to keys/${appleKey}`);
  } else {
    console.log('  · key already in place');
  }
  // AuthKey_UX5DVJ787G.p8 -> UX5DVJ787G
  const keyId = appleKey.replace(/^AuthKey_/, '').replace(/\.p8$/, '');
  set('APPLE_KEY_ID', keyId);
  set('APPLE_TEAM_ID', 'G238FR2ZC9');
  set('APPLE_SERVICE_ID', 'com.vesopa.auth');
  set('APPLE_PRIVATE_KEY_PATH', destination);
} else {
  console.log('  ! no AuthKey_*.p8 found');
}

// ---------------------------------------------------------------------------
// Microsoft and GitHub — the client ids are public, the secrets are not
// ---------------------------------------------------------------------------
console.log('▶ Microsoft');
set('MICROSOFT_CLIENT_ID', '335a71ee-f200-4cb3-9965-dafc3ab0e01b');
set('MICROSOFT_TENANT', 'common');
if (!current.MICROSOFT_CLIENT_SECRET) {
  console.log('  ! MICROSOFT_CLIENT_SECRET is missing — Microsoft sign-in stays hidden');
}

console.log('▶ GitHub');
set('GITHUB_CLIENT_ID', 'Iv23liLFFlwUqny92CKX');
if (!current.GITHUB_CLIENT_SECRET) {
  console.log('  ! GITHUB_CLIENT_SECRET is missing — GitHub sign-in stays hidden');
}

if (additions.length) {
  fs.appendFileSync(ENV, `\n# social sign-in\n${additions.join('\n')}\n`);
  fs.chmodSync(ENV, 0o600);
}

console.log(`\n${additions.length} setting(s) added to .env`);
