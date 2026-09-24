/**
 * Which shape of token request will Microsoft actually accept?
 *
 *     node scripts/probe-microsoft.js
 *
 * WHY THIS EXISTS. Microsoft decides whether an app registration is
 * confidential, public, or single-page from a radio button in a portal nobody
 * here can see, and gets it wrong loudly and unhelpfully: `AADSTS700025` and
 * `AADSTS9002327` name neither the platform nor the fix. Diagnosing it by
 * signing in repeatedly means a real person, a real password and a real
 * mailbox for every attempt, and three of those attempts is an afternoon.
 *
 * This asks the same question with a DELIBERATELY INVALID authorisation code.
 * Microsoft checks the shape of the request before it checks the code, so:
 *
 *   AADSTS9002327   the callback is registered under "Single-page application"
 *                   and this form of the request will never be answered
 *   AADSTS700025    the registration is public; the secret must not be sent
 *   AADSTS7000215   the registration is confidential and the secret is wrong
 *   invalid_grant   THE REQUEST SHAPE IS ACCEPTED. Only the code was rejected,
 *                   which is the answer we want — a real code would work here.
 *
 * NOTHING IS SPENT AND NOTHING IS CHANGED. The code is the literal string
 * "probe", no real code is redeemed, no session is created, and no account is
 * touched. It is safe to run against production, which is the only place the
 * registration it is asking about actually exists.
 *
 * WHAT IT PROVES, AND WHAT IT ONLY SUGGESTS. `AADSTS700025` is a fact about the
 * REGISTRATION — public or confidential — and a probe answers it exactly.
 * `AADSTS9002327` is phrased as a fact about the CODE ("tokens issued for the
 * Single-Page Application client-type…"), so a made-up code may not provoke it
 * even where a real one would. Read a clean run as "the registration is no
 * longer refusing the secret", which is the half that was broken; read a
 * failure as conclusive.
 *
 * The secret is never printed, only whether one was sent.
 */

require('dotenv').config({ quiet: true });

const TENANT = (process.env.MICROSOFT_TENANT || 'common').trim();
const CLIENT_ID = (process.env.MICROSOFT_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.MICROSOFT_CLIENT_SECRET || '').trim();
const ISSUER = (process.env.ISSUER || 'https://auth.vesopa.com').replace(/\/$/, '');
const REDIRECT = `${ISSUER}/auth/microsoft/callback`;
const URL_TOKEN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

const BASE = {
  code: 'probe',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  grant_type: 'authorization_code',
  // A verifier of the right shape. It cannot match anything, which is fine —
  // the code is invalid anyway and the point is the request's SHAPE.
  code_verifier: 'x'.repeat(64),
};

async function attempt(name, body, headers = {}) {
  const response = await fetch(URL_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  const code = (text.match(/AADSTS\d+/) || [])[0] || '';
  let error = '';
  try {
    error = JSON.parse(text).error || '';
  } catch {
    error = 'unparseable';
  }

  const verdict =
    code === 'AADSTS9002327'
      ? 'REFUSED — registered as a Single-Page Application'
      : code === 'AADSTS700025'
        ? 'REFUSED — the registration is public; do not send the secret'
        : code === 'AADSTS7000215'
          ? 'REFUSED — the secret is wrong'
          : error === 'invalid_grant'
            ? 'ACCEPTED — only the code was bad, which is what we sent'
            : `unclear (${error}${code ? ' ' + code : ''})`;

  console.log(`  ${name.padEnd(14)} ${verdict}`);
  return error === 'invalid_grant';
}

async function main() {
  if (!CLIENT_ID) {
    console.error('MICROSOFT_CLIENT_ID is not set in .env — nothing to probe.');
    process.exit(1);
  }

  console.log(`Microsoft token endpoint — tenant "${TENANT}"`);
  console.log(`  redirect_uri  ${REDIRECT}`);
  console.log(`  secret        ${CLIENT_SECRET ? 'configured' : 'NOT configured'}\n`);

  const works = [];
  if (CLIENT_SECRET && (await attempt('confidential', { ...BASE, client_secret: CLIENT_SECRET }))) {
    works.push('confidential');
  }
  if (await attempt('public', BASE)) works.push('public');
  if (await attempt('spa', BASE, { origin: ISSUER })) works.push('spa');

  console.log('');
  if (!works.length) {
    console.log('None of the three is answered. The registration needs fixing in the portal:');
    console.log('  App registrations → your app → Authentication');
    console.log(`  put ${REDIRECT} under "Web" — not "Single-page application"`);
    console.log('  and set "Allow public client flows" to No.');
    process.exit(2);
  }

  console.log(`Modes the registration accepts, for a request of this shape: ${works.join(', ')}.`);
  console.log(`src/providers.js tries them in order and remembers the first that answers.`);
  console.log(`Set MICROSOFT_TOKEN_MODE=${works[0]} to skip straight to it.`);
}

main().catch((error) => {
  console.error('probe failed:', error.message);
  process.exit(1);
});
