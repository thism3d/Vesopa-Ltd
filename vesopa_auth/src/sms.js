/**
 * Text messages, behind an interface.
 *
 * WHY AN INTERFACE FOR ONE PROVIDER. Postcoder texts UK mobiles only. That is
 * fine today — every Vesopa venue is in Britain — and it will not be fine the
 * first time somebody with an Irish number tries to sign in. The owner asked
 * for Postcoder now with a second route later, so the shape of "send a code to
 * this number" is fixed here and the gateway behind it is a setting.
 *
 * THE ASYMMETRY WITH EMAIL, WHICH RUNS THROUGH THE WHOLE SYSTEM
 *
 * Email codes are ours: we mint them, hash them, send them and check them.
 *
 * Postcoder's OTP service mints, sends AND verifies. We never see the code, and
 * nothing in this application could check one offline. So a phone challenge
 * stores their reference instead of a hash, and verification is a call out
 * rather than a comparison.
 *
 * That is a deliberate boundary, not an omission. The alternative — us holding
 * an SMS gateway credential and a table of live codes so that the two channels
 * look the same in the database — buys tidiness with a much worse thing to
 * leak.
 *
 * WHAT REMAINS OURS EVEN SO, and must not be delegated:
 *   1. the send rate limits, because the messages are billed to Vesopa
 *   2. checking the verified number is the number we asked about
 *   3. refusing a country the gateway cannot reach, in words, up front
 */

const config = require('./config');

const POSTCODER_BASE = 'https://ws.postcoder.com/pcw';
const TIMEOUT_MS = 12000;

/**
 * Can we text this number at all?
 *
 * Answered before anything is sent, so the person is told to use email instead
 * — which is a great deal better than a message that silently never arrives and
 * a form that waits for a code nobody can supply.
 */
function canReach(e164) {
  const number = String(e164 || '');
  if (!number.startsWith('+')) return false;
  if (config.sms.countries.includes('*')) return true;
  // Postcoder is UK-only. `+44` covers Great Britain and Northern Ireland.
  if (config.sms.countries.includes('GB') && number.startsWith('+44')) return true;
  return false;
}

const postcoder = {
  name: 'postcoder',

  /**
   * Ask the gateway to generate and send a code.
   *
   * Returns their reference, which is the only handle we will ever have on it,
   * or null if the send failed. Null must be treated as "not sent" and never as
   * "sent, assume it worked" — the person is waiting for a message.
   */
  async sendCode(e164, { minutes, length }) {
    const key = config.sms.postcoderKey;
    if (!key) {
      console.warn('[sms] no POSTCODER_API_KEY — cannot send');
      return null;
    }

    // 3–11 GSM7 characters, and `[otp]` is the placeholder the gateway
    // substitutes. The whole message must fit 140 characters.
    const sender = 'Vesopa';
    try {
      const response = await fetch(
        `${POSTCODER_BASE}/${encodeURIComponent(key)}/otp/send?format=json`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: e164,
            from: sender,
            message: `[otp] is your Vesopa code. It expires in ${minutes} minutes.`,
            otplength: length,
            expiry: minutes,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        // The body is scrubbed before it is printed: the API key is in the URL,
        // and a provider's error can quote the request back at you.
        const body = (await response.text()).slice(0, 200);
        console.warn('[sms] send refused:', response.status, scrub(body, key));
        return null;
      }

      const data = await response.json();
      return data && data.id ? String(data.id) : null;
    } catch (error) {
      console.warn('[sms] send failed:', scrub(error.message, key));
      return null;
    }
  },

  /**
   * Ask the gateway whether this code is right.
   *
   * Postcoder answers HTTP 200 with `{ valid: true|false }` either way, so a
   * non-200 is a fault on our side or theirs — and must be read as "no", never
   * as "probably yes".
   */
  async verifyCode(reference, code) {
    const key = config.sms.postcoderKey;
    if (!key || !reference) return false;
    try {
      const response = await fetch(
        `${POSTCODER_BASE}/${encodeURIComponent(key)}/otp/verify?format=json`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: String(reference), otp: String(code) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) return false;
      const data = await response.json();
      return !!(data && data.valid === true);
    } catch (error) {
      console.warn('[sms] verify failed:', scrub(error.message, key));
      return false;
    }
  },
};

/**
 * A gateway that does nothing, for development and for the tests.
 *
 * It logs the code rather than sending it, and it is chosen by configuration —
 * never by a fallback when the real one fails. A silent fall back to "pretend
 * it worked" on a login path is how an environment ends up letting anybody in
 * with the code `000000`.
 */
const console_provider = {
  name: 'console',
  async sendCode(e164, options) {
    const reference = `console-${Date.now()}`;
    console.log(`[sms] would text ${e164} a ${options.length}-digit code (${reference})`);
    return reference;
  },
  async verifyCode() {
    return false;
  },
};

function scrub(text, secret) {
  return secret ? String(text).split(secret).join('<key>') : String(text);
}

function provider() {
  if (config.sms.provider === 'postcoder') return postcoder;
  if (config.sms.provider === 'console') return console_provider;
  throw new Error(`unknown SMS provider: ${config.sms.provider}`);
}

module.exports = { canReach, provider };
