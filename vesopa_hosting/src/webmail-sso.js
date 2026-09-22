/**
 * Signing a customer into their own webmail, without a second password.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 * src/mailbox-vault.js kept an encrypted copy of the mailbox password and
 * replayed it into Roundcube's login form. It was honest about its own limits
 * and two of them were fatal in practice: it was opt-in, so almost no mailbox
 * had an entry and almost every click still landed on a login form; and it
 * meant holding a credential we had no business holding.
 *
 * This holds nothing. The node runs a Dovecot MASTER USER — see webmail/ — and
 * Roundcube opens the mailbox as that identity through SASL PLAIN proxy
 * authorization. The customer's own password is never involved, never stored
 * and never transmitted.
 *
 * ---------------------------------------------------------------------------
 * THE LINK
 * ---------------------------------------------------------------------------
 *     signature = HMAC-SHA256(key, "<address>\n<expiry>\n<nonce>")
 *
 * Sixty seconds to live, and single-use: the plugin spends the nonce with an
 * O_EXCL create, so the second visitor to the same link is refused. That is
 * strictly stronger than the IP binding Hestia's phpMyAdmin handoff uses, and
 * it has none of the guesswork — the IP a node's PHP computes depends on how
 * the app is fronted, and getting it wrong lands every customer on a login page.
 *
 * ---------------------------------------------------------------------------
 * FAILING CLOSED
 * ---------------------------------------------------------------------------
 * With no WEBMAIL_SSO_KEY this module is simply off: `enabled()` is false, no
 * link is ever signed, and the caller falls back to the vault and then to plain
 * webmail. Half-configured is not a state this can reach — a key here with no
 * plugin on the node produces a link the node ignores, which is a login page,
 * which is where everybody was before any of this existed.
 */

const crypto = require('node:crypto');

const { WEBMAIL_URL } = require('./config');

/** Shared with `$config['vesopa_sso_key']` in the Roundcube plugin. */
const KEY = process.env.WEBMAIL_SSO_KEY || '';

/**
 * Sixty seconds.
 *
 * Long enough for a redirect on a bad connection, short enough that a link in
 * a browser history, a proxy log or a shoulder-surfed URL bar is already dead.
 * The plugin independently refuses anything expiring more than 300 seconds out,
 * so a panel misconfigured to mint hour-long links cannot make them work.
 */
const TTL_SECONDS = 60;

const enabled = () => KEY.length >= 32;

/**
 * A signed, single-use URL that opens one mailbox.
 *
 * Returns null when the feature is off, which is the caller's cue to fall back
 * rather than an error to report — being off is a supported configuration.
 */
function linkFor(address) {
  if (!enabled()) return null;
  const clean = String(address || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) return null;

  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto
    .createHmac('sha256', KEY)
    .update(`${clean}\n${expiry}\n${nonce}`)
    .digest('hex');

  const url = new URL(WEBMAIL_URL);
  url.searchParams.set('vu', clean);
  url.searchParams.set('ve', String(expiry));
  url.searchParams.set('vn', nonce);
  url.searchParams.set('vs', signature);
  return url.toString();
}

/** For the admin's status page and preflight. Never returns the key. */
function status() {
  return {
    enabled: enabled(),
    webmail: WEBMAIL_URL,
    ttlSeconds: TTL_SECONDS,
    detail: enabled()
      ? 'Mailbox links open the inbox directly.'
      : 'WEBMAIL_SSO_KEY is not set — mailbox links go to the webmail login page.',
  };
}

module.exports = { enabled, linkFor, status, TTL_SECONDS };
