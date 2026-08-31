/**
 * Applications and runtimes, unprivileged half.
 *
 * The third of the three brokers, and the same split as the other two:
 *
 *   here     WHO is asking — a valid session, an active customer, an account
 *            with hosting. The browser never names a unix account.
 *   broker   WHETHER THAT IS ALLOWED, then setuid() to that account and let the
 *            kernel enforce the rest. See apps/broker.py.
 *
 * ---------------------------------------------------------------------------
 * WHY A THIRD BROKER RATHER THAN A NEW OP ON THE FILE ONE
 * ---------------------------------------------------------------------------
 * files/broker.py has one sentence describing what it will do: read and write
 * things under this account's home. That sentence is the security review. The
 * moment it also runs `npm install` and `pm2 restart`, the sentence becomes
 * "…and executes programs", and everything anybody has ever concluded about
 * that file has to be re-derived.
 *
 * So this is its own program with its own short sentence: it runs a fixed set
 * of named operations, as one hosting account, and the list of them fits on a
 * screen. Nothing here ever sends a command string across the socket — it sends
 * an operation name and validated arguments, and the broker holds the recipes.
 *
 * ---------------------------------------------------------------------------
 * AN INSTALL IS A JOB, NOT A REQUEST
 * ---------------------------------------------------------------------------
 * `composer create-project laravel/laravel` takes three minutes on a good day.
 * No HTTP request should be held open for that, no proxy in front of us would
 * allow it, and a customer who closes the tab must not end up with half a
 * framework in their web root.
 *
 * So `install()` returns as soon as the job is ACCEPTED. The broker forks, runs
 * the recipe, and writes progress to a file in the account's own home. The panel
 * polls `job()`. Closing the tab changes nothing; reopening it shows where the
 * install got to, including the log if it failed.
 *
 * ---------------------------------------------------------------------------
 * MOCK MODE
 * ---------------------------------------------------------------------------
 * Same bargain as integrations/hestia.js: with no broker socket the whole
 * feature is still clickable, on invented but plausible data, so the pages can
 * be built and reviewed on a laptop. It is the default, so a mistake in
 * development cannot install anything on anybody's account.
 */

const net = require('node:net');
const fs = require('node:fs');

const db = require('./db');
const catalogue = require('./app-catalogue');

const SOCKET_PATH = process.env.APPS_SOCKET || '/run/vesopa-apps/broker.sock';

/**
 * live | mock. Mock unless the socket is actually there, so a production box
 * whose broker has died says so instead of quietly inventing a process list —
 * a fake "everything is running" on a real account is the worst possible
 * failure for a page whose entire job is to say whether an app is working.
 */
const MODE = (process.env.APPS_MODE || (fs.existsSync(SOCKET_PATH) ? 'live' : 'mock')).toLowerCase();
const isLive = () => MODE === 'live';

const NO_BROKER = 'The application service is not running on this server. Support has been notified.';

