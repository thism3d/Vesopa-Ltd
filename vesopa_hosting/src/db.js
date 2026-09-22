/**
 * MySQL pool for vesopa_hostingdb.
 *
 * Shares the server with vesopa_eposdb but not the schema — see the note at the
 * top of schema.sql.
 */

const mysql = require('mysql2/promise');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: required('DB_USER'),
  password: required('DB_PASSWORD'),
  database: process.env.DB_NAME || 'vesopa_hostingdb',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_general_ci',
  // Money is integer pence and ids are integers; the driver returning BIGINT as
  // a string would turn every comparison into a string comparison.
  supportBigNumbers: true,
  bigNumberStrings: false,
  dateStrings: ['DATE'],
});

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** First row or null — the shape most lookups actually want. */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 * Checkout writes an order, its lines, a service and a domain; a half-applied
 * order is a customer charged for a site that does not exist.
 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* the rollback failing must not mask the original error */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Append to the activity log. Deliberately swallows its own errors: an audit
 * write must never be the reason a customer's action fails.
 */
async function logActivity({ actorType, actorId, action, target, detail, ok = true, ip }) {
  try {
    await query(
      `INSERT INTO activity_log (actor_type, actor_id, action, target, detail, ok, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actorType,
        actorId || null,
        String(action).slice(0, 80),
        String(target || '').slice(0, 190),
        detail ? String(detail).slice(0, 4000) : null,
        ok ? 1 : 0,
        String(ip || '').slice(0, 45),
      ],
    );
  } catch (err) {
    console.warn('[activity] could not write log entry:', err.message);
  }
}

/** Read the settings table into a plain object. Cached for a minute. */
let settingsCache = null;
let settingsAt = 0;
async function settings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsAt < 60_000) return settingsCache;
  const rows = await query('SELECT name, value FROM settings');
  settingsCache = Object.fromEntries(rows.map((r) => [r.name, r.value]));
  settingsAt = Date.now();
  return settingsCache;
}
function invalidateSettings() {
  settingsCache = null;
}

async function ping() {
  await query('SELECT 1');
}

module.exports = {
  pool,
  query,
  one,
  transaction,
  logActivity,
  settings,
  invalidateSettings,
  ping,
};
