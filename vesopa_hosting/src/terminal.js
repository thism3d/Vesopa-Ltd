/**
 * The web terminal, unprivileged half.
 *
 * The browser opens a websocket at /panel/terminal/ws. This authenticates it
 * the same way every other panel page is authenticated — the session cookie —
 * works out which hosting account is asking, and hands the connection to the
 * broker (terminal/broker.py), which is the only thing on the box that can
 * actually start a shell as somebody.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, and it is worth being precise because the
 * split is the security design:
 *
 *   here     WHO is asking. A valid, unexpired session; a customer who is not
 *            suspended; an account that actually has hosting.
 *   broker   WHETHER THAT IS ALLOWED. Never root, never an account Hestia does
 *            not have, never a shell the package has not granted.
 *
 * Neither trusts the other's half. The browser never names the account it wants
 * — it is read from the session here — and the broker re-checks everything it
 * is told anyway, because a compromised website must not be able to ask for a
 * shell as an arbitrary user and be believed.
 *
 * THE UPGRADE IS HANDLED MANUALLY, not through Express. An upgrade request is
 * not a normal request: it never reaches a route handler, so cookie-parser and
 * the session middleware have not run and `req.cookies` does not exist. The
 * cookie header is parsed here instead.
 */

const net = require('node:net');
const { WebSocketServer } = require('ws');

const db = require('./db');
const auth = require('./auth');

const SOCKET_PATH = process.env.TERMINAL_SOCKET || '/run/vesopa-terminal/broker.sock';
const PATHNAME = '/panel/terminal/ws';

/** Frame types — must match broker.py. */
const TYPE_DATA = 0;
const TYPE_RESIZE = 1;
const TYPE_NOTICE = 2;

/**
 * How many shells one customer may have at once.
 *
 * Each is a real process on a shared box. Without a cap, a page left on
 * auto-refresh — or somebody being deliberate — opens shells until the machine
 * runs out, and every other customer on the node pays for it.
 */
const MAX_PER_CUSTOMER = Number(process.env.TERMINAL_MAX_SESSIONS || 3);
const live = new Map();

function countFor(id) { return live.get(id) || 0; }
function opened(id) { live.set(id, countFor(id) + 1); }
function closed(id) {
  const n = countFor(id) - 1;
  if (n > 0) live.set(id, n); else live.delete(id);
}

/** Cookies off a raw request, since cookie-parser has not run on an upgrade. */
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const key = part.slice(0, eq).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  });
  return out;
}

/**
 * Who is on the other end of this upgrade, and may they have a shell?
 *
 * Returns the hestia username, or null with a reason. Every refusal is
 * deliberately vague to the browser and specific in the log: the person seeing
 * it is either a customer who cannot act on the detail, or somebody who should
 * not be told.
 */
async function authorise(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = auth.readCustomerSession({ cookies });
  if (!session || !session.sub) return { error: 'Not signed in.' };

  const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [session.sub]);
  if (!customer) return { error: 'Not signed in.' };

  /*
   * The session carries a fingerprint of the password it was issued against, so
   * a cookie minted before a password change stops working. Checked here as
   * well as in the HTTP middleware — a long-lived websocket is exactly the
   * thing somebody would use to keep access after being locked out.
   */
  if (session.pwv !== auth.passwordVersion(customer.password_hash)) {
    return { error: 'Your session has expired. Sign in again.' };
  }
  if (customer.status !== 'active') return { error: 'This account is not active.' };
  if (!customer.hestia_user) return { error: 'There is no hosting on this account yet.' };

  const service = await db.one(
    "SELECT id FROM services WHERE customer_id = ? AND status = 'active' LIMIT 1",
    [customer.id],
  );
  if (!service) return { error: 'There is no active hosting on this account.' };

  if (countFor(customer.id) >= MAX_PER_CUSTOMER) {
    return { error: `You already have ${MAX_PER_CUSTOMER} terminals open. Close one and try again.` };
  }

  return { customer, username: customer.hestia_user };
}

function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/**
 * Attach the terminal to an HTTP server.
 *
 * `noServer` rather than letting ws own the server: this app serves the whole
 * site from the same port, and ws in server mode would answer every upgrade on
 * every path. Here the path is checked first and anything else is refused, so a
 * stray upgrade to `/` is a 400 rather than a terminal.
 */