class AppError extends Error {
  constructor(message, code = 'error', status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

/**
 * The hosting account behind a signed-in customer, or an explanation.
 *
 * Deliberately identical in shape to files.js `accountFor`. Two copies rather
 * than a shared helper because the two answers are allowed to diverge — a
 * shell-less package can still edit files but should not be able to start
 * processes — and a shared function would make that divergence look like a bug.
 */
async function accountFor(customer) {
  if (!customer) throw new AppError('Not signed in.', 'auth', 401);
  if (customer.status !== 'active') throw new AppError('This account is not active.', 'auth', 403);
  if (!customer.hestia_user) {
    throw new AppError('There is no hosting on this account yet.', 'nohosting', 403);
  }
  const service = await db.one(
    "SELECT id FROM services WHERE customer_id = ? AND status = 'active' LIMIT 1",
    [customer.id],
  );
  if (!service) throw new AppError('There is no active hosting on this account.', 'nohosting', 403);
  return customer.hestia_user;
}

// ---------------------------------------------------------------------------
// Wire — [4-byte BE length][JSON], one operation per connection
// ---------------------------------------------------------------------------

function frame(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return Buffer.concat([head, json]);
}

function call(user, payload, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let done = false;
    let want = -1;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(value);
    };

    socket.setTimeout(timeoutMs, () => {
      finish(new AppError('That took too long and was stopped.', 'timeout', 504));
    });

    socket.on('error', (err) => {
      if (['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(err.code)) {
        console.error('[apps] broker unreachable:', err.message);
        finish(new AppError(NO_BROKER, 'nobroker', 503));
        return;
      }
      finish(new AppError('The application service could not be reached.', 'nobroker', 503));
    });

    socket.on('readable', function onReadable() {
      for (;;) {
        if (want < 0) {
          const head = socket.read(4);
          if (!head) return;
          want = head.readUInt32BE(0);
          if (want > 4 << 20) {
            finish(new AppError('The application service sent something unreadable.', 'protocol', 502));
            return;
          }
        }
        const json = socket.read(want);
        if (!json) return;
        let header;
        try {
          header = JSON.parse(json.toString('utf8'));
        } catch {
          finish(new AppError('The application service sent something unreadable.', 'protocol', 502));
          return;
        }
        if (!header.ok) {
          const status = {
            forbidden: 403, refused: 400, denied: 403, missing: 404, exists: 409, busy: 409,
          };
          finish(new AppError(header.error || 'That did not work.', header.code || 'error', status[header.code] || 400));
          return;
        }
        finish(null, header);
        return;
      }
    });

    socket.on('connect', () => socket.write(frame({ ...payload, user })));
    socket.on('close', () => {
      finish(new AppError('The application service closed the connection.', 'nobroker', 503));
    });
  });
}

/**
 * A request whose answer is a FILE, not JSON.
 *
 * Resolves once the header has arrived, with the socket still open and the
 * body unread, so the caller can pipe it straight to the response. `readable`
 * rather than `data` events throughout, because anything that arrived in the
 * same packet as the header has to be `unshift()`ed back before piping — and
 * that is only possible on a stream that has not been put into flowing mode.
 *
 * A backup is measured in gigabytes. Nothing here buffers it.
 */
function openStream(user, payload, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let done = false;
    let want = -1;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      socket.removeListener('readable', onReadable);
      if (err) {
        try { socket.destroy(); } catch { /* already gone */ }
        reject(err);
      } else {
        resolve(value);
      }
    };

    socket.setTimeout(timeoutMs, () => {
      finish(new AppError('That took too long and was stopped.', 'timeout', 504));
    });
    socket.on('error', (err) => {
      if (['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(err.code)) {
        finish(new AppError(NO_BROKER, 'nobroker', 503));
        return;
      }
      finish(new AppError('The application service could not be reached.', 'nobroker', 503));
    });
    socket.on('close', () => {
      finish(new AppError('The application service closed the connection.', 'nobroker', 503));
    });

    function onReadable() {
      for (;;) {
        if (want < 0) {
          const head = socket.read(4);
          if (!head) return;
          want = head.readUInt32BE(0);
          if (want > 4 << 20) {
            finish(new AppError('The application service sent something unreadable.', 'protocol', 502));
            return;
          }
        }
        const json = socket.read(want);
        if (!json) return;
        let header;
        try {
          header = JSON.parse(json.toString('utf8'));
        } catch {
          finish(new AppError('The application service sent something unreadable.', 'protocol', 502));
          return;
        }
        if (!header.ok) {
          const status = { forbidden: 403, refused: 400, denied: 403, missing: 404 };
          finish(new AppError(header.error || 'That did not work.', header.code || 'error', status[header.code] || 400));
          return;
        }
        // A long download must not be cut off by the header's own timeout.
        socket.setTimeout(0);
        finish(null, { header, socket });
        return;
      }
    }

    socket.on('readable', onReadable);
    socket.on('connect', () => socket.write(frame({ ...payload, user })));
  });
}

// ---------------------------------------------------------------------------
// What "working" means
// ---------------------------------------------------------------------------

