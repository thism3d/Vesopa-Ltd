/**
 * Signing customers into the node's own tools without asking for a password.
 *
 * The customer already proved who they are when they signed into our panel.
 * Making them type a second password to open phpMyAdmin is a password they
 * will write down, reuse, or lose — so we hand them over instead.
 *
 * ## How Hestia's phpMyAdmin handoff works
 *
 * `/usr/share/phpmyadmin/hestia-sso.php` accepts a signed link. On a good
 * signature it calls `v-add-database-temp-user`, which mints a **throwaway
 * MySQL user** — random name, random password, granted on exactly one
 * database, with a TTL — drops those into phpMyAdmin's signon session, and
 * redirects to the app already logged in.
 *
 * That is the part worth keeping: nothing here ever needs the customer's real
 * database password, so we never have to store one in a form we could read
 * back. If this file leaks, it grants nothing on its own.
 *
 * ## The signature
 *
 *   token = bcrypt(database + user + ip + exp + SSO_KEY)
 *
 * checked on the node with PHP's `password_verify`. bcrypt's `$2a$`/`$2b$`
 * output (bcryptjs) and PHP's `$2y$` are the same algorithm and verify against
 * each other, so no shim is needed. The node also enforces `exp + 60 > now`,
 * meaning a minted link is dead a minute after it is made — it cannot be
 * shared, bookmarked, or replayed out of a browser history.
 *
 * ## The IP, which is the fiddly bit
 *
 * The node binds the link to the visitor's IP as *the node's PHP* computes it,
 * and that value depends on how phpMyAdmin is fronted on that particular box
 * (direct, behind nginx, behind Cloudflare). There is no way to know it from
 * here, so the strategy is configurable and `candidateIps()` documents the
 * shapes it can take. Get it wrong and the customer simply lands on the normal
 * phpMyAdmin login page — degraded, never broken, and never a security hole:
 * a wrong IP makes the signature fail closed.
 *
 * Note on bcrypt's 72-byte input limit: both sides truncate identically, so a
 * long database name cannot break verification. It can, however, push the key
 * off the end of the payload — keep database and user names sane.
 */

const bcrypt = require('bcryptjs');

/** The `PHPMYADMIN_KEY` baked into the node's hestia-sso.php. */
const SSO_KEY = process.env.HESTIA_SSO_KEY || '';

/**
 * Where the node serves phpMyAdmin, e.g. https://hosting.example.com/phpmyadmin
 * (the path is Hestia's DB_PMA_ALIAS). No trailing slash.
 */
const PMA_URL = (process.env.HESTIA_PMA_URL || '').replace(/\/+$/, '');

/** Likewise for phpPgAdmin — DB_PGA_ALIAS. Only used once the shim is installed. */
const PGA_URL = (process.env.HESTIA_PGA_URL || '').replace(/\/+$/, '');

/**
 * How the node sees the visitor. One of:
 *   client              the visitor's own address           (node reached directly)
 *   loopback            "127.0.0.1"                         (node behind its own proxy)
 *   loopback+client     "127.0.0.1|<visitor>"               (proxied, forwarding the header)
 *   server+client       "<node ip>|<visitor>"               (the node's second variant)
 * Determined empirically per node — see scripts/check-sso-ip.js.
 */
const IP_MODE = process.env.HESTIA_SSO_IP_MODE || 'client';

/** The node's own public address, needed only by the `server+client` shape. */
const SERVER_IP = process.env.HESTIA_SERVER_IP || '';

const configured = () => Boolean(SSO_KEY && PMA_URL);

/**
 * The visitor's address as this app sees it. Express is configured with
 * `trust proxy`, so req.ip is already the real client rather than our proxy.
 * IPv4-mapped IPv6 (::ffff:1.2.3.4) is unwrapped because PHP reports the
 * plain form and the two must match byte for byte.
 */
function clientIp(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || '');
  return raw.replace(/^::ffff:/, '');
}

/**
 * Every plausible spelling of "who is visiting", best guess first. Used by the
 * probe script to find which one a given node actually agrees with.
 */
