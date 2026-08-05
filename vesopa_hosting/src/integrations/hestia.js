/**
 * HestiaCP — the node that actually runs the websites.
 *
 * The customer never sees Hestia. They see our panel; this file is the only
 * thing that knows Hestia exists. That is the whole product decision: like
 * Hostinger, one interface we control, not a cPanel login handed out.
 *
 * ## How Hestia's API works
 *
 * A single endpoint, `https://host:8083/api/`, POSTed as urlencoded form data:
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

const MODE = (process.env.HESTIA_MODE || 'mock').toLowerCase();
const HOST = process.env.HESTIA_HOST || '';
const PORT = Number(process.env.HESTIA_PORT || 8083);
const ADMIN_USER = process.env.HESTIA_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.HESTIA_ADMIN_PASSWORD || '';
const VERIFY_TLS = String(process.env.HESTIA_VERIFY_TLS || 'true') === 'true';
const DEFAULT_PACKAGE = process.env.HESTIA_DEFAULT_PACKAGE || 'default';

const TIMEOUT_MS = 20_000;

/** Hestia's exit codes, as messages a support agent can act on. */
const EXIT_CODES = {
  1: 'Command failed on the server.',
  2: 'The server rejected the arguments.',
  3: 'That value is not valid.',
  4: 'That object already exists.',
  5: 'That object does not exist.',
  6: 'The password was rejected.',
  7: 'That account is suspended.',
  8: 'The package limit was reached.',
  12: 'The server is out of disk space.',
  19: 'Permission denied on the server.',
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
async function run(cmd, args = [], { json = false } = {}) {
  if (!isLive()) {
    mockCalls.push({ cmd, args, at: new Date().toISOString() });
    if (mockCalls.length > 200) mockCalls.shift();
    console.log(`[hestia:mock] ${cmd} ${args.map((a) => (/password/i.test(cmd) ? '***' : a)).join(' ')}`);
    return json ? {} : { ok: true, mock: true };
  }

  if (!HOST || !ADMIN_PASSWORD) {
    throw new HestiaError('Hosting node is not configured.', { code: 'no_credentials', cmd });
  }

  const body = new URLSearchParams({
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
    returncode: json ? 'no' : 'yes',
    cmd,
  });
  args.forEach((arg, i) => body.set(`arg${i + 1}`, String(arg)));
  if (json) body.set(`arg${args.length + 1}`, 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`https://${HOST}:${PORT}/api/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
      // A fresh Hestia install serves the API on a self-signed certificate.
      // Node's fetch has no per-request TLS switch, so an unverified node needs
      // NODE_TLS_REJECT_UNAUTHORIZED handled at the process level — see the
      // note in server.js. Left strict here so nothing is silently insecure.
      ...(VERIFY_TLS ? {} : {}),
    });

    const text = (await res.text()).trim();

    if (json) {
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
      throw new HestiaError(`Node refused the request: ${text.slice(0, 120)}`, { code: 'refused', cmd });
    }
    const code = Number(text);
    if (code !== 0) {
      throw new HestiaError(EXIT_CODES[code] || `Server returned error ${code}.`, { code, cmd });
    }
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new HestiaError('The hosting node did not respond in time.', { code: 'timeout', cmd });
    }
    if (err instanceof HestiaError) throw err;
    throw new HestiaError(`Could not reach the hosting node: ${err.message}`, { code: 'network', cmd });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Hestia usernames are lowercase, alphanumeric, and short. Derived from the
 * email's local part with a numeric suffix for collisions, because a username
 * a human can read makes every support conversation faster than a UUID would.
 */
function suggestUsername(email, suffix = '') {
  const base = String(email || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12) || 'user';
  // Must not start with a digit: Hestia rejects it.
  const safe = /^[0-9]/.test(base) ? `u${base}` : base;
  return `${safe}${suffix}`.slice(0, 16);
}

async function userExists(username) {
  if (!isLive()) return false;
  try {
    await run('v-list-user', [username], { json: true });
    return true;
  } catch (err) {
    if (err.code === 5) return false;
    throw err;
  }
}

/** v-add-user USER PASSWORD EMAIL [PACKAGE] [NAME] */
async function addUser({ username, password, email, package: pkg = DEFAULT_PACKAGE, name = '' }) {
  await run('v-add-user', [username, password, email, pkg, name]);
  return { ok: true, username };
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

async function addWebDomain({ username, domain }) {
  await run('v-add-domain', [username, domain]);
  return { ok: true, domain };
}

async function deleteWebDomain({ username, domain }) {
  await run('v-delete-domain', [username, domain]);
  return { ok: true };
}

async function listWebDomains(username) {
  if (!isLive()) return [];
  const data = await run('v-list-web-domains', [username], { json: true });
  return Object.entries(data).map(([domain, d]) => ({
    domain,
    ip: d.IP,
    ssl: String(d.SSL || 'no') === 'yes',
    letsencrypt: String(d.LETSENCRYPT || 'no') === 'yes',
    suspended: String(d.SUSPENDED || 'no') === 'yes',
    disk_mb: Number(d.U_DISK || 0),
  }));
}

/**
 * Issue and install a Let's Encrypt certificate.
 *
 * Fails until the domain's A record actually points at the node — that is the
 * ACME challenge doing its job, not a bug, and the panel says so in those words
 * rather than showing the raw exit code.
 */
async function enableSSL({ username, domain, withWww = true }) {
  await run('v-add-letsencrypt-domain', [username, domain, withWww ? `www.${domain}` : '', 'yes']);
  return { ok: true, domain };
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

async function addMailDomain({ username, domain }) {
  await run('v-add-mail-domain', [username, domain]);
  return { ok: true };
}

async function addMailAccount({ username, domain, account, password, quota = 1024 }) {
  await run('v-add-mail-account', [username, domain, account, password, quota]);
  return { ok: true, address: `${account}@${domain}` };
}

async function listMailAccounts({ username, domain }) {
  if (!isLive()) return [];
  const data = await run('v-list-mail-accounts', [username, domain], { json: true });
  return Object.entries(data).map(([account, d]) => ({
    account,
    address: `${account}@${domain}`,
    quota_mb: d.QUOTA === 'unlimited' ? 0 : Number(d.QUOTA || 0),
    used_mb: Number(d.U_DISK || 0),
  }));
}

async function deleteMailAccount({ username, domain, account }) {
  await run('v-delete-mail-account', [username, domain, account]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

async function listBackups(username) {
  if (!isLive()) return [];
  const data = await run('v-list-user-backups', [username], { json: true });
  return Object.entries(data).map(([name, b]) => ({
    name,
    type: b.TYPE,
    size_mb: Number(b.SIZE || 0),
    created_at: b.DATE ? `${b.DATE} ${b.TIME || ''}`.trim() : '',
  }));
}

/** Queued on the node — it returns immediately, the backup runs behind it. */
async function createBackup(username) {
  await run('v-backup-user', [username]);
  return { ok: true, queued: true };
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
    configured: Boolean(HOST && ADMIN_PASSWORD),
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
  suggestUsername,
  userExists,
  addUser,
  changeUserPassword,
  changeUserPackage,
  suspendUser,
  unsuspendUser,
  deleteUser,
  userStats,
  addWebDomain,
  deleteWebDomain,
  listWebDomains,
  enableSSL,
  forceHttps,
  addDatabase,
  listDatabases,
  deleteDatabase,
  addMailDomain,
  addMailAccount,
  listMailAccounts,
  deleteMailAccount,
  listBackups,
  createBackup,
  provision,
  status,
};
