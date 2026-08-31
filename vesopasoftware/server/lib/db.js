import mysql from "mysql2/promise";
import fs from "node:fs/promises";
import path from "node:path";
import { config, SERVER_DIR } from "./config.js";

// decimalNumbers keeps DECIMAL columns as JS numbers rather than strings.
// Every money column in the schema is DECIMAL(12,2); at that scale a double
// is exact, and the alternative — string maths in a dozen templates — is how
// totals quietly go wrong.
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4_unicode_ci",
  decimalNumbers: true,
  dateStrings: ["DATE"],
});

export const q = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return rows;
};

export const one = async (sql, params = []) => (await q(sql, params))[0] || null;

export const exec = async (sql, params = []) => {
  const [res] = await pool.query(sql, params);
  return res;
};

/** Fail loudly and usefully — a dead MAMP is the likeliest cause of every
 *  first-run problem, and "ECONNREFUSED" alone does not tell you that. */
export async function assertConnection() {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    const where = config.db.socketPath
      ? config.db.socketPath
      : `${config.db.host}:${config.db.port}`;
    throw new Error(
      `Cannot reach MySQL at ${where} as '${config.db.user}'.\n` +
        `  ${err.code || err.message}\n\n` +
        `  · Is MAMP running? Its mysqld listens on 3306 by default (8889 on the\n` +
        `    alternate port preset — check MAMP → Preferences → Ports).\n` +
        `  · Does the database '${config.db.database}' exist? Run: npm run db:setup\n`,
    );
  }
}

/** Apply schema.sql. Every statement is CREATE TABLE IF NOT EXISTS, so this is
 *  safe to run against an existing database on every boot. */
export async function migrate() {
  const sql = await fs.readFile(path.join(SERVER_DIR, "schema.sql"), "utf8");
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

/** Create the database itself if it is missing, then migrate. */
export async function setup() {
  const { database, ...rest } = config.db;
  const conn = await mysql.createConnection(rest);
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }
  await migrate();
}

/** Next reference in a per-table sequence, e.g. VQ-0007 / VP-0012 / INV-0031.
 *  Reads MAX() rather than counting rows so deleting a row never reissues a
 *  reference that a customer has already seen on an email. */
export async function nextRef(table, column, prefix, pad = 4) {
  const row = await one(
    `SELECT ${column} AS ref FROM ${table}
      WHERE ${column} LIKE ? ORDER BY LENGTH(${column}) DESC, ${column} DESC LIMIT 1`,
    [`${prefix}-%`],
  );
  const last = row ? parseInt(String(row.ref).slice(prefix.length + 1), 10) : 0;
  return `${prefix}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(pad, "0")}`;
}
