const mysql = require('mysql2/promise');
const config = require('./config');

/**
 * One pool for the process.
 *
 * `dateStrings` stays off: DATETIME columns come back as Date objects in the
 * server's zone (UTC on the live box), and every place that shows one to a
 * person formats it in Europe/London on purpose -- see util.when().
 */
const pool = mysql.createPool({
  ...config.DB,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: 'Z',
});

async function one(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function all(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function run(sql, params) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/** A transaction on one connection, rolled back if `fn` throws. */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, one, all, run, tx };
