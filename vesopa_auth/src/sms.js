/**
 * Text messages, behind an interface.
 *
 * TWO GATEWAYS, CHOSEN BY THE NUMBER. Postcoder texts UK mobiles only. On
 * 2026-09-17 the owner asked for Bangladeshi numbers to work as well, so
 * +880 goes to BulkSMSBD — the gateway royalgrow.work and pasificgrowth.site
 * already send with, reusing that account rather than opening another.
 * Nothing else picks a provider: the dial code does, because the number is the
 * only thing that actually decides which network can carry the message.
 *
 * THE TWO ARE NOT THE SAME SHAPE, and that is the interesting part.
 * Postcoder mints, sends AND verifies the code — we never see it. BulkSMSBD
 * only sends: it is a pipe for a message we wrote. So a Postcoder challenge
 * stores their reference and verifies by calling them, and a BulkSMSBD
 * challenge mints a code, hashes it and compares hashes exactly as an emailed
 * code does. `mintsOwnCode` is how a provider says which it is, and
 * challenges.js branches on it rather than on the country.
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
  if (config.sms.countries.includes('GB') && number.startsWith('+44') && Boolean(config.sms.postcoderKey)) return true;
  // BulkSMSBD carries Bangladesh. Checked against the credential as well as
  // the setting: a country listed with no gateway behind it accepts the number
  // and then never delivers, which is the exact failure this function exists
  // to prevent.
  if (config.sms.countries.includes('BD') && number.startsWith('+880') && Boolean(config.sms.bulksmsbdKey)) return true;
  return false;
}

const postcoder = {
  name: 'postcoder',
  /** Postcoder generates the code, sends it and checks it. We never see it. */
  mintsOwnCode: true,

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
 * Bangladesh, through BulkSMSBD.
 *
 * A SEND-ONLY PIPE. It takes a number and a message and reports whether it was
 * accepted; there is no OTP service and nothing to verify against, so the code
 * in the message is one WE minted and the comparison happens in our own
 * database. `mintsOwnCode: false` tells challenges.js to take that path.
 *
 * THE NUMBER FORMAT IS NOT E.164. BulkSMSBD wants `8801XXXXXXXXX` — the
 * country code, no plus. Everything inside Vesopa stores E.164 (`+8801…`),
 * so the plus comes off here, at the edge, and nowhere else.
 *
 * `response_code: 202` is its only success. Anything else, including an HTTP
 * 200 carrying an error code in the body, is a failure — the person is waiting
 * for a message, and "probably sent" is not a state this may report.
 */
const BULKSMSBD_DEFAULT_URL = 'http://bulksmsbd.net/api/smsapi';

const bulksmsbd = {
  name: 'bulksmsbd',
  mintsOwnCode: false,

  /**
   * Send a code we generated.
   * @returns {Promise<string|null>} a reference for the log, or null if unsent
   */
  async sendCode(e164, { minutes, code }) {
    const key = config.sms.bulksmsbdKey;
    const sender = config.sms.bulksmsbdSender;
    if (!key || !sender) {
      console.warn('[sms] no BULKSMSBD_API_KEY / BULKSMSBD_SENDER_ID — cannot send');
      return null;
    }
    if (!code) {
      // Defensive: this provider cannot invent one, and sending a message with
      // no code in it is worse than not sending.
      console.warn('[sms] bulksmsbd called without a code');
      return null;
    }

    const number = String(e164 || '').replace(/^\+/, '');
    const message = `${code} is your Vesopa code. It expires in ${minutes} minutes.`;

    try {
      const response = await fetch(config.sms.bulksmsbdUrl || BULKSMSBD_DEFAULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          senderid: sender,
          number,
          message,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok && Number(data.response_code) === 202) {
        return `bulksmsbd-${Date.now()}`;
      }
      console.warn('[sms] bulksmsbd refused:', response.status, scrub(JSON.stringify(data).slice(0, 200), key));
      return null;
    } catch (error) {
      console.warn('[sms] bulksmsbd send failed:', scrub(error.message, key));
      return null;
    }
  },

  /**
   * Never called: a challenge sent this way is verified against our own hash,
   * the same as an emailed code. It exists so the interface is complete, and
   * it answers NO rather than throwing — a provider that cannot verify must
   * not be able to let anybody in by accident.
   */
  async verifyCode() {
    return false;
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
  mintsOwnCode: false,
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

/**
 * The default gateway, when the number does not choose one.
 *
 * Kept so existing callers and the tests behave as they did; new code should
 * ask providerFor(number), because with two gateways live "the provider" is
 * not a thing that exists on its own any more.
 */
function provider() {
  if (config.sms.provider === 'postcoder') return postcoder;
  if (config.sms.provider === 'bulksmsbd') return bulksmsbd;
  if (config.sms.provider === 'console') return console_provider;
  throw new Error(`unknown SMS provider: ${config.sms.provider}`);
}

/**
 * Which gateway carries THIS number.
 *
 * The dial code decides, because it is what determines which network has to
 * accept the message. A development box with SMS_PROVIDER=console keeps the
 * console for everything — otherwise a developer typing a real Bangladeshi
 * number into a test form sends a real message and spends real money.
 */
function providerFor(e164) {
  if (config.sms.provider === 'console') return console_provider;
  const number = String(e164 || '');
  if (number.startsWith('+880')) return bulksmsbd;
  if (number.startsWith('+44')) return postcoder;
  return provider();
}

module.exports = { canReach, provider, providerFor };