/**
 * Turn what pm2 and a port probe say into one word a customer can act on.
 *
 * THIS IS THE POINT OF THE WHOLE PAGE, so it is worth being exact about why
 * pm2's own status is not enough.
 *
 * pm2 reports `online` for a process that exists. A Node app that throws on
 * every request, that never finished binding its port, or that is crash-looping
 * fast enough to always be "up" when you look, is `online` — and a panel that
 * prints that word next to a green dot has told the customer their broken site
 * is fine. That is the single most expensive lie a hosting panel can tell,
 * because the customer believes it and goes looking somewhere else.
 *
 * So three facts are combined, and the ones that disagree win:
 *
 *   pm2 status      is there a process at all
 *   restart count   is it dying and being restarted (compared against uptime)
 *   port probe      does an HTTP request to it actually come back
 *
 * `restarts` is read against `uptime`: twenty restarts on an app that has been
 * up for a month is a month of deploys, and twenty restarts on one that has
 * been up for ninety seconds is a crash loop. Same number, opposite meaning.
 */
const RESTART_LOOP_WINDOW_MS = 5 * 60 * 1000;

function health(app) {
  const status = String(app.status || '').toLowerCase();
  const uptime = Number(app.uptime_ms || 0);
  const restarts = Number(app.restarts || 0);
  const unstable = Number(app.unstable_restarts || 0);
  const probe = app.probe || null;

  if (status === 'stopped') {
    return { state: 'stopped', tone: 'grey', label: 'Stopped', why: 'You stopped this app. Start it to bring the site back.' };
  }
  if (status === 'errored') {
    return { state: 'failed', tone: 'red', label: 'Failed', why: 'The app exited and pm2 gave up restarting it. The log will say why.' };
  }
  if (!status) {
    return { state: 'unknown', tone: 'grey', label: 'Not running', why: 'There is no process for this app.' };
  }

  // Crash loop beats everything: the process exists right now, but it is a
  // different process every few seconds and no visitor is being served.
  if (unstable > 0 || (restarts > 3 && uptime < RESTART_LOOP_WINDOW_MS)) {
    return {
      state: 'looping',
      tone: 'red',
      label: 'Crash looping',
      why: `Started ${restarts} times and has only stayed up ${Math.round(uptime / 1000)} seconds. It is failing on startup — check the log.`,
    };
  }

  if (probe && probe.ok) {
    return {
      state: 'working',
      tone: 'green',
      label: 'Working',
      why: `Answered an HTTP request in ${probe.ms}ms.`,
    };
  }
  if (probe && !probe.ok) {
    return {
      state: 'silent',
      tone: 'amber',
      label: 'Running, not answering',
      why: probe.error === 'refused'
        ? `The process is up but nothing is listening on port ${app.port}. Usually the app listens on a different port to the one it was given, or it has not finished starting.`
        : `The process is up but the request timed out after ${probe.ms}ms. It is running and stuck.`,
    };
  }
  return { state: 'running', tone: 'blue', label: 'Running', why: 'The process is up. We could not check whether it answers.' };
}

// ---------------------------------------------------------------------------
// Mock data — plausible, and obviously invented once you read it
// ---------------------------------------------------------------------------

