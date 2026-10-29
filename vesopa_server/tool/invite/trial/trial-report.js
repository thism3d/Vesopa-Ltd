#!/usr/bin/env node
/**
 * Read-only: has anybody used the trial logins made by approve-trial.js?
 *
 *   node tool/invite/trial/trial-report.js
 *
 * There is no last-login column, so for each address in accounts.log it shows
 * the traces a sign-in leaves: the password no longer TryVeposa (they changed
 * it), a Vesopa account linked (Continue with Vesopa), till / kitchen /
 * display seats on their office, and rows in their office's own tables.
 * Changes nothing.
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { execSync } = require('child_process');

const app = execSync('ls -d /home/*/web/vesopaepos.com/private/nodeapp 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
const req = createRequire(path.join(app, 'package.json'));
const env = req('dotenv').parse(fs.readFileSync(path.join(app, '.env')));

async function main() {
  const emails = fs.readFileSync(path.join(__dirname, 'accounts.log'), 'utf8')
    .split('\n').map((l) => l.split('\t')[1]).filter(Boolean);
  const bcrypt = req('bcryptjs');
  const db = await req('mysql2/promise').createConnection({
    host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306),
    user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME || 'vesopa_eposdb',
  });

  // Tables that hang off an office by its contact email (`office` column),
  // the way bo_till_seats does: anything there beyond the seats is data the
  // person made themselves.
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'office' AND TABLE_NAME <> 'bo_till_seats'`);

  let used = 0;
  for (const email of emails) {
    const [[u]] = await db.query(
      `SELECT u.id, u.password, u.vesopa_sub, u.vesopa_linked_at, u.approved, o.id AS office_id
         FROM backoffice_users u LEFT JOIN offices o ON o.id = u.office_id WHERE LOWER(u.email) = ?`, [email]);
    if (!u) { console.log(`${email}\tNO ACCOUNT`); continue; }
    const changed = !(await bcrypt.compare('TryVeposa', u.password || ''));
    const [seats] = await db.query(
      `SELECT kind, device_name, signed_in_at, last_seen_at FROM bo_till_seats WHERE office = ? ORDER BY signed_in_at`, [email])
      .catch(() => [[]]);
    const own = [];
    for (const { TABLE_NAME: t } of tables) {
      const [[c]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE office = ?`, [email]).catch(() => [[{ n: 0 }]]);
      if (c.n) own.push(`${t}:${c.n}`);
    }
    const signs = [];
    if (changed) signs.push('password changed');
    if (u.vesopa_sub) signs.push(`Vesopa account linked ${u.vesopa_linked_at ? new Date(u.vesopa_linked_at).toISOString().slice(0, 16) : ''}`);
    for (const s of seats) signs.push(`${s.kind || 'till'} "${s.device_name || '?'}" signed in ${new Date(s.signed_in_at).toISOString().slice(0, 16)}, last seen ${new Date(s.last_seen_at).toISOString().slice(0, 16)}`);
    if (own.length) signs.push(`data: ${own.join(', ')}`);
    if (signs.length) used++;
    console.log(`${email}\t${signs.length ? signs.join('; ') : '-'}`);
  }
  await db.end();
  console.log(`\n${used} of ${emails.length} show some use.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
