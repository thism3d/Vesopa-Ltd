/**
 * The panel's live channel.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * Three things in this panel change WITHOUT the customer doing anything, and
 * all three used to be invisible until somebody reloaded:
 *
 *   provisioning   A new site goes pending → active over about a minute, on the
 *                  node's schedule. The old page said "Setting up" and then
 *                  said it forever, so people reloaded, and reloaded, and
 *                  opened a ticket.
 *   nameservers    The DNS sweep verifies a domain in the background. A
 *                  customer who has just changed their nameservers sits on the
 *                  domain page pressing "Check now" because nothing else tells
 *                  them when it lands.
 *   usage          Disk and bandwidth, read off the node.
 *
 * So the page holds one socket and the server pushes the new state of whatever
 * that page is looking at. No polling loop in the browser, no full reload, and
 * no spinner that lies.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A WATCH LIST AND NOT A FIREHOSE
 * ---------------------------------------------------------------------------
 * A socket that receives everything about an account is a socket that leaks
 * everything about an account to whatever page happens to hold it. The browser
 * names the OBJECTS it is looking at ("domain:4", "service:12"), every one of
 * those is re-checked against the session's own customer_id before a single
 * byte about it is sent, and an id the customer does not own is dropped
 * silently rather than answered with an error that would confirm it exists.
 *
 * The browser's list is a REQUEST, never a grant. That is the same split as the
 * terminal: the client says what it wants, the server decides what it may have.
 *
 * ---------------------------------------------------------------------------
 * WHY IT POLLS THE DATABASE RATHER THAN LISTENING FOR EVENTS
 * ---------------------------------------------------------------------------
 * The things that change are changed by the background jobs in src/jobs.js and,
 * for provisioning, by the node itself — some of it in another process. An
 * in-process event bus would miss every one of those, and would go on missing
 * them silently the day the jobs move to their own worker. A six-second read of
 * a handful of indexed rows, only for objects somebody is actually looking at,
 * is cheap and cannot be wrong.
 *
 * `publish()` exists on top of that for the case where a route handler already
 * knows the answer — a DNS check the customer just triggered — so the push is
 * immediate rather than up to six seconds late.
 */

const { WebSocketServer } = require('ws');

const db = require('./db');
const auth = require('./auth');
const domainState = require('./domain-state');

const PATHNAME = '/panel/live';

/** How often watched objects are re-read. Only runs while somebody is watching. */
const TICK_MS = Number(process.env.PANEL_LIVE_TICK_MS || 6000);

/** One socket per tab is plenty; a page that opens more is a page with a bug. */
const MAX_PER_CUSTOMER = Number(process.env.PANEL_LIVE_MAX || 6);

/** How many objects one socket may watch. A page watches its own contents. */
const MAX_WATCH = 40;

const live = new Map();
function countFor(id) { return live.get(id) || 0; }

/** Cookies off a raw request — cookie-parser has not run on an upgrade. */
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const key = part.slice(0, eq).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch { out[key] = part.slice(eq + 1).trim(); }
  });
  return out;
}

async function authorise(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = auth.readCustomerSession({ cookies });
  if (!session || !session.sub) return { error: 'signed-out' };

  const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [session.sub]);
  if (!customer) return { error: 'signed-out' };
  // A cookie minted before a password change must not keep a socket alive.
  if (session.pwv !== auth.passwordVersion(customer.password_hash)) return { error: 'signed-out' };
  if (customer.status !== 'active') return { error: 'inactive' };
  if (countFor(customer.id) >= MAX_PER_CUSTOMER) return { error: 'too-many' };
  return { customer };
}

// ---------------------------------------------------------------------------
// Reading the state of one watched object
// ---------------------------------------------------------------------------

/**
 * The public shape of a domain, for the browser.
 *
 * Deliberately NOT the row. A row carries the registrar reference, the observed
 * nameservers and the customer id; none of that belongs on a wire that a page
 * script can read, and shipping the whole row is how internal columns end up
 * being depended on by a template nobody remembers writing.
 */
function domainPayload(d) {
  const state = domainState.describe(d);
  return {
    id: d.id,
    domain: d.domain,
    key: state.key,
    label: state.label,
    tone: state.tone,
    line: state.line,
    needsYou: state.needsYou,
    ssl: d.ssl_status === 'active',
    verified: Boolean(d.ns_verified_at),
  };
}

function servicePayload(s) {
  return {
    id: s.id,
    domain: s.primary_domain || '',
    status: s.status,
    label: s.status === 'active' ? 'Live'
      : s.status === 'pending' ? 'Setting up'
        : s.status === 'suspended' ? 'Suspended' : s.status,
    tone: s.status === 'active' ? 'green'
      : s.status === 'pending' ? 'blue'
        : s.status === 'suspended' ? 'red' : 'grey',
    ready: s.status === 'active',
  };
}

/**
 * Read every watched key for one customer in as few queries as possible.
 *
 * The ids are grouped by kind and fetched with one `IN (…)` per kind rather
 * than one query per key, because a domains page watching twelve rows should
 * cost two queries every six seconds, not twelve.
 *
 * EVERY query carries `customer_id = ?`. That is the ownership check, and it is
 * in the WHERE clause rather than in a check afterwards so there is no version
 * of this code that reads a row it is not allowed to read.
 */
