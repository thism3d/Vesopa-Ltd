const mysql = require('mysql2/promise');
const config = require('./config');

/** One pool for the process. admin.vesopa.com's own data only. */
const pool = mysql.createPool({
  ...config.DB,
  waitForConnections: true,
  connectionLimit: 6,
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

module.exports = { pool, one, all, run };
