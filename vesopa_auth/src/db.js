/**
 * The database pool, and the three helpers everything else uses.
 *
 * `query` for many rows, `one` for none-or-one, `transaction` for anything that
 * must not half-happen. Nothing in this application talks to mysql2 directly,
 * so connection handling has one place to be wrong rather than forty.
 */

const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,

  // Keep DATETIME columns as strings rather than JavaScript Dates.
  //
  // The driver would otherwise build a Date in the *server process's* timezone,
  // and then everything that formats one has to remember to undo that. Times
  // here are UTC in the database and formatted for display exactly once, in the
  // view layer. A login history that is an hour out every summer is the classic
  // symptom of getting this wrong.
  dateStrings: true,

  // Every string column in this schema pins utf8mb4. The connection has to
  // agree, or the driver negotiates something else and comparisons that work in
  // the mysql client fail through the pool.
  charset: 'utf8mb4_general_ci',

  // Named placeholders are not enabled, deliberately: `?` positional binding is
  // what every query here uses, and mixing the two styles is how a parameter
  // ends up interpolated as a literal.
  namedPlaceholders: false,

  // A connection that has been idle behind a firewall for hours is dead but
  // still in the pool; this notices before a request does.
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
});

/** Run a query, get the rows. */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Run a query expecting at most one row. Returns null rather than undefined. */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Run an INSERT/UPDATE/DELETE, get the result header (insertId, affectedRows). */
async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/**
 * Run a function inside a transaction, on one connection.
 *
 * The callback is handed a `tx` object with the same three helpers, and it must
 * use them — reaching for the module-level `query` inside a transaction takes a
 * DIFFERENT connection from the pool, so that statement is outside the
 * transaction, commits on its own, and is not rolled back when the rest fails.
 * That bug is invisible until the day something errors halfway.
 */
async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const tx = {
      async query(sql, params = []) {
        const [rows] = await connection.execute(sql, params);
        return rows;
      },
      async one(sql, params = []) {
        const [rows] = await connection.execute(sql, params);
        return rows.length ? rows[0] : null;
      },
      async execute(sql, params = []) {
        const [result] = await connection.execute(sql, params);
        return result;
      },
      connection,
    };
    const value = await work(tx);
    await connection.commit();
    return value;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A rollback that fails on a dead connection must not replace the real
      // error with a less useful one.
    }
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Was this error the unique index refusing a duplicate?
 *
 * This is not an edge case in this application — it is the normal path. The
 * uniqueness of an active identity is enforced by an index precisely so that
 * two simultaneous registrations cannot both succeed, which means the loser
 * gets ER_DUP_ENTRY and has to be told "that address is already in use" rather
 * than shown a 500.
 */
function isDuplicate(error) {
  return error && (error.errno === 1062 || error.code === 'ER_DUP_ENTRY');
}

/** Confirm the database is actually there. Called once at boot. */
async function check() {
  const row = await one('SELECT DATABASE() AS db, VERSION() AS version');
  return row;
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, one, execute, transaction, isDuplicate, check, close };