async function readState(customerId, keys) {
  const domainIds = [];
  const serviceIds = [];
  keys.forEach((k) => {
    const [kind, raw] = k.split(':');
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    if (kind === 'domain') domainIds.push(id);
    else if (kind === 'service') serviceIds.push(id);
  });

  const out = {};
  const jobs = [];

  if (domainIds.length) {
    jobs.push(db.query(
      `SELECT id, domain, status, source, ssl_status, expires_at, auto_renew,
              ns_verified_at, ns_grace_until, pointed_at, mail_enabled, dns_enabled, verify_method
         FROM domains WHERE customer_id = ? AND id IN (${domainIds.map(() => '?').join(',')})`,
      [customerId, ...domainIds],
    ).then((rows) => rows.forEach((d) => { out[`domain:${d.id}`] = domainPayload(d); })));
  }

  if (serviceIds.length) {
    jobs.push(db.query(
      `SELECT id, primary_domain, status FROM services
        WHERE customer_id = ? AND id IN (${serviceIds.map(() => '?').join(',')})`,
      [customerId, ...serviceIds],
    ).then((rows) => rows.forEach((s) => { out[`service:${s.id}`] = servicePayload(s); })));
  }

  await Promise.all(jobs);
  return out;
}

// ---------------------------------------------------------------------------
// The immediate-push side
// ---------------------------------------------------------------------------

/** Every open socket, so a publish can find the ones watching a given key. */
const sockets = new Set();

/**
 * Push one object's new state to everybody watching it, now.
 *
 * Called by a route that has just changed something — a DNS verification, an
 * SSL retry — so the answer arrives with the redirect rather than up to a tick
 * later. It is an optimisation only: the poll below would find it anyway, and
 * nothing may depend on this having been called.
 */
function publish(customerId, key) {
  sockets.forEach((entry) => {
    if (entry.customerId !== customerId || !entry.keys.has(key)) return;
    // Re-read rather than trusting a payload from the caller: the caller's copy
    // of the row may predate a job that has since touched it.
    readState(customerId, [key])
      .then((state) => entry.send(state))
      .catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  /** @returns {boolean} true if this upgrade was ours. See src/terminal.js. */
  const onUpgrade = (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return false; }
    if (pathname !== PATHNAME) return false;

    // Same-origin only, for the same reason as the terminal: a websocket is not
    // covered by the same-origin policy, and the browser attaches the
    // customer's cookies to one opened from any page anywhere.
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host || new URL(origin).host !== host) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return true;
  };

  wss.on('connection', async (ws, req) => {
    let verdict;
    try {
      verdict = await authorise(req);
    } catch (err) {
      console.error('[live] authorise failed:', err.message);
      verdict = { error: 'error' };
    }
    if (verdict.error) {
      try { ws.send(JSON.stringify({ type: 'bye', reason: verdict.error })); } catch { /* gone */ }
      ws.close(4001, 'unauthorised');
      return;
    }

    const customerId = verdict.customer.id;
    live.set(customerId, countFor(customerId) + 1);

    const entry = {
      customerId,
      keys: new Set(),
      last: new Map(),
      send(state) {
        // Only what has actually changed. A page that re-renders a row every
        // six seconds because the server keeps repeating itself loses the
        // customer's text selection and their scroll position.
        const changed = {};
        let any = false;
        Object.entries(state).forEach(([key, value]) => {
          const json = JSON.stringify(value);
          if (entry.last.get(key) === json) return;
          entry.last.set(key, json);
          changed[key] = value;
          any = true;
        });
        if (!any || ws.readyState !== ws.OPEN) return;
        try { ws.send(JSON.stringify({ type: 'state', state: changed })); } catch { /* gone */ }
      },
    };
    sockets.add(entry);

    let timer = null;
    const tick = async () => {
      if (!entry.keys.size) return;
      try {
        entry.send(await readState(customerId, [...entry.keys]));
      } catch (err) {
        // A database blip must not kill the socket; the next tick retries.
        console.error('[live] tick failed:', err.message);
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || msg.type !== 'watch' || !Array.isArray(msg.keys)) return;

      entry.keys = new Set(
        msg.keys
          .filter((k) => typeof k === 'string' && /^(domain|service):[0-9]{1,10}$/.test(k))
          .slice(0, MAX_WATCH),
      );
      entry.last.clear();

      if (timer) clearInterval(timer);
      if (entry.keys.size) {
        tick();
        timer = setInterval(tick, TICK_MS);
      }
    });

    // A ping the browser answers keeps a proxy from closing an idle socket, and
    // tells the page's own indicator that the channel is genuinely up.
    const beat = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 25000);

    const finish = () => {
      if (timer) clearInterval(timer);
      clearInterval(beat);
      sockets.delete(entry);
      const n = countFor(customerId) - 1;
      if (n > 0) live.set(customerId, n); else live.delete(customerId);
    };
    ws.on('close', finish);
    ws.on('error', finish);

    try { ws.send(JSON.stringify({ type: 'ready' })); } catch { /* gone */ }
  });

  return onUpgrade;
}

module.exports = { attach, publish, PATHNAME };
