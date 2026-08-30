/**
 * HestiaCP — the node that actually runs the websites.
 *
 * The customer never sees Hestia. They see our panel; this file is the only
 * thing that knows Hestia exists. That is the whole product decision: like
 * Hostinger, one interface we control, not a cPanel login handed out.
 *
 * ## How Hestia's API works
 *
 * A single endpoint, `https://host:2083/api/`, POSTed as urlencoded form data:
 *
 *   user=admin & password=… & returncode=yes & cmd=v-add-user & arg1=… & arg2=…
 *
 * With `returncode=yes` it answers with a bare exit code — "0" for success,
 * anything else an error number. With `returncode=no` it answers with data,
 * and `arg…=json` on the list commands returns JSON. Both are used below.
 *
 * ## Mock mode
 *
 * HESTIA_MODE=mock records what *would* have been run and returns success.
 * That is the default, so the panel is fully clickable before DNS points at
 * the Azure box — and so a mistake in development cannot create real accounts.
 */

const https = require('https');

const MODE = (process.env.HESTIA_MODE || 'mock').toLowerCase();
const HOST = process.env.HESTIA_HOST || '';
/*
 * 2083, not 8083.
 *
 * 8083 was Hestia's port up to 1.8; 1.9 moved the panel and the API to 2083 and
 * the node this app drives is 1.9.6. A default that names a port nothing is
 * listening on fails as a connection timeout twenty seconds later, which reads
 * like a firewall problem rather than a wrong number.
 */
const PORT = Number(process.env.HESTIA_PORT || 2083);
const ADMIN_USER = process.env.HESTIA_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.HESTIA_ADMIN_PASSWORD || '';

/**
 * An access key — `ID:SECRET`, made by `v-add-access-key`. Preferred over the
 * admin password because a key carries an explicit list of commands it is
 * allowed to run, so a hole in the web tier cannot reach `v-delete-user`.
 * The admin password stays supported as a fallback for a node without a key.
 */
const API_KEY = process.env.HESTIA_API_KEY || '';
const VERIFY_TLS = String(process.env.HESTIA_VERIFY_TLS || 'true') === 'true';
/**
 * The name to present in SNI and verify the certificate against, when it is
 * not the same string as HOST. Set this when reaching the node by IP or over
 * loopback while still wanting a verified connection.
 */
const SERVER_NAME = process.env.HESTIA_SERVER_NAME || '';
const DEFAULT_PACKAGE = process.env.HESTIA_DEFAULT_PACKAGE || 'default';

const TIMEOUT_MS = 20_000;

/**
 * Issuing a certificate is not like the other calls.
 *
 * Everything else here is a config edit that returns in under a second, and
 * twenty seconds is a generous ceiling for those. A Let's Encrypt issuance is a
 * conversation with an external service — register, request, answer the
 * challenge, wait for validation, collect — and thirty to ninety seconds is
 * ordinary, not slow.
 *
 * At the shared timeout it therefore failed almost every time, and failed in
 * the worst possible way: the request kept running on the node and often
 * SUCCEEDED after we had already given up and written the attempt down as a
 * failure. The panel then showed "not issued" for a site that had a working
 * certificate, and the retry button spent Let's Encrypt rate limit reissuing
 * one that already existed.
 */
const SSL_TIMEOUT_MS = 150_000;

/**
 * Hestia's exit codes, as messages a support agent can act on.
 *
 * TAKEN FROM `/usr/local/hestia/func/main.sh` ON THE NODE, not from memory.
 * An earlier version of this table was off by a place or two in the middle —
 * it had 5 as "does not exist" when 5 is "suspended" and 3 is "does not
 * exist" — and NOT_EXIST is the one code this file branches on rather than
 * merely prints (see userExists), so a wrong number there is not a cosmetic
 * bug: it turns "no such user" into a thrown error and stops provisioning.
 * If Hestia ever renumbers these, that file is the source.
 */
const E_NOT_EXIST = 3;

const EXIT_CODES = {
  1: 'The server rejected the arguments.',
  2: 'That value is not valid.',
  3: 'That object does not exist.',
  4: 'That object already exists.',
  5: 'That account is suspended.',
  6: 'That account is not suspended.',
  7: 'That object is still in use.',
  8: 'The package limit was reached.',
  9: 'The password was rejected.',
  /*
   * In practice this is almost always the API allow-list rather than a
   * permission on the object: Hestia's `API_ALLOWED_IP` defaults to 127.0.0.1,
   * so the API answers everything from anywhere else with a flat 10. Worth
   * naming, because "permission denied" sends you looking at the account.
   */
  10: 'The node refused this address — check API_ALLOWED_IP in hestia.conf.',
  11: 'That feature is disabled on the server.',
  12: 'The server could not parse its own config.',
  13: 'The server is out of disk space.',
  14: 'The server is too busy — try again shortly.',
  15: 'The server could not connect to a service it needs.',
  16: 'The FTP server refused the request.',
  17: 'The database server refused the request.',
  19: 'The server could not apply the update.',
  20: 'A service failed to restart on the server.',
};

class HestiaError extends Error {
  constructor(message, { code, cmd } = {}) {
    super(message);
    this.name = 'HestiaError';
    this.code = code || 'hestia_error';
    this.cmd = cmd;
  }
}

const isLive = () => MODE === 'live';

/** What mock mode would have run, so it is visible in tests and the admin. */
const mockCalls = [];

