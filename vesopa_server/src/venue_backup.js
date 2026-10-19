/**
 * Backups, venue by venue, every night (2026-10-19).
 *
 * The owner: "everyday backup each venue data and save their database to the
 * vesopaepos.com/admin venue wise". So every night, for every active venue:
 *
 *   * a file of that venue's rows only, every table that holds venue data,
 *     including the rows that hang off a parent (an order's lines and
 *     payments, a kitchen ticket's lines...). It is data only, as INSERT
 *     IGNORE statements, so it can never drop or replace a table. Restore it
 *     into a scratch database built from that night's schema file, never
 *     straight into live.
 *   * a manifest beside it: the row count per table, size, and SHA-256, so a
 *     backup can be checked without opening it.
 *
 * And once a night, a full dump of the whole database (schema, data, routines)
 * as the safety net, plus the schema on its own for scratch restores.
 *
 * Kept: every night for 30 days, then the first of each month for 12 months.
 * Files live under BACKUP_DIR (default /home/vesopasoftware/backups), mode
 * 0600, owned by the app user, and only the platform admin can list or download
 * them (admin.js routes below, Offices › Backups).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = process.env.BACKUP_DIR || '/home/vesopasoftware/backups';
const VENUES = path.join(ROOT, 'venues');
const FULL = path.join(ROOT, 'db');
const KEEP_DAYS = 30;
const KEEP_MONTHS = 12;
const RUN_AT_HOUR = Number(process.env.BACKUP_HOUR || 3); // 03:xx server time

// Tables that are Vesopa's own, not a venue's: in the full dump only.
const PLATFORM = new Set([
  'admin_table', 'blog_posts', 'bo_app_update_settings', 'bo_module_prices', 'bo_module_promos',
  'backoffice_password_resets', 'career_request', 'customer_message', 'demo_request', 'dojo_webhook_events',
  'epos_templates', 'loyalty_site_settings', 'media_files', 'menu_site_settings', 'paypal_subscriptions',
  'paypal_transactions', 'training_request', 'trial_signup', 'web_plans',
]);

// Rows that belong to a venue through a parent row.
const CHILDREN = {
  epos_order_lines: ['order_id', 'epos_orders'],
  epos_payments: ['order_id', 'epos_orders'],
  dinein_order_lines: ['dinein_order_id', 'dinein_orders'],
  epos_kitchen_ticket_lines: ['ticket_id', 'epos_kitchen_tickets'],
  epos_kitchen_ticket_stations: ['ticket_id', 'epos_kitchen_tickets'],
  bo_stock_doc_lines: ['doc_id', 'bo_stock_docs'],
  bo_purchase_order_lines: ['order_id', 'bo_purchase_orders'],
  bo_mix_match_products: ['mix_match_id', 'bo_mix_match'],
  bo_price_level_run_items: ['run_id', 'bo_price_level_runs'],
  epos_promotion_products: ['promotion_id', 'epos_promotions'],
  epos_event_tickets: ['event_id', 'epos_events'],
  epos_event_ticket_types: ['event_id', 'epos_events'],
};

// Which column names a venue in a table, best first. office_id holds the
// venue's id; the others hold its contact email (the tenant key).
const BY_ID = ['office_id'];
const BY_EMAIL = ['office', 'email_key', 'office_email', 'contact_email', 'email'];

const qid = (n) => '`' + String(n).replace(/`/g, '``') + '`';
const slug = (s) => String(s || 'venue').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'venue';
const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** How each table finds a venue's rows: [{ table, where(office) }]. */
async function plan(db) {
  const [cols] = await db.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  const [views] = await db.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE <> 'BASE TABLE'"
  );
  const skip = new Set(views.map((v) => v.t));
  const byTable = new Map();
  for (const { t, c } of cols) {
    if (!byTable.has(t)) byTable.set(t, new Set());
    byTable.get(t).add(c);
  }
  const keyOf = (t) => {
    const c = byTable.get(t);
    if (!c) return null;
    if (t === 'offices') return { col: 'id', by: 'id' };
    for (const k of BY_ID) if (c.has(k)) return { col: k, by: 'id' };
    for (const k of BY_EMAIL) if (c.has(k)) return { col: k, by: 'email' };
    return null;
  };
  const out = [];
  const missing = [];
  for (const t of [...byTable.keys()].sort()) {
    if (PLATFORM.has(t) || skip.has(t)) continue;
    const own = keyOf(t);
    if (own) {
      out.push({ table: t, where: (v, esc) => `${qid(own.col)} = ${esc(own.by === 'id' ? v.id : v.email)}` });
      continue;
    }
    const child = CHILDREN[t];
    const parentKey = child && keyOf(child[1]);
    if (child && parentKey) {
      out.push({
        table: t,
        where: (v, esc) => `${qid(child[0])} IN (SELECT id FROM ${qid(child[1])} WHERE ${qid(parentKey.col)} = ${esc(parentKey.by === 'id' ? v.id : v.email)})`,
      });
      continue;
    }
    missing.push(t);
  }
  return { tables: out, missing };
}

