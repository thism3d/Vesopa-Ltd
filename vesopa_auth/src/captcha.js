/**
 * reCAPTCHA v3 on the sign-in page.
 *
 * v3 IS NOT A GATE, AND TREATING IT AS ONE IS THE MISTAKE.
 *
 * It returns a score between 0 and 1 — a guess about whether this is a person.
 * The guess is wrong often enough to matter: a shared office address, a VPN, a
 * privacy-hardened browser, a corporate proxy, a phone on a carrier NAT, and an
 * ordinary customer scores 0.1 and is told they are a robot. On a sign-in page
 * that is a person locked out of their own account by a probability.
 *
 * So a low score here NEVER refuses anybody. It removes the fast paths and
 * demands an emailed code instead — which the person can answer, because they
 * own the mailbox, and the bot cannot. The control does its job (a script
 * cannot grind passwords) without the failure mode that makes people hate it.
 *
 * A HARD FAIL — the token is missing, malformed, or Google says it is invalid —
 * is different from a low score and IS refused. That is not an opinion about a
 * human; it is a request that did not come from our page.
 *
 * OFF UNLESS CONFIGURED. With no keys set, `assess()` answers "fine" and
 * nothing on the page changes. An identity provider must not become unusable
 * because a third-party script did not load.
 */

const config = require('./config');

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const TIMEOUT_MS = 4000;

function enabled() {
  return Boolean(config.captcha && config.captcha.siteKey && config.captcha.secretKey);
}

/**
 * What the page should do about this request.
 *
 * Returns `{ ok, score, reason, degrade }`:
 *   ok=false      refuse — this did not come from our form
 *   degrade=true  allow, but no password and no fast path; send a code
 */
async function assess(token, action, ip) {
  if (!enabled()) return { ok: true, score: null, degrade: false, reason: 'disabled' };

  const value = String(token || '');
  if (!value) {
    /*
     * No token at all.
     *
     * This is the case that has to be handled kindly rather than strictly. The
     * script is loaded from google.com, and plenty of real people block that —
     * an ad blocker, a corporate policy, a country. Refusing them would mean
     * the sign-in page simply does not work for those people, and they would
     * have no way to find out why.
     *
     * So: no token degrades rather than refuses. The bot that skipped our page
     * entirely lands in the same place, and has to read a mailbox to get out
     * of it.
     */
    return { ok: true, score: null, degrade: true, reason: 'no_token' };
  }

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: config.captcha.secretKey,
        response: value,
        ...(ip ? { remoteip: String(ip).slice(0, 45) } : {}),
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const data = await response.json();

    if (!data.success) {
      /*
       * Google refused the token. `timeout-or-duplicate` is the common one and
       * is not an attack — a token is good for two minutes and somebody who
       * left the page open and came back has an expired one. Degrade rather
       * than refuse; ask for a code.
       */
      const codes = (data['error-codes'] || []).join(',');
      if (/timeout|duplicate/.test(codes)) {
        return { ok: true, score: null, degrade: true, reason: codes };
      }
      return { ok: false, score: null, degrade: true, reason: codes || 'rejected' };
    }

    /*
     * The action is checked, and it matters. A token minted on some other page
     * of ours — or on a page an attacker embedded our site key into — is a
     * valid token for the wrong thing. Without this check the score means
     * nothing, because it can be farmed anywhere the site key appears.
     */
    if (action && data.action && data.action !== action) {
      return { ok: false, score: data.score, degrade: true, reason: 'action_mismatch' };
    }

    const score = typeof data.score === 'number' ? data.score : null;
    const threshold = config.captcha.threshold;

    return {
      ok: true,
      score,
      degrade: score !== null && score < threshold,
      reason: score === null ? 'no_score' : 'scored',
    };
  } catch (error) {
    /*
     * Google did not answer in four seconds.
     *
     * FAIL OPEN, and it is not a close call. This service holds every Vesopa
     * login; a dependency on Google being reachable would mean an outage at
     * Google is an outage here, for the till in a pub that has nothing to do
     * with any of it. The rate limits per destination, per IP and per challenge
     * are still there, and they are ours.
     */
    console.warn('[captcha] siteverify unreachable, allowing:', error.message);
    return { ok: true, score: null, degrade: false, reason: 'unreachable' };
  }
}

module.exports = { enabled, assess };