/**
 * Run one Hestia command.
 *
 * @param {string} cmd   e.g. 'v-add-user'
 * @param {string[]} args positional, in Hestia's documented order
 * @param {object} opts  `json: true` to parse a data response instead of a code
 */
async function run(cmd, args = [], { json = false, timeoutMs = TIMEOUT_MS } = {}) {
  if (!isLive()) {
    mockCalls.push({ cmd, args, at: new Date().toISOString() });
    if (mockCalls.length > 200) mockCalls.shift();
    console.log(`[hestia:mock] ${cmd} ${args.map((a) => (/password/i.test(cmd) ? '***' : a)).join(' ')}`);
    return json ? {} : { ok: true, mock: true };
  }

  if (!HOST || !(API_KEY || ADMIN_PASSWORD)) {
    throw new HestiaError('Hosting node is not configured.', { code: 'no_credentials', cmd });
  }

  // A key authenticates as `hash`; without one we fall back to admin+password.
  const body = new URLSearchParams(
    API_KEY
      ? { hash: API_KEY, returncode: json ? 'no' : 'yes', cmd }
      : {
        user: ADMIN_USER, password: ADMIN_PASSWORD, returncode: json ? 'no' : 'yes', cmd,
      },
  );
  args.forEach((arg, i) => body.set(`arg${i + 1}`, String(arg)));
  if (json) body.set(`arg${args.length + 1}`, 'json');

  let res;
  try {
    res = await post(body, timeoutMs);
  } catch (err) {
    if (err.code === 'timeout') {
      throw new HestiaError('The hosting node did not respond in time.', { code: 'timeout', cmd });
    }
    throw new HestiaError(`Could not reach the hosting node: ${err.message}`, { code: 'network', cmd });
  }

  const text = res.body.trim();

  /*
   * THE EXIT CODE IS IN A HEADER, and it is the only place it is always
   * readable.
   *
   * With returncode=yes the body is a bare number and either would do. With
   * returncode=no — every json call below — a failure answers `Error: …` prose
   * and the number appears ONLY as `Hestia-Exit-Code`. Reading it here rather
   * than in the returncode=yes branch is what lets userExists() and
   * dnsDomainExists() tell "no such user" from "the node is unreachable": they
   * branch on err.code, and before this the json path could only ever raise a
   * parse failure with no code attached, so a missing user threw instead of
   * answering false and provisioning stopped on a healthy node.
   */
  const headerCode = Number(res.headers['hestia-exit-code']);
  const exitCode = Number.isInteger(headerCode) ? headerCode : null;

  if (json) {
    if (exitCode) {
      throw new HestiaError(EXIT_CODES[exitCode] || `Server returned error ${exitCode}.`, { code: exitCode, cmd });
    }
    /*
     * A data-mode failure answers HTTP 200 with `Error: …` prose and NO exit
     * code anywhere — the header above is set by the API's own error handler,
     * which a command that merely returns non-zero never reaches. So the one
     * outcome callers branch on has to be read out of the sentence.
     *
     * This is a fallback, not the mechanism: exists() below asks the same
     * question in code mode, where the answer is the number. This branch is
     * here so that a `doesn't exist` reaching any other json call still
     * arrives as E_NOT_EXIST rather than as an unhelpful generic refusal.
     */
    if (/^Error:/i.test(text)) {
      const missing = /(doesn't|does not) exist/i.test(text);
      throw new HestiaError(
        missing ? EXIT_CODES[E_NOT_EXIST] : `Node refused the request: ${text.slice(0, 160)}`,
        { code: missing ? E_NOT_EXIST : 'refused', cmd },
      );
    }
    if (res.status >= 400) {
      throw new HestiaError(`Node refused the request: ${text.slice(0, 160)}`, { code: 'refused', cmd });
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HestiaError(`Node returned unparseable data for ${cmd}.`, { code: 'bad_response', cmd });
    }
  }

  // returncode=yes gives a bare number. Anything else means the API itself
  // refused — usually a wrong admin password or an IP not in the allow list.
  if (!/^\d+$/.test(text)) {
    throw new HestiaError(`Node refused the request: ${text.slice(0, 160)}`, { code: 'refused', cmd });
  }
  const code = Number(text);
  if (code !== 0) {
    throw new HestiaError(EXIT_CODES[code] || `Server returned error ${code}.`, { code, cmd });
  }
  return { ok: true };
}

/**
 * One POST to the node, on Node's own https client rather than fetch.
 *
 * fetch() IS THE WRONG CLIENT FOR THIS ONE CALL. It has no per-request TLS
 * option, so `HESTIA_VERIFY_TLS=false` had nothing to switch and the flag sat
 * in .env doing literally nothing — the old code read it and then wrote
 * `...(VERIFY_TLS ? {} : {})`, which is the same empty object either way. A
 * node still on its self-signed install cert was therefore unreachable no
 * matter what the config said, and the only escape was
 * NODE_TLS_REJECT_UNAUTHORIZED, which turns verification off for the whole
 * process — including the calls to the registrar and the payment gateways.
 * https.request takes `rejectUnauthorized` per request, so the exception stays
 * on the one connection it is meant for.
 */
function post(body, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload = body.toString();
    const req = https.request(
      {
        host: HOST,
        port: PORT,
        path: '/api/',
        method: 'POST',
        rejectUnauthorized: VERIFY_TLS,
        // The node answers on its panel hostname's certificate. When HOST is an
        // IP or loopback — which is how you reach a node whose API is limited to
        // 127.0.0.1 — SNI has to name the certificate, or a verified connection
        // fails on a name mismatch that is not actually a mismatch.
        ...(SERVER_NAME ? { servername: SERVER_NAME } : {}),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('timeout', () => {
      const err = new Error('timed out');
      err.code = 'timeout';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * The account name on the node: `u` and a serial, e.g. `u265966`.
 *
 * NOBODY SIGNS IN WITH THIS. Customers authenticate to this site with their
 * email address and password, and to Hestia's own panel with this name and the
 * password from their welcome email. It is an internal handle, so it is chosen
 * to be stable and unambiguous rather than memorable.
 *
 * It used to be derived from the email's local part — `info@` became `info`,
 * `info2`, `info3` as they collided. Three problems with that, and the third is
 * the one that decided it:
 *
 *   - It leaks. The Hestia username shows up in paths, in mail headers and in
 *     SFTP; deriving it from the address publishes part of the customer's email
 *     to anyone who sees a path.
 *   - It collides constantly. `info@`, `admin@` and `sales@` are the normal
 *     case, so the readable name is usually `info7` anyway, which is no more
 *     meaningful than a serial and is now ALSO wrong-looking.
 *   - It is not stable. A customer who changes their email address has a
 *     username that no longer matches it, which is worse than one that never
 *     claimed to.
 *
 * Hestia's own constraints: lowercase, alphanumeric, must not begin with a
 * digit, and short. The `u` prefix satisfies the digit rule.
 *
 * Sequential rather than random, which does mean the number reveals roughly how
 * many accounts came before it. Starting the run high is what takes the sting
 * out of that — `u265966` says nothing useful about the size of the business.
 */
function serialUsername(n) {
  return `u${Math.trunc(Number(n))}`;
}

/**
 * Does this object exist? Asked in CODE MODE, deliberately.
 *
 * `returncode=yes` makes the whole response the exit code — "0" present, "3"
 * missing — so the answer is a number rather than a sentence that has to be
 * pattern-matched. The list commands in data mode do not carry the code
 * anywhere, in a header or otherwise, so this is the only place the question
 * gets a machine-readable answer.
 *
 * Anything that is NOT "missing" is re-thrown. A node that is unreachable, or
 * a password that has been rotated, must not read as "no such account" — that
 * is the answer that makes provisioning go on to create one.
 */
async function exists(cmd, args) {
  try {
    await run(cmd, args);
    return true;
  } catch (err) {
    if (err.code === E_NOT_EXIST) return false;
    throw err;
  }
}

async function userExists(username) {
  if (!isLive()) return false;
  return exists('v-list-user', [username]);
}

/** v-add-user USER PASSWORD EMAIL [PACKAGE] [NAME] */
async function addUser({ username, password, email, package: pkg = DEFAULT_PACKAGE, name = '' }) {
  await run('v-add-user', [username, password, email, pkg, name]);
  return { ok: true, username };
}

/**
 * Every account on the node, keyed by username.
 *
 * Returns Hestia's own record verbatim — CONTACT, NAME, PACKAGE, SUSPENDED and
 * the usage counters — because the one caller that wants this
 * (scripts/adopt-hestia-users.js) is reconciling our database against the node
 * and needs the node's version of the truth, not a tidied subset of it.
 */
async function listUsers() {
  if (!isLive()) return {};
  return run('v-list-users', [], { json: true });
}

async function changeUserPassword({ username, password }) {
  await run('v-change-user-password', [username, password]);
  return { ok: true };
}

async function changeUserPackage({ username, package: pkg }) {
  await run('v-change-user-package', [username, pkg, 'yes']);
  return { ok: true };
}

async function suspendUser(username) {
  await run('v-suspend-user', [username]);
  return { ok: true };
}

async function unsuspendUser(username) {
  await run('v-unsuspend-user', [username]);
  return { ok: true };
}

/** Irreversible. Only ever called from the admin, never from a customer route. */
async function deleteUser(username) {
  await run('v-delete-user', [username]);
  return { ok: true };
}

/**
 * The user packages this node has.
 *
 * Worth its own function because `plans.hestia_package` is a STRING NAMING
 * SOMETHING ON ANOTHER MACHINE, with nothing keeping the two in step. If the
 * package is missing, `v-add-user` fails — and it fails after the customer has
 * paid, because that is the order the checkout runs in. So the names are
 * checkable from our side, and src/routes/admin.js checks them.
 */
async function listPackages() {
  if (!isLive()) return [];
  const data = await run('v-list-user-packages', [], { json: true });
  return Object.keys(data);
}

/**
 * Which active plans name a package this node does not have?
 *
 * Returns [] when the node is mocked or cannot be reached — a check that
 * cannot run is not the same as a check that failed, and turning an
 * unreachable node into "every plan is broken" would put a red banner on the
 * admin every time the network hiccupped.
 */
async function missingPackages(planPackages) {
  if (!isLive()) return [];
  let have;
  try {
    have = await listPackages();
  } catch {
    return [];
  }
  if (!have.length) return [];
  return [...new Set(planPackages.filter(Boolean))].filter((p) => !have.includes(p));
}

/** Disk, bandwidth and object counts — what the panel's usage bars read. */
async function userStats(username) {
  if (!isLive()) {
    return {
      mock: true,
      disk_used_mb: 412,
      disk_quota_mb: 25_600,
      bandwidth_used_mb: 1_840,
      web_domains: 1,
      databases: 1,
      mail_accounts: 2,
      suspended: false,
    };
  }
  const data = await run('v-list-user', [username], { json: true });
  const u = data[username] || {};
  return {
    disk_used_mb: Number(u.U_DISK || 0),
    disk_quota_mb: u.DISK_QUOTA === 'unlimited' ? 0 : Number(u.DISK_QUOTA || 0),
    bandwidth_used_mb: Number(u.U_BANDWIDTH || 0),
    web_domains: Number(u.U_WEB_DOMAINS || 0),
    databases: Number(u.U_DATABASES || 0),
    mail_accounts: Number(u.U_MAIL_ACCOUNTS || 0),
    suspended: String(u.SUSPENDED || 'no') === 'yes',
  };
}

// ---------------------------------------------------------------------------
// Websites
// ---------------------------------------------------------------------------

/**
 * `v-add-domain` — website, DNS zone AND mail domain, in one call.
 *
 * The name undersells it and has caused a bug already. Use `addWebsite` below
 * when you want only the vhost.
 */
async function addWebDomain({ username, domain }) {
  await run('v-add-domain', [username, domain]);
  return { ok: true, domain };
}

/**
 * The vhost and nothing else.
 *
 * `v-add-web-domain` is the narrow one: no zone, no mail domain. It exists for
 * subdomains, where DNS and mail are the customer's choice rather than an
 * automatic consequence of adding a name — and where a DNS zone is usually the
 * WRONG default, because a zone for `shop.example.com` only means anything if
 * the parent delegates to it, and otherwise just shadows a record the customer
 * already has at their own provider.
 */
async function addWebsite({ username, domain }) {
  await run('v-add-web-domain', [username, domain]);
  return { ok: true, domain };
}

/**
 * `v-delete-domain` — the mirror of addWebDomain: website, DNS and mail
 * together. Deleting the web domain alone would leave the zone answering.
 */
async function deleteWebDomain({ username, domain }) {
  await run('v-delete-domain', [username, domain]);
  return { ok: true };
}

/**
 * The websites on an account.
 *
 * MOCK MODE ANSWERS WITH SOMETHING, not with nothing. An empty list is a
 * different shape from any real answer, and every page that reads this then
 * renders its "you have no websites yet" branch on a laptop — so the redirect
 * form, the app installer's target picker and the runtime page could not be
 * looked at during development at all. Two bugs have already come out of a
 * mock that differed from the live answer; this is the same trap.
 *
 * The names are obviously invented, and they match the domains the seed data
 * puts in the panel so the two halves agree with each other.
 */
async function listWebDomains(username) {
  if (!isLive()) {
    return [
      {
        domain: 'janesbakery.co.uk',
        ip: '203.0.113.10',
        ssl: true,
        letsencrypt: true,
        suspended: false,
        disk_mb: 148,
        redirect: '',
        redirect_code: null,
      },
      {
        domain: 'oldshop.co.uk',
        ip: '203.0.113.10',
        ssl: true,
        letsencrypt: true,
        suspended: false,
        disk_mb: 2,
        // One of them redirects, so the "already on" branch of the panel's
        // redirect card is reachable without a live node.
        redirect: 'janesbakery.co.uk',
        redirect_code: 301,
      },
    ];
  }
  const data = await run('v-list-web-domains', [username], { json: true });
  return Object.entries(data).map(([domain, d]) => ({
    domain,
    ip: d.IP,
    ssl: String(d.SSL || 'no') === 'yes',
    letsencrypt: String(d.LETSENCRYPT || 'no') === 'yes',
    suspended: String(d.SUSPENDED || 'no') === 'yes',
    disk_mb: Number(d.U_DISK || 0),
    redirect: d.REDIRECT || '',
    redirect_code: Number(d.REDIRECT_CODE || 0) || null,
  }));
}

/**
 * Issue and install a Let's Encrypt certificate for a WEBSITE.
 *
 * THE FOURTH ARGUMENT IS NOT "ALSO DO MAIL". It is "do mail INSTEAD".
 *
 * `v-add-letsencrypt-domain USER DOMAIN [ALIASES] [MAIL]`, and inside it:
 *
 *     if [ -n "$mail" ]; then
 *         root_domain=$domain
 *         domain="mail.$root_domain"      # <- the target is REPLACED
 *
 * This used to pass a hardcoded 'yes' there, which meant no website on this
 * node has ever been issued a certificate. Every call did one of two things:
 * on a domain with mail it quietly issued a cert for `mail.<domain>` and left
 * the actual site on plain HTTP; on a domain WITHOUT mail — which is every
 * subdomain, by design — it aborted with "mail domain <name> doesn't exist"
 * and issued nothing at all. Either way the padlock never appeared and nothing
 * recorded why.
 *
 * So `mail` defaults to false and the website is the target. Mail is served
 * under one hostname for everybody (see MAIL_HOSTNAME in config.js), so there
 * is no per-customer mail certificate to issue here at all.
 *
 * ALIASES ARE THE CALLER'S DECISION, not a `www.` bolted on unconditionally.
 * A cert request fails as a whole if any name in it fails validation, so
 * asking for `www.shop.example.com` — which almost never resolves — would take
 * the subdomain's own certificate down with it.
 *
 * Fails until the domain actually resolves to this node: that is the ACME
 * challenge doing its job, not a bug, and the panel says so in those words
 * rather than showing an exit code.
 */
/**
 * Send every visitor somewhere else.
 *
 * `v-add-web-domain-redirect USER DOMAIN TARGET [CODE]`. The target may be a
 * bare hostname — which is how Hestia's own examples write it — or a full URL
 * when a path is wanted; it is passed through as given, having been validated
 * by the caller.
 *
 * THE CODE IS THE WHOLE DECISION and it is the one customers get wrong. 301
 * says "permanently", and browsers and search engines cache it hard — some
 * browsers keep a 301 until their cache is cleared, so a mistake follows a
 * visitor around long after the server has been fixed. 302 says "for now" and
 * is not cached, which makes it the right answer for anything temporary and
 * the safe answer while testing. The panel says this in those words rather
 * than offering two numbers.
 */
async function setRedirect({
  username, domain, target, code = 301,
}) {
  await run('v-add-web-domain-redirect', [username, domain, target, String(code)]);
  return { ok: true };
}

async function clearRedirect({ username, domain }) {
  await run('v-delete-web-domain-redirect', [username, domain]);
  return { ok: true };
}

async function enableSSL({ username, domain, aliases = '', mail = false }) {
  await run(
    'v-add-letsencrypt-domain',
    [username, domain, aliases, mail ? 'yes' : 'no'],
    { timeoutMs: SSL_TIMEOUT_MS },
  );
  return { ok: true, domain };
}

/**
 * What certificate does this website actually have?
 *
 * Read from the node rather than from anything we wrote down, for the same
 * reason mailbox counts are: support can issue or remove a certificate by hand,
 * and a database that disagrees with the box is worse than no record at all.
 */
async function webDomainSsl({ username, domain }) {
  if (!isLive()) return { ssl: false, letsencrypt: false };
  const all = await listWebDomains(username);
  const found = all.find((d) => d.domain === domain);
  return found
    ? { ssl: found.ssl, letsencrypt: found.letsencrypt }
    : { ssl: false, letsencrypt: false, missing: true };
}

async function forceHttps({ username, domain }) {
  await run('v-add-web-domain-ssl-force', [username, domain]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Databases, mail, FTP
// ---------------------------------------------------------------------------

async function addDatabase({ username, name, dbUser, password, type = 'mysql' }) {
  await run('v-add-database', [username, name, dbUser, password, type]);
  return { ok: true, database: `${username}_${name}` };
}

async function listDatabases(username) {
  if (!isLive()) return [];
  const data = await run('v-list-databases', [username], { json: true });
  return Object.entries(data).map(([name, d]) => ({
    name,
    user: d.DBUSER,
    type: d.TYPE,
    host: d.HOST,
    size_mb: Number(d.U_DISK || 0),
  }));
}

async function deleteDatabase({ username, name }) {
  await run('v-delete-database', [username, name]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// DNS
//
// The zone lives HERE, on the node, because our nameservers are this node — so
// a customer editing an MX record in the panel is editing the file that answers
// the query. There is no second copy at the registrar to keep in step, and no
// mirror of the records in our own database either: a mirror would be a second
// source of truth for something a support engineer can also change on the box,
// and the day the two disagree is the day nobody can say which is live.
// ---------------------------------------------------------------------------

/** The record types a customer is offered. Anything else is refused. */
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA'];

/**
 * The address this node's websites answer on, as the outside world sees it.
 *
 * Hestia's system IP is the address on the interface, which on a cloud box is
 * very often a private one — 10.128.0.14 here, behind GCP's NAT. `NAT` on the
 * IP record is the public address, and it is the one that belongs in a DNS
 * zone: an A record pointing at 10.128.0.14 sends the whole internet nowhere.
 *
 * Cached for the life of the process. A node's address changes about as often
 * as the node does, and this is on the path of every domain that verifies.
 */
let cachedPublicIp = null;

async function publicIp() {
  if (cachedPublicIp) return cachedPublicIp;
  if (!isLive()) return '';
  const data = await run('v-list-sys-ips', [], { json: true });
  const entries = Object.entries(data || {});
  if (!entries.length) return '';
  const [ip, meta] = entries[0];
  cachedPublicIp = (meta && meta.NAT) || ip;
  return cachedPublicIp;
}

/**
 * Create a DNS zone.
 *
 * THE IP IS NOT OPTIONAL, whatever the old default here implied. Hestia's
 * `v-add-dns-domain` takes it as `$3` and substitutes it straight into the zone
 * template as `%ip%` — there is no fallback to the user's own address. Passing
 * an empty string, which this function used to do by default, produced a zone
 * whose apex A record, mail A record and SPF were all blank: the domain
 * resolved to nothing at all, and it did so silently, because Hestia reports
 * the zone as created and every list command shows it as present.
 *
 * That is why a customer could point their nameservers at us, see the domain
 * verify, see the site created, and still have nothing answer.
 */
async function addDnsDomain({ username, domain, ip = '' }) {
  const address = ip || await publicIp();
  if (!address && isLive()) {
    throw new HestiaError(
      'Refusing to create a DNS zone with no IP — every record in it would be empty.',
      { code: 'no_ip', cmd: 'v-add-dns-domain' },
    );
  }
  await run('v-add-dns-domain', [username, domain, address]);
  return { ok: true, domain, ip: address };
}

async function dnsDomainExists({ username, domain }) {
  if (!isLive()) return false;
  return exists('v-list-dns-domain', [username, domain]);
}

/**
 * The records in a zone.
 *
 * Hestia keys them by ID and the ID is what every edit and delete is addressed
 * by, so it is carried through rather than the record name — two `A` records
 * called `www` are legal, and a delete by name would remove the wrong one.
 */
async function listDnsRecords({ username, domain }) {
  if (!isLive()) return [];
  const data = await run('v-list-dns-records', [username, domain], { json: true });
  return Object.entries(data).map(([id, r]) => ({
    id: String(id),
    name: r.RECORD,
    type: r.TYPE,
    value: r.VALUE,
    priority: r.PRIORITY === '' || r.PRIORITY == null ? null : Number(r.PRIORITY),
    ttl: Number(r.TTL || 0),
    suspended: String(r.SUSPENDED || 'no') === 'yes',
  }));
}

/**
 * v-add-dns-record USER DOMAIN RECORD TYPE VALUE [PRIORITY] [ID] [RESTART] [TTL]
 *
 * NINE ARGUMENTS, AND TTL IS THE NINTH. The signature above is copied from
 * `/usr/local/hestia/bin/v-add-dns-record` on the node; an earlier version of
 * this call passed eight and put the TTL where RESTART goes, so every record a
 * customer added got the zone's default TTL and the number they typed was read
 * as a restart flag. It failed silently in the direction that looks like it
 * worked — the record appears, just never with the lifetime that was asked for.
 */
async function addDnsRecord({
  username, domain, name, type, value, priority = '', ttl = 3600,
}) {
  await run('v-add-dns-record', [username, domain, name, type, value, priority, '', 'yes', ttl]);
  return { ok: true };
}

/** v-change-dns-record USER DOMAIN ID RECORD TYPE VALUE [PRIORITY] [RESTART] [TTL] */
async function changeDnsRecord({
  username, domain, id, name, type, value, priority = '', ttl = 3600,
}) {
  await run('v-change-dns-record', [username, domain, id, name, type, value, priority, 'yes', ttl]);
  return { ok: true };
}

async function deleteDnsRecord({ username, domain, id }) {
  await run('v-delete-dns-record', [username, domain, id]);
  return { ok: true };
}

async function addMailDomain({ username, domain }) {
  await run('v-add-mail-domain', [username, domain]);
  return { ok: true };
}

async function addMailAccount({ username, domain, account, password, quota = 1024 }) {
  await run('v-add-mail-account', [username, domain, account, password, quota]);
  return { ok: true, address: `${account}@${domain}` };
}

async function listMailDomains(username) {
  if (!isLive()) return [];
  const data = await run('v-list-mail-domains', [username], { json: true });
  return Object.entries(data).map(([domain, d]) => ({
    domain,
    // Hestia reports the count as ACCOUNTS here; U_MAIL_ACCOUNTS is the user
    // level total. Reading the wrong one made every domain report zero, which
    // is what the allowance is enforced against.
    accounts: Number(d.ACCOUNTS ?? d.U_MAIL_ACCOUNTS ?? 0),
    catchall: d.CATCHALL || '',
    dkim: String(d.DKIM || 'no') === 'yes',
    ssl: String(d.SSL || 'no') === 'yes',
    // Present means Hestia is publishing `mail.<domain>` as a webmail vhost.
    // We take that off — see removeWebmailAlias.
    webmailAlias: d.WEBMAIL_ALIAS || '',
    suspended: String(d.SUSPENDED || 'no') === 'yes',
  }));
}

/**
 * How many mailboxes this account is using, across every mail domain on it.
 *
 * Counted on the NODE, not in our database. The allowance is enforced against
 * this number, and a count we keep ourselves would drift the first time support
 * added a mailbox by hand — in the direction that lets a customer exceed what
 * they bought.
 */
async function countMailAccounts(username) {
  if (!isLive()) return 0;
  const domains = await listMailDomains(username);
  return domains.reduce((sum, d) => sum + d.accounts, 0);
}

/**
 * Every mailbox on a domain, with what it forwards and answers.
 *
 * `FWD` and `ALIAS` are comma-separated in Hestia, and `FWD_ONLY` decides
 * whether a forwarded message is also kept — the difference between "send me a
 * copy at gmail" and "this address is only a redirect", which are entirely
 * different intentions and must not be shown as one.
 */
async function listMailAccounts({ username, domain }) {
  if (!isLive()) return [];
  const data = await run('v-list-mail-accounts', [username, domain], { json: true });
  return Object.entries(data).map(([account, d]) => ({
    account,
    address: `${account}@${domain}`,
    domain,
    quota_mb: d.QUOTA === 'unlimited' ? 0 : Number(d.QUOTA || 0),
    used_mb: Number(d.U_DISK || 0),
    aliases: String(d.ALIAS || '').split(',').map((a) => a.trim()).filter(Boolean),
    forwards: String(d.FWD || '').split(',').map((a) => a.trim()).filter(Boolean),
    forwardOnly: String(d.FWD_ONLY || '') === 'yes',
    autoreply: String(d.AUTOREPLY || 'no') === 'yes',
    suspended: String(d.SUSPENDED || 'no') === 'yes',
  }));
}

/** One mailbox, or null. Used by every page that acts on a single address. */
async function mailAccount({ username, domain, account }) {
  const all = await listMailAccounts({ username, domain });
  return all.find((a) => a.account === account) || null;
}

async function deleteMailAccount({ username, domain, account }) {
  await run('v-delete-mail-account', [username, domain, account]);
  return { ok: true };
}

async function changeMailPassword({ username, domain, account, password }) {
  await run('v-change-mail-account-password', [username, domain, account, password]);
  return { ok: true };
}

/** Quota in MB. 0 means unlimited, which is what Hestia calls it too. */
async function changeMailQuota({ username, domain, account, quotaMb }) {
  await run('v-change-mail-account-quota', [
    username, domain, account, Number(quotaMb) > 0 ? String(quotaMb) : 'unlimited',
  ]);
  return { ok: true };
}

// ---- Forwarding ------------------------------------------------------------
//
// Hestia replaces the whole forward list on each call rather than appending, so
// the caller sends the complete set every time and there is no add/remove pair
// to keep in step.

async function setMailForwards({ username, domain, account, forwards = [], forwardOnly = false }) {
  const list = forwards.map((f) => String(f).trim()).filter(Boolean).join(',');
  if (list) {
    await run('v-add-mail-account-forward', [username, domain, account, list]);
  } else {
    // Clearing is its own command; passing an empty string is rejected.
    await run('v-delete-mail-account-forward', [username, domain, account]).catch((err) => {
      if (err.code !== 3 && err.code !== 5) throw err;   // already had none
    });
  }

  /*
   * "Forward only" is a separate flag, and getting it wrong loses mail.
   *
   * With it set, nothing is kept in the mailbox here — the message goes to the
   * forward address and only there. It must never be left on when the customer
   * has removed their forwards, or every message would be delivered nowhere at
   * all.
   */
  const wantOnly = forwardOnly && Boolean(list);
  await run(wantOnly ? 'v-add-mail-account-fwd-only' : 'v-delete-mail-account-fwd-only',
    [username, domain, account]).catch((err) => {
    if (err.code !== 3 && err.code !== 5) throw err;
  });
  return { ok: true };
}

// ---- Aliases (extra addresses that land in the same mailbox) ---------------

async function setMailAliases({ username, domain, account, aliases = [] }) {
  const list = aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean).join(',');
  if (list) {
    await run('v-add-mail-account-alias', [username, domain, account, list]);
  } else {
    await run('v-delete-mail-account-alias', [username, domain, account]).catch((err) => {
      if (err.code !== 3 && err.code !== 5) throw err;
    });
  }
  return { ok: true };
}

// ---- Auto-reply ------------------------------------------------------------

async function setAutoreply({ username, domain, account, message }) {
  if (message && String(message).trim()) {
    await run('v-add-mail-account-autoreply', [username, domain, account, String(message)]);
  } else {
    await run('v-delete-mail-account-autoreply', [username, domain, account]).catch((err) => {
      if (err.code !== 3 && err.code !== 5) throw err;
    });
  }
  return { ok: true };
}

async function getAutoreply({ username, domain, account }) {
  if (!isLive()) return '';
  try {
    const data = await run('v-list-mail-account-autoreply', [username, domain, account], { json: true });
    // Hestia answers either a bare string or an object keyed by the account.
    if (typeof data === 'string') return data;
    const first = Object.values(data || {})[0];
    return typeof first === 'string' ? first : (first?.MESSAGE || '');
  } catch {
    return '';
  }
}

// ---- Whole-domain settings -------------------------------------------------

async function setCatchall({ username, domain, address }) {
  if (address) {
    await run('v-add-mail-domain-catchall', [username, domain, address]);
  } else {
    await run('v-delete-mail-domain-catchall', [username, domain]).catch((err) => {
      if (err.code !== 3 && err.code !== 5) throw err;
    });
  }
  return { ok: true };
}

/**
 * The DKIM record this domain needs published.
 *
 * Only actionable for a customer whose DNS is elsewhere — where we run the
 * zone, Hestia has already written it. Returned as name/value so the panel can
 * render a copyable row rather than a wall of BIND syntax.
 */
async function dkimRecord({ username, domain }) {
  if (!isLive()) return null;
  try {
    const text = await run('v-list-mail-domain-dkim-dns', [username, domain]);
    const raw = typeof text === 'string' ? text : String(text?.body || '');
    const match = raw.match(/(\S*_domainkey\S*)[\s\S]*?"([^"]+)"/);
    if (!match) return null;
    return {
      name: match[1].replace(new RegExp(`\\.?${domain}\\.?$`), '') || '_domainkey',
      value: match[2].replace(/"\s+"/g, ''),
    };
  } catch {
    return null;
  }
}

/**
 * Remove the `mail.<domain>` webmail alias.
 *
 * Hestia adds one to every mail domain (WEBMAIL_ALIAS defaults to `mail`),
 * which publishes `mail.customerdomain.com` as a webmail vhost on this node.
 * That name has no certificate of its own and is not where we want anybody
 * sent: webmail, IMAP and SMTP are all one hostname for every customer, so the
 * per-domain alias is a broken door with our name on it.
 */
async function removeWebmailAlias({ username, domain }) {
  await run('v-delete-mail-domain-webmail', [username, domain]).catch((err) => {
    if (err.code !== 3 && err.code !== 5) throw err;   // not there is the goal
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

async function listBackups(username) {
  if (!isLive()) return [];
  const data = await run('v-list-user-backups', [username], { json: true });
  const list = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
  return Object.entries(data).map(([name, b]) => ({
    name,
    type: b.TYPE,
    size_mb: Number(b.SIZE || 0),
    created_at: b.DATE ? `${b.DATE} ${b.TIME || ''}`.trim() : '',
    /*
     * What is actually inside it. Carried through rather than dropped because
     * a restore is per section — websites, DNS, mail, databases, cron, home
     * directory — and a customer choosing which sections to put back needs to
     * see what each one contains. "Restore" with no idea what is in the archive
     * is a button nobody should press.
     */
    web: list(b.WEB),
    dns: list(b.DNS),
    mail: list(b.MAIL),
    db: list(b.DB),
    cron: list(b.CRON),
    udir: list(b.UDIR),
    runtime_min: Number(b.RUNTIME || 0),
  }));
}

/** Queued on the node — it returns immediately, the backup runs behind it. */
async function createBackup(username) {
  await run('v-backup-user', [username]);
  return { ok: true, queued: true };
}

/**
 * Put a backup back.
 *
 * `v-restore-user USER BACKUP [WEB] [DNS] [MAIL] [DB] [CRON] [UDIR]`, where
 * each section is either left empty — meaning restore all of it — or the
 * literal string `no`, meaning skip it. There is no "restore just this one
 * domain" through this command; it is per section.
 *
 * THIS OVERWRITES. A restored website replaces whatever is in the web root
 * now, and a restored database replaces its current contents. The panel asks
 * before calling this, per section, and says so in those words — "restore"
 * sounds additive to most people and it is not.
 *
 * It also takes minutes and Hestia runs it in the background, so a success
 * here means "accepted", not "done".
 */
async function restoreBackup({
  username, backup, web = true, dns = true, mail = true, db = true, cron = true, udir = true,
}) {
  const on = (flag) => (flag ? '' : 'no');
  await run('v-restore-user', [
    username, backup, on(web), on(dns), on(mail), on(db), on(cron), on(udir),
  ]);
  return { ok: true, queued: true };
}

async function deleteBackup({ username, backup }) {
  await run('v-delete-user-backup', [username, backup]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Everything a paid order needs, in the order Hestia will accept it.
 *
 * Deliberately tolerant after the account itself exists: if SSL cannot be
 * issued because DNS has not propagated, the customer still gets a working
 * account and a clear "SSL will be issued once your domain points here"
 * message. Failing the whole provision over a certificate that will succeed in
 * an hour would be worse for them and for support.
 */
async function provision({ username, password, email, package: pkg, name, domain }) {
  const steps = [];

  await addUser({ username, password, email, package: pkg, name });
  steps.push({ step: 'account', ok: true });

  if (domain) {
    try {
      await addWebDomain({ username, domain });
      steps.push({ step: 'website', ok: true });
    } catch (err) {
      steps.push({ step: 'website', ok: false, error: err.message });
      return { ok: true, username, steps, warning: 'The account was created but the website could not be added.' };
    }

    try {
      await addMailDomain({ username, domain });
      steps.push({ step: 'mail', ok: true });
    } catch (err) {
      steps.push({ step: 'mail', ok: false, error: err.message });
    }

    try {
      await enableSSL({ username, domain });
      steps.push({ step: 'ssl', ok: true });
    } catch (err) {
      steps.push({
        step: 'ssl',
        ok: false,
        error: err.message,
        note: 'Usually means the domain does not point at this server yet. Retry from the panel once DNS has propagated.',
      });
    }
  }

  return { ok: true, username, steps };
}

function status() {
  return {
    mode: MODE,
    live: isLive(),
    configured: Boolean(HOST && (API_KEY || ADMIN_PASSWORD)),
    auth: API_KEY ? 'access key' : (ADMIN_PASSWORD ? 'admin password' : '(none)'),
    host: HOST || '(not set)',
    port: PORT,
    verify_tls: VERIFY_TLS,
    default_package: DEFAULT_PACKAGE,
    recent_mock_calls: isLive() ? [] : mockCalls.slice(-20).reverse(),
  };
}

module.exports = {
  HestiaError,
  isLive,
  run,
  serialUsername,
  exists,
  userExists,
  addUser,
  listUsers,
  changeUserPassword,
  changeUserPackage,
  listPackages,
  missingPackages,
  suspendUser,
  unsuspendUser,
  deleteUser,
  userStats,
  addWebDomain,
  addWebsite,
  deleteWebDomain,
  listWebDomains,
  enableSSL,
  setRedirect,
  clearRedirect,
  webDomainSsl,
  forceHttps,
  addDatabase,
  listDatabases,
  deleteDatabase,
  DNS_TYPES,
  publicIp,
  addDnsDomain,
  dnsDomainExists,
  listDnsRecords,
  addDnsRecord,
  changeDnsRecord,
  deleteDnsRecord,
  addMailDomain,
  addMailAccount,
  listMailDomains,
  countMailAccounts,
  listMailAccounts,
  mailAccount,
  changeMailPassword,
  changeMailQuota,
  setMailForwards,
  setMailAliases,
  setAutoreply,
  getAutoreply,
  setCatchall,
  dkimRecord,
  removeWebmailAlias,
  deleteMailAccount,
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  provision,
  status,
};
