/**
 * The Vesopa activity log: what every person, till, screen and app did, kept
 * on the server so a fault can be traced without ringing the venue.
 *
 * ONE FILE, EVERY SERVICE
 *
 * This is the canonical copy. `tool/sync-activity-log.sh` copies it into each
 * Node service as `src/activity_log.js`, because every service is deployed on
 * its own (rsync of one folder) and cannot reach a sibling folder at runtime.
 * `shared/activity-log/test` fails if a copy has drifted. Edit here, then sync.
 *
 * No dependencies beyond Node itself, so dropping it into a service never
 * changes its package.json.
 *
 * TWO SINKS
 *
 *   file   Always on. One JSON object per line in `<dir>/activity-YYYY-MM-DD.jsonl`,
 *          a new file each day and a new part when a day passes MAX_FILE_BYTES.
 *          Files older than `fileRetainDays` are deleted.
 *   db     Optional. When given a pool, each event is also inserted into a table
 *          (epos_activity_log in vesopa_server) so the back office can filter it
 *          by venue, app, person or customer. Rows older than `dbRetainDays`
 *          are deleted in batches.
 *
 * NEVER IN THE WAY
 *
 * The same rule as wallet_log.js and bo_device_log: a log that can take down
 * the thing it observes is worse than no log. `record()` returns nothing, is
 * never awaited, and every failure is reduced to one line of process output.
 *
 * NOTHING SECRET
 *
 * Every value goes through `redact()` before it is written anywhere. Keys that
 * name a password, PIN, token, secret, card number, CVV, bank detail or one-time
 * code are replaced with "[redacted]"; a string that looks like a card number
 * (13-19 digits passing the Luhn check) or a JWT is masked wherever it appears.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_FILE_RETAIN_DAYS = 30;
const DEFAULT_DB_RETAIN_DAYS = 90;

// Keys whose values must never be written. Matched against the key with any
// camelCase turned into snake_case, so `cardNumber` and `card_number` both hit.
const SECRET_KEY = new RegExp(
  [
    'pass(word|wd|code|phrase)?', 'pin', 'pin_?hash', 'secret', 'token',
    'authori[sz]ation', 'cookie', 'session_?id', 'api_?key', 'private_?key',
    'signature', 'card_?(number|no|num)', 'pan', 'cvv2?', 'cvc2?', 'cv2',
    'security_?code', 'expiry', 'exp_?(month|year|date)', 'iban', 'bic',
    'account_?number', 'sort_?code', 'otp', 'one_?time_?code',
    'verification_?code', 'auth_?code', 'reset_?code', 'code_?verifier',
    'client_?secret', 'refresh', 'id_?token', 'access_?token', 'jwt',
    'credential', 'hash', 'salt', 'totp', 'recovery', 'mfa',
    // OAuth authorisation codes, voucher and gift codes: all spendable.
    'code',
  ].map((k) => `(^|_)${k}($|_)`).join('|'),
  'i'
);

const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const DIGIT_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

function snake(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Mask card numbers and tokens inside free text. */
function scrubText(text, max = 300) {
  let s = String(text);
  s = s.replace(JWT_LIKE, '[redacted-token]');
  s = s.replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits)
      ? `[card ••••${digits.slice(-4)}]`
      : run;
  });
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * A copy of `value` that is safe to write down.
 *
 * Bounded as well as scrubbed: four levels deep, twenty items per array, forty
 * keys per object, three hundred characters per string. A log line is for
 * reading, and a whole catalogue upload pasted into one is not readable.
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : '[…]';
  if (Array.isArray(value)) {
    const out = value.slice(0, 20).map((v) => redact(v, depth + 1));
    if (value.length > 20) out.push(`…${value.length - 20} more`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 40)) {
      out[key] = SECRET_KEY.test(snake(key)) ? '[redacted]' : redact(value[key], depth + 1);
    }
    if (keys.length > 40) out['…'] = `${keys.length - 40} more keys`;
    return out;
  }
  return String(value).slice(0, 100);
}

function clip(value, length) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return text.length > length ? text.slice(0, length) : text;
}

function dayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** The caller's address, first forwarded hop first (nginx sits in front). */
function callerIp(req) {
  if (!req) return null;
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return clip(forwarded || (req.socket && req.socket.remoteAddress) || req.ip || '', 64);
}

