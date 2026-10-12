/**
 * The passkeys on a member's Vesopa account, for their account page in the app.
 *
 * WHY THE APP ASKS US AND NOT auth.vesopa.com. In a venue's own app the
 * passkey a member signs in with is usually their Vesopa one (RP vesopa.com,
 * through /oauth/native), not one of the venue's own in epos_loyalty_passkeys.
 * Listing only the venue's would show an empty "Signing in" to somebody who
 * signs in with a passkey every day. But the app keeps no Vesopa session --
 * the native sign-in ends in OUR token -- so it has nothing to show auth. This
 * server does: the member's Vesopa subject (epos_customers.vesopa_sub, set when
 * they signed in with Vesopa) and the loyalty application's privacy-provider
 * secret, which already signs the deletion requests (privacy_provider.js).
 *
 * WHAT AUTH ALLOWS, and no more (vesopa_auth/src/routes/member_passkeys.js):
 * list the passkeys of a subject THIS application was given, and remove one.
 * It never adds one: a Vesopa passkey counts as two factors, and a venue
 * app's session -- an emailed code -- is not enough to grant that. A member
 * adds a passkey for the venue's own sign-in instead (loyalty_auth.js).
 *
 * NOTHING HERE MAY BREAK THE PAGE. Auth slow, down, or not yet deployed: the
 * venue's own passkeys still show, and the Vesopa ones are simply absent.
 */
const crypto = require('crypto');

const TIMEOUT_MS = 5000;

function config(env = process.env) {
  return {
    secret: String(env.VESOPA_PRIVACY_SECRET || ''),
    auth: String(env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com').replace(/\/+$/, ''),
  };
}

function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

async function call(action, payload, { env = process.env, fetchImpl = fetch } = {}) {
  const { secret, auth } = config(env);
  if (secret.length < 32 || !payload.sub) return null;
  const body = JSON.stringify(payload);
  const response = await fetchImpl(`${auth}/privacy/v1/member-passkeys${action ? `/${action}` : ''}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/vesopa+json',
      'vesopa-application': 'vesopa-loyalty',
      'vesopa-signature': sign(secret, body),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = await response.json().catch(() => null);
  return { status: response.status, answer: answer || {} };
}

/** The account's passkeys, or null when they cannot be had just now. */
async function listVesopaPasskeys(sub, options) {
  try {
    const got = await call('', { sub: String(sub || '') }, options);
    if (!got || got.status !== 200 || !Array.isArray(got.answer.passkeys)) return null;
    return got.answer.passkeys;
  } catch (e) {
    console.warn('[vesopa passkeys] list failed:', e.message);
    return null;
  }
}

/** Remove one. Answers { ok } or { error } in words fit to show. */
async function removeVesopaPasskey(sub, id, options) {
  try {
    const got = await call('remove', { sub: String(sub || ''), id: String(id || '') }, options);
    if (!got) return { error: 'Your Vesopa passkeys cannot be changed from here just now.' };
    if (got.status === 200) return { ok: true };
    if (got.answer.error === 'last_auth_method') {
      return { error: 'That is the only way into your Vesopa account, so it has to stay. Add another way in first.' };
    }
    return { error: 'That passkey could not be removed. Please try again.' };
  } catch (e) {
    console.warn('[vesopa passkeys] remove failed:', e.message);
    return { error: 'That passkey could not be removed. Please try again.' };
  }
}

module.exports = { listVesopaPasskeys, removeVesopaPasskey, sign };
