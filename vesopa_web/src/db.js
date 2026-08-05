/**
 * MySQL pool.
 *
 * Points at the same `vesopa_eposdb` the back office (vesopa_server) uses, so a
 * demo request approved in this admin panel writes the `backoffice_users` row
 * that the back office then authenticates against.
 */

const mysql = require('mysql2/promise');

// Credentials come from the environment only. The PHP site hardcoded them in
// server_files/connectserver.php, which meant every copy of the source was a
// copy of the database password.
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
  database: process.env.DB_NAME || 'vesopa_eposdb',
  waitForConnections: true,
  connectionLimit: 10,
  // Full Unicode, so an emoji in an enquiry message (4-byte UTF-8) stores
  // rather than erroring the insert.
  charset: 'utf8mb4',
});

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 * The approval flow touches three tables and must not half-apply.
 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { pool, transaction };