const MOCK = {
  runtimes() {
    /*
     * Shaped exactly like the live answer, including the redundancy: the
     * extension list appears BOTH on each PHP entry and in the `extensions`
     * map, because that is what the broker sends and a mock that is a
     * different shape from the real thing is a mock that hides bugs instead
     * of finding them. The first version of this omitted the per-entry copy
     * and every version card on the page read "0 extensions".
     */
    const exts = {
      '8.1': ['curl', 'gd', 'mbstring', 'mysqli', 'opcache', 'pdo_mysql', 'xml', 'zip'],
      '8.2': ['bcmath', 'curl', 'gd', 'intl', 'mbstring', 'mysqli', 'opcache', 'pdo_mysql', 'soap', 'xml', 'zip'],
      '8.3': ['bcmath', 'curl', 'gd', 'imagick', 'intl', 'mbstring', 'mysqli', 'opcache', 'pdo_mysql', 'pgsql', 'redis', 'soap', 'sodium', 'xml', 'zip'],
      '8.4': ['bcmath', 'curl', 'gd', 'intl', 'mbstring', 'mysqli', 'opcache', 'pdo_mysql', 'sodium', 'xml', 'zip'],
    };
    return {
      php: [
        { version: '8.1', template: 'PHP-8_1', eol: true, extensions: exts['8.1'] },
        { version: '8.2', template: 'PHP-8_2', extensions: exts['8.2'] },
        { version: '8.3', template: 'PHP-8_3', extensions: exts['8.3'] },
        { version: '8.4', template: 'PHP-8_4', recommended: true, extensions: exts['8.4'] },
      ],
      node: [
        { major: 20, version: '20.19.2', lts: true },
        { major: 22, version: '22.14.0', lts: true, recommended: true },
        { major: 24, version: '24.4.1' },
      ],
      extensions: exts,
      sites: [],
    };
  },
  nodeapps() {
    return [
      {
        name: 'janesbakery.co.uk',
        domain: 'janesbakery.co.uk',
        status: 'online',
        pid: 21044,
        port: 20003,
        node: '22.14.0',
        script: 'server.js',
        cwd: '/home/u100001/web/janesbakery.co.uk/private/nodeapp',
        uptime_ms: 4 * 24 * 3600 * 1000,
        restarts: 6,
        unstable_restarts: 0,
        cpu: 0.4,
        memory_mb: 96,
        probe: { ok: true, status: 200, ms: 12 },
      },
      {
        name: 'shop.janesbakery.co.uk',
        domain: 'shop.janesbakery.co.uk',
        status: 'online',
        pid: 21877,
        port: 20004,
        node: '20.19.2',
        script: 'index.js',
        cwd: '/home/u100001/web/shop.janesbakery.co.uk/private/nodeapp',
        uptime_ms: 41 * 1000,
        restarts: 19,
        unstable_restarts: 4,
        cpu: 61.2,
        memory_mb: 41,
        probe: { ok: false, error: 'refused', ms: 1 },
      },
    ];
  },
  logs() {
    return {
      out: [
        '> vesopa-site@1.0.0 start',
        '> node server.js',
        '',
        'listening on 127.0.0.1:20003',
      ],
      err: [
        "Error: Cannot find module 'dotenv'",
        '    at Module._resolveFilename (node:internal/modules/cjs/loader:1456:15)',
        '    at Module._load (node:internal/modules/cjs/loader:1242:25)',
      ],
    };
  },
  packages(target) {
    if (target === 'wordpress') {
      return [
        { name: 'akismet', title: 'Akismet Anti-spam', version: '5.3.3' },
        { name: 'wordpress-seo', title: 'Yoast SEO', version: '24.1' },
      ];
    }
    return [
      { name: 'express', version: '4.21.2', wanted: '4.21.2' },
      { name: 'ejs', version: '3.1.10', wanted: '3.1.10' },
      { name: 'dotenv', version: null, wanted: '16.4.7', missing: true },
    ];
  },
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Which PHP versions and Node lines this node actually has installed. */
async function runtimes(user) {
  if (!isLive()) return MOCK.runtimes();
  const res = await call(user, { op: 'runtimes' });
  return {
    php: res.php || [], node: res.node || [], extensions: res.extensions || {}, sites: res.sites || [],
  };
}

/**
 * Every Node application this account has, with the honest verdict attached.
 *
 * The probe is done in the broker rather than here, because the ports are bound
 * to 127.0.0.1 on the node and this process may not be on the same machine as
 * the customer's app in every deployment.
 */
async function nodeApps(user, { probe = true } = {}) {
  const raw = isLive() ? (await call(user, { op: 'nodeapps', probe }, { timeoutMs: 20_000 })).apps || [] : MOCK.nodeapps();
  return raw.map((app) => ({ ...app, health: health(app) }));
}

async function nodeApp(user, name) {
  const apps = await nodeApps(user);
  return apps.find((a) => a.name === name) || null;
}

/** start | stop | restart | reload | delete. Nothing else is accepted. */
const NODE_ACTIONS = ['start', 'stop', 'restart', 'reload', 'delete'];

async function nodeAction(user, name, action) {
  if (!NODE_ACTIONS.includes(action)) throw new AppError('That is not something you can do to an app.', 'refused');
  if (!isLive()) return { ok: true, mock: true };
  return call(user, { op: 'nodeaction', name, action }, { timeoutMs: 60_000 });
}

/**
 * The last N lines of an app's output and error logs.
 *
 * pm2 writes `out-0.log` and `error-0.log` regardless of what the ecosystem
 * file names — reading the wrong file shows an empty log for a crash-looping
 * app, which has cost this project an afternoon at least once. The broker knows
 * the real names; nothing here guesses at a path.
 */
async function nodeLogs(user, name, { lines = 200 } = {}) {
  if (!isLive()) return MOCK.logs();
  const res = await call(user, { op: 'nodelogs', name, lines: Math.min(1000, Math.max(20, lines)) });
  return { out: res.out || [], err: res.err || [] };
}

/** The app's `.env`, as text. Never logged, never cached. */
async function readEnv(user, name) {
  if (!isLive()) return { text: 'PORT=20003\nNODE_ENV=production\n' };
  const res = await call(user, { op: 'readenv', name });
  return { text: res.text || '' };
}

async function writeEnv(user, name, text) {
  if (String(text).length > 64 * 1024) throw new AppError('That environment file is too large.', 'refused');
  if (!isLive()) return { ok: true, mock: true };
  return call(user, { op: 'writeenv', name, text: String(text) });
}

/**
 * PHP settings for one website, as a small set of named values.
 *
 * These go into a `.user.ini` in the document root, which is the only per-site
 * PHP configuration a customer can be given safely on a shared box: PHP reads
 * it per directory, it cannot load an extension, it cannot disable a security
 * setting, and the worst a bad value does is break that one site.
 *
 * The alternative — a per-account FPM pool with php_admin_value — is a root
 * edit and an FPM reload for every change, which is a service restart triggered
 * by a customer clicking Save. Not worth it for six numbers.
 */
const PHP_SETTINGS = {
  memory_limit: { label: 'Memory limit', unit: 'M', min: 64, max: 2048, def: 256, note: 'How much memory one request may use. Raise it if you see "allowed memory size exhausted".' },
  upload_max_filesize: { label: 'Maximum upload', unit: 'M', min: 2, max: 1024, def: 64, note: 'The largest single file somebody can upload.' },
  post_max_size: { label: 'Maximum form post', unit: 'M', min: 2, max: 1024, def: 64, note: 'Must be at least as large as the upload limit, or uploads fail silently.' },
  max_execution_time: { label: 'Time limit', unit: 's', min: 10, max: 600, def: 120, note: 'How long one request may run before PHP stops it.' },
  max_input_vars: { label: 'Form fields', unit: '', min: 100, max: 20000, def: 3000, note: 'How many fields one form may submit. Large WordPress menus need more than the default.' },
};

async function phpConfig(user, domain) {
  if (!isLive()) return { values: { memory_limit: 256, upload_max_filesize: 64 }, path: `~/web/${domain}/public_html/.user.ini` };
  const res = await call(user, { op: 'phpconfig', domain });
  return { values: res.values || {}, path: res.path || '' };
}

async function setPhpConfig(user, domain, values) {
  const clean = {};
  Object.entries(values || {}).forEach(([key, raw]) => {
    const spec = PHP_SETTINGS[key];
    if (!spec) return;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    clean[key] = Math.min(spec.max, Math.max(spec.min, n));
  });
  /*
   * post_max_size below upload_max_filesize is the classic own-goal: the upload
   * form accepts the file, PHP discards the whole request body for being too
   * big, and $_FILES arrives EMPTY with no error anybody sees. Correcting it
   * here is friendlier than validating it and refusing — nobody sets a smaller
   * post limit on purpose.
   */
  if (clean.upload_max_filesize && (clean.post_max_size || 0) < clean.upload_max_filesize) {
    clean.post_max_size = clean.upload_max_filesize;
  }
  if (!isLive()) return { ok: true, mock: true, values: clean };
  return call(user, { op: 'setphpconfig', domain, values: clean });
}

/**
 * Start an install. Returns a job id immediately; poll job() for the rest.
 *
 * Everything the broker needs is named and validated here. `slug` is looked up
 * in the catalogue, so an unknown one never reaches the socket.
 */
async function install(user, { slug, domain, database, dbUser, dbPassword, phpVersion, nodeMajor }) {
  const app = catalogue.find(slug);
  if (!app) throw new AppError('There is no such application.', 'missing', 404);
  if (!domain) throw new AppError('Choose which site to install it on.', 'refused');

  const payload = {
    op: 'install',
    slug: app.slug,
    domain,
    docroot: app.docroot || null,
    database: database || null,
    db_user: dbUser || null,
    db_password: dbPassword || null,
    php: phpVersion || null,
    node: nodeMajor || null,
  };
  if (!isLive()) return { ok: true, job: `mock-${Date.now().toString(36)}`, mock: true };
  return call(user, payload, { timeoutMs: 20_000 });
}

/**
 * Where an install got to. Safe to poll; it reads one small file.
 *
 * The two branches are normalised through the SAME shaping code on the way
 * out. An earlier version built the mock answer by hand and left out
 * `finished` — the one field both the poller and the route branch on — so a
 * mock install stayed "running" for ever and its history row never closed.
 * A mock that is a different shape from the real thing hides bugs rather than
 * finding them, so there is now one place that decides the shape.
 */
function shapeJob(id, res) {
  const state = res.state || 'running';
  return {
    ok: true,
    id,
    state,
    percent: Number(res.percent || 0),
    step: res.step || '',
    log: res.log || [],
    error: res.error || null,
    next: res.next || null,
    url: res.url || null,
    domain: res.domain || null,
    slug: res.slug || null,
    finished: state === 'done' || state === 'failed',
  };
}

async function job(user, id) {
  if (!isLive()) {
    return shapeJob(id, {
      state: 'done',
      percent: 100,
      step: 'Finished',
      log: ['mock install — nothing was actually written'],
      next: 'This is demonstration mode, so nothing was installed.',
    });
  }
  return shapeJob(id, await call(user, { op: 'job', id }));
}

/** Every install this account has started, newest first. */
async function jobs(user) {
  if (!isLive()) return [];
  const res = await call(user, { op: 'jobs' });
  return res.jobs || [];
}

/**
 * What is installed inside one application — npm packages for a Node app,
 * plugins for a WordPress site. One operation, because from the panel's point
 * of view it is the same question asked of two different runtimes.
 */
async function plugins(user, { target, name }) {
  if (!isLive()) return MOCK.packages(target);
  const res = await call(user, { op: 'plugins', target, name });
  return res.items || [];
}

async function pluginAction(user, { target, name, pkg, action }) {
  if (!['add', 'remove'].includes(action)) throw new AppError('That is not something you can do.', 'refused');
  /*
   * A package name is the one string here that comes from a text box and ends
   * up as an argument to a program, so it is checked twice — once here, in the
   * alphabet npm and WordPress both actually allow, and again in the broker.
   * Neither trusts the other.
   */
  if (!/^[@a-z0-9][a-z0-9._@/-]{0,110}$/i.test(String(pkg || ''))) {
    throw new AppError('That is not a valid package name.', 'refused');
  }
  if (!isLive()) return { ok: true, mock: true };
  return call(user, {
    op: 'plugin', target, name, pkg: String(pkg), action,
  }, { timeoutMs: 20_000 });
}

/**
 * One of this account's backups, as a readable stream.
 *
 * The caller gets `{ name, size, stream }` and is expected to pipe it. In mock
 * mode there is nothing to stream, so this refuses rather than inventing a
 * file — a download that produces a plausible but empty archive is worse than
 * one that says it cannot.
 */
async function downloadBackup(user, name) {
  if (!isLive()) {
    throw new AppError('Backup downloads need a live hosting node.', 'nobroker', 503);
  }
  const { header, socket } = await openStream(user, { op: 'backupfile', name });
  return { name: header.name, size: Number(header.size || 0), stream: socket };
}

module.exports = {
  AppError,
  downloadBackup,
  MODE,
  isLive,
  accountFor,
  health,
  runtimes,
  nodeApps,
  nodeApp,
  nodeAction,
  nodeLogs,
  readEnv,
  writeEnv,
  phpConfig,
  setPhpConfig,
  PHP_SETTINGS,
  install,
  job,
  jobs,
  plugins,
  pluginAction,
  NODE_ACTIONS,
};
