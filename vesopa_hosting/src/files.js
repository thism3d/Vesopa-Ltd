/**
 * The file manager, unprivileged half.
 *
 * Everything a customer does to a file goes through here, and this process can
 * do none of it. It runs as the website's own unix account; the files belong to
 * the customer's. The privileged half (files/broker.py) is the only thing on the
 * box that can bridge that, and it is reachable through one unix socket whose
 * permissions are the access control.
 *
 * The split is the same one the terminal uses, for the same reason:
 *
 *   here     WHO is asking — a valid session, an active customer, an account
 *            that actually has hosting. The browser never names an account.
 *   broker   WHETHER THAT IS ALLOWED — never root, never an account Hestia does
 *            not have, never outside that account's home.
 *
 * Neither trusts the other's half. If this file were compromised outright, the
 * worst it could ask for is a file belonging to some account it can name, and
 * the broker still refuses every name that is not a real hosting account.
 *
 * WIRE FORMAT — one operation per connection, matching files/broker.py:
 *
 *   [4-byte BE length][JSON]  then `body` raw bytes if the JSON declares them
 *
 * A response body of -1 means "read until the connection closes", which is how
 * a zip is streamed without knowing its size in advance.
 */

const net = require('node:net');

const db = require('./db');

const SOCKET_PATH = process.env.FILES_SOCKET || '/run/vesopa-files/broker.sock';

/** Matches VESOPA_FILES_MAX_EDIT in the broker. Shown in the UI, so it lives here too. */
const MAX_EDIT = Number(process.env.FILES_MAX_EDIT || 2 * 1024 * 1024);
const MAX_UPLOAD = Number(process.env.FILES_MAX_UPLOAD || 512 * 1024 * 1024);

/**
 * The message a customer sees when the broker is not running.
 *
 * Said plainly and specifically. "File manager unavailable" with no cause is
 * the message that generates a support ticket nobody can answer.
 */
const NO_BROKER = 'The file service is not running on this server. Support has been notified.';

class FileError extends Error {
  constructor(message, code = 'error', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * The hosting account behind a signed-in customer, or an explanation.
 *
 * `req.customer` has already been through the session middleware in server.js,
 * which checks the signature, the expiry and the password fingerprint. What is
 * left to establish is that this customer has hosting to look at.
 */
async function accountFor(customer) {
  if (!customer) throw new FileError('Not signed in.', 'auth', 401);
  if (customer.status !== 'active') throw new FileError('This account is not active.', 'auth', 403);
  if (!customer.hestia_user) {
    throw new FileError('There is no hosting on this account yet.', 'nohosting', 403);
  }
  const service = await db.one(
    "SELECT id FROM services WHERE customer_id = ? AND status = 'active' LIMIT 1",
    [customer.id],
  );
  if (!service) throw new FileError('There is no active hosting on this account.', 'nohosting', 403);
  return customer.hestia_user;
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

function frame(payload, bodyLength) {
  const json = Buffer.from(JSON.stringify({ ...payload, body: bodyLength || 0 }), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return Buffer.concat([head, json]);
}

/**
 * Open the socket, send one request, and resolve once the response HEADER has
 * arrived — the body, if any, is left unread on the socket for the caller.
 *
 * `readable` rather than `data` events throughout, because a caller that wants
 * the body needs to `unshift()` whatever arrived alongside the header and then
 * pipe. That is only possible on a stream that has not been put into flowing
 * mode.
 */
function open(payload, { body = null, bodyStream = null, bodyLength = 0, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let done = false;

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
      finish(new FileError('That took too long and was stopped.', 'timeout', 504));
    });

    socket.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
        console.error('[files] broker unreachable:', err.message);
        finish(new FileError(NO_BROKER, 'nobroker', 503));
        return;
      }
      finish(new FileError('The file service could not be reached.', 'nobroker', 503));
    });

    // The header arrives in an unknown number of chunks. Length first, then
    // exactly that many bytes of JSON, and anything past it belongs to the body.
    let want = -1;
    function onReadable() {
      for (;;) {
        if (want < 0) {
          const head = socket.read(4);
          if (!head) return;
          want = head.readUInt32BE(0);
          if (want > 1 << 20) {
            finish(new FileError('The file service sent something unreadable.', 'protocol', 502));
            return;
          }
        }
        const json = socket.read(want);
        if (!json) return;

        let header;
        try {
          header = JSON.parse(json.toString('utf8'));
        } catch {
          finish(new FileError('The file service sent something unreadable.', 'protocol', 502));
          return;
        }
        socket.setTimeout(0);
        finish(null, { header, socket });
        return;
      }
    }

    socket.on('readable', onReadable);
    socket.on('connect', () => {
      socket.write(frame(payload, bodyLength));
      /*
       * The body follows the header frame on the same connection, and the
       * broker is already blocked reading exactly `bodyLength` bytes of it.
       *
       * `end: false` on the pipe matters: ending the socket here would
       * half-close it, and the response still has to come back the other way.
       */
      if (body) socket.write(body);
      else if (bodyStream) bodyStream.pipe(socket, { end: false });
    });
    socket.on('close', () => {
      // A close before the header means the broker died mid-request. Without
      // this the promise would hang and the customer's page would spin forever.
      finish(new FileError('The file service closed the connection.', 'nobroker', 503));
    });
  });
}

function refuse(header) {
  const status = { forbidden: 403, refused: 400, denied: 403, missing: 404, exists: 409, quota: 507 };
  throw new FileError(header.error || 'That did not work.', header.code || 'error', status[header.code] || 400);
}

/**
 * A request whose whole answer is JSON. The common case.
 */
async function call(user, payload) {
  const { header, socket } = await open({ ...payload, user });
  socket.destroy();
  if (!header.ok) refuse(header);
  return header;
}

/**
 * A request that SENDS a buffer — writing a file from the editor.
 */
async function callWithBody(user, payload, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  if (buf.length > MAX_EDIT) {
    throw new FileError('That file is too large to save from the editor.', 'toobig', 413);
  }
  const { header, socket } = await open({ ...payload, user }, {
    body: buf,
    bodyLength: buf.length,
  });
  socket.destroy();
  if (!header.ok) refuse(header);
  return header;
}

/**
 * A request that streams a body THROUGH — an upload.
 *
 * The HTTP request is piped to the broker rather than buffered, so a 400 MB
 * upload costs this process a socket and not 400 MB of heap. `length` has to be
 * known up front because the broker reads exactly that many bytes; it comes
 * from Content-Length, which the browser always sets for a file body.
 */
async function callWithStream(user, payload, stream, length) {
  if (!Number.isFinite(length) || length < 0) {
    throw new FileError('The upload did not say how large it was.', 'nolength', 411);
  }
  if (length > MAX_UPLOAD) {
    throw new FileError('That file is larger than the upload limit.', 'toobig', 413);
  }
  const { header, socket } = await open({ ...payload, user }, {
    bodyStream: stream,
    bodyLength: length,
    timeoutMs: 600_000,
  });
  socket.destroy();
  if (!header.ok) refuse(header);
  return header;
}

/**
 * A request whose answer is a FILE. Resolves with the header and a socket
 * positioned at the first byte of the body.
 */
async function openStream(user, payload) {
  const { header, socket } = await open({ ...payload, user }, { timeoutMs: 120_000 });
  if (!header.ok) {
    socket.destroy();
    refuse(header);
  }
  return { header, socket };
}

module.exports = {
  SOCKET_PATH,
  MAX_EDIT,
  MAX_UPLOAD,
  FileError,
  accountFor,
  call,
  callWithBody,
  callWithStream,
  openStream,
  open,
  frame,
};