/**
 * @returns {(req, socket, head) => boolean}  true if this upgrade was ours.
 *
 * IT NO LONGER LISTENS ON THE SERVER ITSELF, and that is a bug fix rather than
 * tidying. This used to register its own `upgrade` listener which answered 404
 * and destroyed the socket for every path that was not the terminal's. Node
 * calls every `upgrade` listener, so the moment a second websocket server
 * existed on this process — the panel's live channel — the terminal's handler
 * killed its connections before its own listener ever ran. The symptom was a
 * live channel that reconnected forever with "Unexpected server response: 404"
 * and no error anywhere in the log, because from this file's point of view it
 * was behaving exactly as designed.
 *
 * One router in src/server.js owns the event and decides who gets it. A handler
 * that does not recognise a path now declines it and touches nothing.
 */
function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  const onUpgrade = (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (pathname !== PATHNAME) return false;

    /*
     * Same-origin only. A websocket is not covered by the same-origin policy the
     * way fetch is — any page anywhere can open one to us, and the browser will
     * attach the customer's cookies to it. Without this check, a link a customer
     * clicks could open a shell on their account and stream it to somebody else.
     * CSRF, but with a shell on the end of it.
     */
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host || new URL(origin).host !== host) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  };

  wss.on('connection', async (ws, req) => {
    let verdict;
    try {
      verdict = await authorise(req);
    } catch (err) {
      verdict = { error: 'Could not check your session.' };
      console.error('[terminal] authorise failed:', err.message);
    }

    if (verdict.error) {
      ws.send(JSON.stringify({ type: 'notice', text: verdict.error }));
      ws.close(4001, 'unauthorised');
      return;
    }

    const { customer, username } = verdict;
    opened(customer.id);

    const broker = net.createConnection(SOCKET_PATH);
    let settled = false;

    const finish = (why) => {
      if (settled) return;
      settled = true;
      closed(customer.id);
      try { broker.destroy(); } catch { /* already gone */ }
      try { ws.close(1000, why || 'closed'); } catch { /* already gone */ }
    };

    broker.on('error', (err) => {
      console.error('[terminal] broker unreachable:', err.message);
      // Said plainly. "Terminal unavailable" with no cause is the message that
      // generates a ticket nobody can answer.
      try {
        ws.send(JSON.stringify({
          type: 'notice',
          text: 'The terminal service is not running on this server. Support has been notified.',
        }));
      } catch { /* socket already gone */ }
      finish('broker-error');
    });

    broker.on('connect', () => {
      // The browser does not get to name the account. It comes from the session.
      broker.write(`${JSON.stringify({ user: username, cols: 80, rows: 24 })}\n`);
      db.logActivity({
        actorType: 'customer',
        actorId: customer.id,
        action: 'terminal.opened',
        target: username,
        ip: req.socket.remoteAddress,
      }).catch(() => {});
    });

    // ---- broker -> browser -------------------------------------------------
    let inbox = Buffer.alloc(0);
    broker.on('data', (chunk) => {
      inbox = Buffer.concat([inbox, chunk]);
      while (inbox.length >= 5) {
        const type = inbox.readUInt8(0);
        const length = inbox.readUInt32BE(1);
        if (inbox.length < 5 + length) break;
        const payload = inbox.subarray(5, 5 + length);
        inbox = inbox.subarray(5 + length);

        if (ws.readyState !== ws.OPEN) return;
        if (type === TYPE_DATA) {
          // Binary, not text: a pty emits arbitrary bytes and a partial UTF-8
          // sequence split across two reads would be mangled by a text frame.
          // xterm.js reassembles on the client.
          ws.send(payload, { binary: true });
        } else if (type === TYPE_NOTICE) {
          ws.send(JSON.stringify({ type: 'notice', text: payload.toString('utf8') }));
        }
      }
    });

    broker.on('close', () => finish('shell-exited'));

    // ---- browser -> broker -------------------------------------------------
    ws.on('message', (data, isBinary) => {
      if (broker.destroyed) return;
      if (isBinary) {
        broker.write(frame(TYPE_DATA, data));
        return;
      }
      // Text frames are control messages only; keystrokes arrive as binary.
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (msg && msg.type === 'resize') {
        broker.write(frame(TYPE_RESIZE, JSON.stringify({
          cols: Number(msg.cols) || 80,
          rows: Number(msg.rows) || 24,
        })));
      } else if (msg && msg.type === 'data' && typeof msg.data === 'string') {
        // The on-screen key bar sends text; a real keyboard sends binary.
        broker.write(frame(TYPE_DATA, Buffer.from(msg.data, 'utf8')));
      }
    });

    ws.on('close', () => finish('client-closed'));
    ws.on('error', () => finish('client-error'));
  });

  return onUpgrade;
}

module.exports = { attach, PATHNAME, SOCKET_PATH };
