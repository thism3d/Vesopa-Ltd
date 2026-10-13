/**
 * Phone numbers proved by Firebase (2026-10-13).
 *
 * The loyalty phone apps prove a mobile number with Firebase Authentication's
 * phone sign-in: Firebase texts the code, to any country, and the app comes
 * back with a Firebase ID token whose `phone_number` is the proved number.
 * The texts used to go through Postcoder, which reaches UK mobiles only.
 *
 * The token is checked here against Google's published certificates for
 * Firebase ID tokens, so no service account key is needed: RS256, issued by
 * https://securetoken.google.com/<project> for audience <project>, not
 * expired, with a subject. FIREBASE_PROJECT_ID names the project ("vesopa").
 */

const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cache = { certs: null, until: 0 };

function projectId() {
  return String(process.env.FIREBASE_PROJECT_ID || '').trim();
}

/** Whether this server can check Firebase phone tokens at all. */
function enabled() {
  return projectId() !== '';
}

async function certs(fetchImpl = fetch) {
  if (cache.certs && Date.now() < cache.until) return cache.certs;
  const res = await fetchImpl(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Firebase certificates: HTTP ${res.status}`);
  const age = /max-age=(\d+)/.exec(res.headers.get ? res.headers.get('cache-control') || '' : '');
  cache = { certs: await res.json(), until: Date.now() + (age ? Number(age[1]) : 3600) * 1000 };
  return cache.certs;
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * The proved phone number in a Firebase ID token, or an error.
 * Resolves `{ phone, uid }`; throws with a message fit for the member.
 */
async function verifyPhoneToken(token, { fetchImpl = fetch, now = Date.now() } = {}) {
  const project = projectId();
  if (!project) throw new Error('Phone sign-in is not set up on this server yet.');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('That phone check did not work. Please try again.');
  let header;
  let claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    throw new Error('That phone check did not work. Please try again.');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('That phone check did not work. Please try again.');
  const pem = (await certs(fetchImpl))[header.kid];
  if (!pem) throw new Error('That phone check did not work. Please try again.');
  const ok = crypto.createVerify('RSA-SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify(pem, Buffer.from(parts[2], 'base64url'));
  const secs = Math.floor(now / 1000);
  if (!ok
    || claims.aud !== project
    || claims.iss !== `https://securetoken.google.com/${project}`
    || !claims.sub
    || !(Number(claims.exp) > secs)
    || Number(claims.iat) > secs + 300) {
    throw new Error('That phone check did not work. Please try again.');
  }
  const phone = String(claims.phone_number || '');
  if (!/^\+\d{8,15}$/.test(phone)) throw new Error('That sign-in did not prove a phone number.');
  return { phone, uid: String(claims.sub) };
}

/** For tests: forget the cached certificates. */
function resetCache() {
  cache = { certs: null, until: 0 };
}

module.exports = { enabled, verifyPhoneToken, resetCache, CERTS_URL };