function candidateIps(req) {
  const ip = clientIp(req);
  const out = [
    { mode: 'client', value: ip },
    { mode: 'loopback', value: '127.0.0.1' },
    { mode: 'loopback+client', value: `127.0.0.1|${ip}` },
  ];
  if (SERVER_IP) out.push({ mode: 'server+client', value: `${SERVER_IP}|${ip}` });
  return out;
}

/** The address string for the configured mode. */
function ipForMode(req, mode = IP_MODE) {
  const found = candidateIps(req).find((c) => c.mode === mode);
  if (found) return found.value;
  // An unknown mode must not silently sign a link that cannot work.
  throw new Error(`Unknown HESTIA_SSO_IP_MODE: ${mode}`);
}

/**
 * Sign a handoff link.
 *
 * @param {object} p
 * @param {string} p.username  the Hestia account (v-list-user name)
 * @param {string} p.database  the full database name, e.g. `bob_shop`
 * @param {string} p.ip        the visitor as the node will see them
 * @param {string} [p.baseUrl] override the tool's base URL
 * @param {number} [p.now]     injectable clock, for tests
 */
function signLink({
  username, database, ip, baseUrl = PMA_URL, now = Date.now(),
}) {
  if (!SSO_KEY) throw new Error('HESTIA_SSO_KEY is not set.');
  if (!baseUrl) throw new Error('No base URL configured for that tool.');

  // Seconds, and deliberately not rounded up: the node allows exp + 60.
  const exp = Math.floor(now / 1000);
  const payload = `${database}${username}${ip}${exp}${SSO_KEY}`;

  /*
   * bcryptjs emits `$2b$`. PHP's crypt_blowfish — which is what password_verify
   * runs on — reliably understands `$2a$`, `$2x$` and `$2y$`, and `$2b$` is not
   * dependable across PHP builds. The prefixes differ only in how bytes above
   * 127 are handled, and this payload is a database name, a username, an IP,
   * digits and the key: ASCII throughout. So relabelling is safe, and it is the
   * difference between the handoff working and silently falling back to a
   * login form on some nodes.
   */
  const token = `$2y$${bcrypt.hashSync(payload, 10).slice(4)}`;

  const qs = new URLSearchParams({
    user: username,
    database,
    exp: String(exp),
    hestia_token: token,
  });
  return `${baseUrl}/hestia-sso.php?${qs.toString()}`;
}

/**
 * A one-click phpMyAdmin link for a database the customer owns.
 * The caller must have already checked ownership — this signs whatever it is
 * given, exactly like a redirect helper should.
 */
function phpMyAdminUrl(req, { username, database }) {
  return signLink({ username, database, ip: ipForMode(req) });
}

/**
 * The same for phpPgAdmin. Hestia ships no SSO shim for it, so this only works
 * on a node where ours has been installed — hence the separate base URL and
 * the explicit failure rather than a link that lands on a login form.
 */
function phpPgAdminUrl(req, { username, database }) {
  if (!PGA_URL) throw new Error('phpPgAdmin SSO is not set up on this node.');
  return signLink({ username, database, ip: ipForMode(req), baseUrl: PGA_URL });
}

/**
 * Where to send the customer to end a session. Hitting this drops the
 * temporary database user immediately rather than waiting for its TTL.
 */
function logoutUrl(kind = 'mysql') {
  const base = kind === 'pgsql' ? PGA_URL : PMA_URL;
  return base ? `${base}/hestia-sso.php?logout=1` : '';
}

function status() {
  return {
    configured: configured(),
    key_set: Boolean(SSO_KEY),
    phpmyadmin: PMA_URL || '(not set)',
    phppgadmin: PGA_URL || '(not set)',
    ip_mode: IP_MODE,
  };
}

module.exports = {
  configured,
  clientIp,
  candidateIps,
  ipForMode,
  signLink,
  phpMyAdminUrl,
  phpPgAdminUrl,
  logoutUrl,
  status,
};