/**
 * Build a logger for one service.
 *
 * @param {object} options
 * @param {string} options.service         'vesopa_server', 'vesopa_web', ...
 * @param {string} [options.dir]           where the .jsonl files go (default <cwd>/logs/activity)
 * @param {object} [options.pool]          a mysql2 pool; enables the db sink
 * @param {string} [options.table]         db table (default epos_activity_log)
 * @param {number} [options.fileRetainDays]
 * @param {number} [options.dbRetainDays]
 * @param {boolean} [options.console]      also print each line (tests, local dev)
 */
function createActivityLog(options = {}) {
  const service = options.service || 'vesopa';
  const dir = options.dir || path.join(process.cwd(), 'logs', 'activity');
  const table = options.table || 'epos_activity_log';
  const fileRetainDays = options.fileRetainDays || DEFAULT_FILE_RETAIN_DAYS;
  const dbRetainDays = options.dbRetainDays || DEFAULT_DB_RETAIN_DAYS;
  let pool = options.pool || null;
  let dbBroken = false;

  let stream = null;
  let streamDay = null;
  let streamPart = 0;
  let streamBytes = 0;

  function fileFor(day, part) {
    return path.join(dir, `activity-${day}${part ? `.${part}` : ''}.jsonl`);
  }

  function openStream() {
    const day = dayStamp();
    if (stream && streamDay === day && streamBytes < MAX_FILE_BYTES) return stream;
    try {
      if (stream) stream.end();
      fs.mkdirSync(dir, { recursive: true });
      if (streamDay !== day) { streamDay = day; streamPart = 0; }
      else if (streamBytes >= MAX_FILE_BYTES) streamPart += 1;
      let file = fileFor(day, streamPart);
      // Pick up where a restart left off, moving past any part already full.
      for (;;) {
        let size = 0;
        try { size = fs.statSync(file).size; } catch { /* new file */ }
        if (size < MAX_FILE_BYTES) { streamBytes = size; break; }
        streamPart += 1;
        file = fileFor(day, streamPart);
      }
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', (error) => {
        console.warn(`[activity] ${service}: could not write the log file:`, error.message);
        stream = null;
      });
    } catch (error) {
      console.warn(`[activity] ${service}: could not open the log file:`, error.message);
      stream = null;
    }
    return stream;
  }

  /** The stored shape of one event. Everything clipped to its column. */
  function normalise(event) {
    const detail = event.detail === undefined ? undefined : redact(event.detail);
    let detailText = null;
    if (detail !== undefined && detail !== null) {
      detailText = typeof detail === 'string' ? detail : JSON.stringify(detail);
      if (detailText.length > 2000) detailText = `${detailText.slice(0, 2000)}…`;
    }
    const at = event.at ? new Date(event.at) : new Date();
    return {
      at: Number.isNaN(at.getTime()) ? new Date() : at,
      service,
      office: clip(event.office && String(event.office).toLowerCase(), 190),
      app: clip(event.app || service, 32),
      app_version: clip(event.appVersion, 32),
      device_id: clip(event.deviceId, 64),
      device_name: clip(event.deviceName && scrubText(event.deviceName), 120),
      actor: clip(event.actor && scrubText(event.actor), 190),
      actor_type: clip(event.actorType, 16),
      customer_id: clip(event.customerId, 64),
      action: clip(event.action || 'event', 32),
      target: clip(event.target && scrubText(event.target, 255), 255),
      method: clip(event.method, 8),
      status: Number.isFinite(event.status) ? Math.trunc(event.status) : null,
      ms: Number.isFinite(event.ms) ? Math.max(0, Math.round(event.ms)) : null,
      detail: detailText,
      ip: clip(event.ip, 64),
      session_id: clip(event.sessionId, 64),
    };
  }

  /**
   * Write one event. Never throws, never awaited.
   *
   * Fields (all optional except action): office, app, appVersion, deviceId,
   * deviceName, actor, actorType (staff|user|admin|customer|device|system),
   * customerId, action (tap|screen|change|request|error|signin|...), target,
   * method, status, ms, detail (any JSON; redacted), ip, sessionId, at.
   */
  function record(event = {}) {
    let row;
    try {
      row = normalise(event);
    } catch (error) {
      console.warn(`[activity] ${service}: dropped an event:`, error.message);
      return;
    }

    try {
      const line = `${JSON.stringify({ ...row, at: row.at.toISOString() })}\n`;
      if (options.console) process.stdout.write(`[activity] ${line}`);
      const out = openStream();
      if (out) {
        out.write(line);
        streamBytes += Buffer.byteLength(line);
      }
    } catch (error) {
      console.warn(`[activity] ${service}: could not write a line:`, error.message);
    }

    if (pool && !dbBroken) {
      pool
        .execute(
          `INSERT INTO ${table}
             (at, service, office, app, app_version, device_id, device_name,
              actor, actor_type, customer_id, action, target, method, status,
              ms, detail, ip, session_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            row.at, row.service, row.office, row.app, row.app_version,
            row.device_id, row.device_name, row.actor, row.actor_type,
            row.customer_id, row.action, row.target, row.method, row.status,
            row.ms, row.detail, row.ip, row.session_id,
          ]
        )
        .catch((error) => {
          // A missing table is a server deployed before its migration ran. Stop
          // trying until the next restart rather than warning on every request.
          if (error && error.code === 'ER_NO_SUCH_TABLE') dbBroken = true;
          console.warn(`[activity] ${service}: could not write the db log:`, error.message);
        });
    }
  }

  /** Delete what is past retention. Returns { files, rows }. */
  async function prune() {
    let files = 0;
    let rows = 0;
    try {
      const cutoff = dayStamp(new Date(Date.now() - fileRetainDays * 86400000));
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const m = /^activity-(\d{4}-\d{2}-\d{2})(\.\d+)?\.jsonl$/.exec(name);
        if (m && m[1] < cutoff) {
          fs.unlinkSync(path.join(dir, name));
          files += 1;
        }
      }
    } catch (error) {
      console.warn(`[activity] ${service}: could not prune log files:`, error.message);
    }
    if (pool) {
      try {
        // Batches, so a first prune on a big table never holds a lock for long.
        for (let i = 0; i < 50; i += 1) {
          const [result] = await pool.execute(
            `DELETE FROM ${table} WHERE at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 5000`,
            [dbRetainDays]
          );
          rows += result.affectedRows || 0;
          if ((result.affectedRows || 0) < 5000) break;
        }
      } catch (error) {
        console.warn(`[activity] ${service}: could not prune the db log:`, error.message);
      }
    }
    return { files, rows };
  }

  /** Prune now and then daily. unref()'d so it never holds the process open. */
  function startMaintenance(everyHours = 24) {
    const run = () => prune().then(({ files, rows }) => {
      if (files || rows) console.log(`[activity] ${service}: pruned ${files} file(s), ${rows} row(s)`);
    });
    setTimeout(run, 60 * 1000).unref();
    const timer = setInterval(run, everyHours * 3600 * 1000);
    timer.unref();
    return timer;
  }

  /**
   * Express middleware: one line for every request that changes something
   * (POST, PUT, PATCH, DELETE) and every request that fails with a 5xx.
   *
   * Written when the response finishes, so whatever auth ran on the route has
   * already put the venue and the person on `req`. `identify(req)` turns that
   * into { office, actor, actorType, customerId, deviceId, deviceName, app };
   * it may return a promise.
   *
   * `skip(req)` returns true for paths that would drown the log (heartbeats,
   * the activity endpoint itself).
   */
  function middleware({ identify, skip } = {}) {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        try {
          const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
          if (!mutating && res.statusCode < 500) return;
          if (skip && skip(req)) return;
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const route = (req.originalUrl || req.url || '').split('?')[0];
          const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length
            ? req.body
            : undefined;
          const base = {
            action: res.statusCode >= 500 ? 'error' : mutating ? 'change' : 'request',
            target: route,
            method: req.method,
            status: res.statusCode,
            ms,
            ip: callerIp(req),
            // A handler that failed can leave its reason in res.locals.activityError.
            detail: res.locals && res.locals.activityError
              ? { error: String(res.locals.activityError).slice(0, 300), body }
              : body,
          };
          Promise.resolve(identify ? identify(req) : {})
            .catch(() => ({}))
            .then((who) => record({ ...base, ...(who || {}) }));
        } catch (error) {
          console.warn(`[activity] ${service}: middleware failed:`, error.message);
        }
      });
      next();
    };
  }

  /** Attach or replace the db pool after construction. */
  function usePool(p) { pool = p; dbBroken = false; }

  return { record, prune, startMaintenance, middleware, usePool, redact, dir };
}

module.exports = { createActivityLog, redact, scrubText, callerIp, luhn };