/** A temporary client options file, so the password is never on a command line. */
function credentialsFile() {
  const file = path.join(os.tmpdir(), `.vesopa-dump-${process.pid}-${crypto.randomBytes(4).toString('hex')}.cnf`);
  const lines = ['[client]', `user=${process.env.DB_USER || ''}`, `password=${process.env.DB_PASSWORD || ''}`,
    `host=${process.env.DB_HOST || '127.0.0.1'}`, `port=${Number(process.env.DB_PORT) || 3306}`];
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

const DUMP = fs.existsSync('/usr/bin/mariadb-dump') ? '/usr/bin/mariadb-dump' : 'mysqldump';

/** Run the dump tool, piping its output into [sink] (not ending it). */
function dump(cnf, args, sink) {
  return new Promise((resolve, reject) => {
    const p = spawn(DUMP, [`--defaults-extra-file=${cnf}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => { if (!sink.write(d)) { p.stdout.pause(); sink.once('drain', () => p.stdout.resume()); } });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${DUMP} exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

/** Pipe [gz] into [file]; resolves once the file is written, after gz.end(). */
function finish(gz, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    gz.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    gz.on('error', reject);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function venueDir(v) {
  return path.join(VENUES, `${v.id}-${slug(v.name)}`);
}

/**
 * Back up one venue. [v] = { id, name, email }. Returns its manifest.
 * Tables with no rows for the venue are counted and left out of the file.
 */
async function backupVenue(db, v, { reason = 'nightly', by = null, tablePlan = null } = {}) {
  const dbName = process.env.DB_NAME || 'vesopa_eposdb';
  const p = tablePlan || await plan(db);
  const dir = venueDir(v);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const when = new Date();
  const base = `${stamp(when)}-${reason === 'nightly' ? 'nightly' : 'manual'}`;
  const tmp = path.join(dir, `.${base}.sql.gz.part`);
  const file = path.join(dir, `${base}.sql.gz`);
  const esc = (x) => db.escape(x);
  const counts = {};
  const gz = zlib.createGzip({ level: 9 });
  const done = finish(gz, tmp);
  gz.write(`-- Vesopa venue backup: ${v.name} (office ${v.id}, ${v.email})\n-- Taken ${when.toISOString()} (${reason}${by ? `, by ${by}` : ''})\n`
    + '-- Data only, INSERT IGNORE. Restore into a scratch database made from the schema file, never straight into live.\n'
    + 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\n\n');
  const cnf = credentialsFile();
  try {
    for (const t of p.tables) {
      const where = t.where(v, esc);
      const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM ${qid(t.table)} WHERE ${where}`);
      counts[t.table] = Number(n);
      if (!Number(n)) continue;
      gz.write(`\n-- ${t.table}: ${n} row(s)\n`);
      await dump(cnf, ['--single-transaction', '--quick', '--no-create-info', '--skip-triggers', '--insert-ignore',
        '--skip-add-locks', '--skip-disable-keys', '--skip-comments', '--hex-blob', '--default-character-set=utf8mb4',
        `--where=${where}`, dbName, t.table], gz);
    }
    gz.write('\nSET FOREIGN_KEY_CHECKS=1;\nSET UNIQUE_CHECKS=1;\n-- Backup complete.\n');
    gz.end();
  } catch (e) {
    gz.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    fs.rmSync(cnf, { force: true });
  }
  await done;
  fs.renameSync(tmp, file);
  const manifest = {
    venue: { id: v.id, name: v.name, email: v.email },
    file: path.basename(file),
    taken_at: when.toISOString(),
    reason,
    by,
    bytes: fs.statSync(file).size,
    sha256: await sha256(file),
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
    tables: counts,
    not_covered: p.missing,
  };
  fs.writeFileSync(file.replace(/\.sql\.gz$/, '.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/** The whole database, and its schema on its own. */
async function backupFull() {
  const dbName = process.env.DB_NAME || 'vesopa_eposdb';
  fs.mkdirSync(FULL, { recursive: true, mode: 0o700 });
  const s = stamp();
  const cnf = credentialsFile();
  try {
    const out = {};
    for (const [kind, args] of [
      ['full', ['--single-transaction', '--quick', '--routines', '--hex-blob', '--default-character-set=utf8mb4', dbName]],
      ['schema', ['--no-data', '--routines', '--skip-triggers', '--default-character-set=utf8mb4', dbName]],
    ]) {
      const file = path.join(FULL, `${kind}-${dbName}-${s}.sql.gz`);
      const tmp = `${file}.part`;
      const gz = zlib.createGzip({ level: 9 });
      const done = finish(gz, tmp);
      try {
        await dump(cnf, args, gz);
        gz.end();
      } catch (e) {
        gz.destroy();
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      await done;
      fs.renameSync(tmp, file);
      out[kind] = { file: path.basename(file), bytes: fs.statSync(file).size, sha256: await sha256(file) };
    }
    return out;
  } finally {
    fs.rmSync(cnf, { force: true });
  }
}

/** Keep 30 days of nightlies, then the first of each month for a year. Manual ones too. */
function prune(dir, now = new Date()) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = /^(?:[a-z]+-[a-z0-9_]+-)?(\d{4})(\d{2})(\d{2})-\d{6}/.exec(name);
    if (!m) continue;
    const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const age = (now - day) / 86400000;
    const monthly = m[3] === '01' && age <= KEEP_MONTHS * 31;
    if (age > KEEP_DAYS && !monthly) {
      fs.rmSync(path.join(dir, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function activeVenues(db) {
  const [rows] = await db.query(
    "SELECT id, name, contact_email AS email FROM offices WHERE status <> 'archived' AND demo_of IS NULL AND contact_email IS NOT NULL ORDER BY id"
  ).catch(async (e) => {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    return db.query("SELECT id, name, contact_email AS email FROM offices WHERE status <> 'archived' ORDER BY id");
  });
  return rows;
}

/** The nightly run: full dump, every venue, prune. Never throws. */
async function backupAll(db, { log = console } = {}) {
  const started = Date.now();
  const report = { started_at: new Date(started).toISOString(), full: null, venues: [], failed: [] };
  try {
    report.full = await backupFull();
  } catch (e) {
    report.failed.push({ venue: 'full', error: e.message });
    log.error('[backup] full dump failed:', e.message);
  }
  let tablePlan;
  try {
    tablePlan = await plan(db);
  } catch (e) {
    report.failed.push({ venue: 'plan', error: e.message });
    return report;
  }
  for (const v of await activeVenues(db)) {
    try {
      const m = await backupVenue(db, v, { tablePlan });
      report.venues.push({ id: v.id, rows: m.rows, bytes: m.bytes });
      prune(venueDir(v));
    } catch (e) {
      report.failed.push({ venue: v.id, error: e.message });
      log.error(`[backup] venue ${v.id} failed:`, e.message);
    }
  }
  prune(FULL);
  report.seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(ROOT, 'last-run.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  log.log(`[backup] ${report.venues.length} venue(s) and the full database backed up in ${report.seconds}s` +
    (report.failed.length ? `, ${report.failed.length} failed` : ''));
  return report;
}

/** The backups of one venue, newest first, from their manifests. */
function listVenue(v) {
  const dir = venueDir(v);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        return fs.existsSync(path.join(dir, m.file)) ? m : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
}

/** The path of a venue's backup file, or null: a name from listVenue only. */
function venueFile(v, name) {
  if (!/^[0-9]{8}-[0-9]{6}-(nightly|manual)\.sql\.gz$/.test(String(name))) return null;
  const file = path.join(venueDir(v), name);
  return fs.existsSync(file) ? file : null;
}

function listFull() {
  if (!fs.existsSync(FULL)) return [];
  return fs.readdirSync(FULL)
    .filter((n) => n.endsWith('.sql.gz'))
    .map((n) => ({ file: n, bytes: fs.statSync(path.join(FULL, n)).size, kind: n.split('-')[0] }))
    .sort((a, b) => (a.file < b.file ? 1 : -1));
}

function fullFile(name) {
  if (!/^(full|schema)-[A-Za-z0-9_]+-[0-9]{8}-[0-9]{6}\.sql\.gz$/.test(String(name))) return null;
  const file = path.join(FULL, name);
  return fs.existsSync(file) ? file : null;
}

function lastRun() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'last-run.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Once a night at RUN_AT_HOUR, in the app itself, so it ships with every
 * deploy. A marker file stops a restart re-running the same night.
 */
function startBackupScheduler({ pool, log = console }) {
  if (process.env.NODE_ENV === 'test' || process.env.BACKUPS === 'off') return;
  const marker = path.join(ROOT, '.last-nightly');
  let running = false;
  const tick = async () => {
    const now = new Date();
    if (running || now.getHours() !== RUN_AT_HOUR) return;
    const today = now.toISOString().slice(0, 10);
    try {
      if (fs.readFileSync(marker, 'utf8').trim() === today) return;
    } catch { /* first run */ }
    running = true;
    try {
      fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, today, { mode: 0o600 });
      await backupAll(pool, { log });
    } catch (e) {
      log.error('[backup] nightly run failed:', e.message);
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => { tick(); }, 5 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = {
  ROOT,
  plan,
  backupVenue,
  backupFull,
  backupAll,
  prune,
  listVenue,
  venueFile,
  listFull,
  fullFile,
  lastRun,
  activeVenues,
  startBackupScheduler,
};
