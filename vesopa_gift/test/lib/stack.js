/**
 * The whole of Vesopa Gift on this machine: the EPOS server and the gift server,
 * each on a scratch database, a stand-in for Dojo, and mail captured to a folder.
 *
 * Used by test/e2e.test.js and scripts/local-harness.js. Needs the local MariaDB
 * and the structure-only copy of live called vesopa_live_shape.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const mysql = require(path.join(ROOT, 'vesopa_server', 'node_modules', 'mysql2', 'promise'));
const bcrypt = require(path.join(ROOT, 'vesopa_server', 'node_modules', 'bcryptjs'));

const HOST = process.env.EXPRESS_TEST_HOST || '127.0.0.1';
const USER = process.env.EXPRESS_TEST_USER || 'root';
const PASS = process.env.EXPRESS_TEST_PASS || '';
const TEMPLATE = process.env.FIVE_TEST_TEMPLATE || 'vesopa_live_shape';
const SERVICE_KEY = 'e2e-service-key-'.padEnd(64, 'x');
const JWT = 'e2e-jwt-secret';
const PASSWORD = 'correct horse 42';

function statementsOf(sql) {
  const out = [];
  let delimiter = ';';
  let buffer = '';
  for (const line of sql.split('\n')) {
    const d = /^DELIMITER\s+(\S+)/.exec(line.trim());
    if (d) { delimiter = d[1]; continue; }
    if (line.trim().startsWith('--') && !buffer.trim()) continue;
    buffer += line + '\n';
    if (buffer.trimEnd().endsWith(delimiter)) {
      const s = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (s) out.push(s);
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDojo() {
  const intents = new Map();
  const refunds = [];
  const cancelled = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!String(req.headers.authorization || '').startsWith('Basic sk_sandbox_')) return send(401, { title: 'bad key' });
      const m = /^\/payment-intents(?:\/([^/]+))?(\/refunds)?$/.exec(req.url);
      if (!m) return send(404, { title: 'no' });
      if (req.method === 'POST' && !m[1]) {
        const id = `pi_sandbox_${++n}`;
        intents.set(id, { id, status: 'Created', amount: json.amount, reference: json.reference, config: json.config });
        return send(200, intents.get(id));
      }
      const intent = intents.get(m[1]);
      if (!intent) return send(404, { title: 'no such intent' });
      if (req.method === 'GET') {
        return send(200, { ...intent, paymentDetails: intent.status === 'Captured' ? { card: { cardNumber: '520000******1005', cardName: 'Mastercard' } } : undefined });
      }
      if (req.method === 'POST' && m[2]) {
        refunds.push({ id: intent.id, amount: json.amount, key: req.headers.idempotencykey });
        return send(200, { paymentIntentId: intent.id, refundId: `rf_${refunds.length}` });
      }
      if (req.method === 'DELETE') {
        if (intent.status === 'Captured') return send(409, { title: 'already captured' });
        intent.status = 'Canceled';
        cancelled.push(intent.id);
        return send(200, {});
      }
      send(405, {});
    });
  });
  return {
    server, intents, refunds, cancelled,
    capture: (id) => { intents.get(id).status = 'Captured'; },
    last: () => [...intents.values()].pop(),
  };
}

function start(script, env, cwd) {
  const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

async function waitUp(url, proc) {
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
  }
  throw new Error(`did not start:\n${proc.log().slice(-2500)}`);
}

/**
 * Build it. Returns null when there is no database to build it on.
 *
 * `venue` is the EPOS office to create; `brand` optional loyalty-app branding
 * for it; `giftEnv` extra environment for the gift server.
 */
async function buildStack({ eposDb, giftDb, venue, brand = null, giftEnv = {}, onCheck = null }) {
  let admin;
  try {
    admin = await mysql.createConnection({ host: HOST, user: USER, password: PASS, multipleStatements: true });
  } catch (e) {
    console.log(`-- no database reachable, skipping (${e.code || e.message})`);
    return null;
  }
  const [[tpl]] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [TEMPLATE]);
  if (!tpl.n) { console.log(`-- no ${TEMPLATE}, skipping`); await admin.end(); return null; }

  await admin.query(`DROP DATABASE IF EXISTS ${eposDb}; CREATE DATABASE ${eposDb} CHARACTER SET utf8mb4;`);
  const [tables] = await admin.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [TEMPLATE]);
  await admin.query(`USE ${eposDb}`);
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { t } of tables) {
    const [[row]] = await admin.query(`SHOW CREATE TABLE \`${TEMPLATE}\`.\`${t}\``);
    await admin.query(row['Create Table']);
  }
  await admin.query('SET FOREIGN_KEY_CHECKS = 1');
  const dir = path.join(ROOT, 'vesopa_server', 'schema');
  for (const file of ['schema.sql', ...fs.readdirSync(dir).filter((f) => /^schema_.*\.sql$/.test(f)).sort()]) {
    for (const sql of statementsOf(fs.readFileSync(path.join(dir, file), 'utf8'))) await admin.query(sql);
  }

  const applyGift = async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${giftDb}; CREATE DATABASE ${giftDb} CHARACTER SET utf8mb4;`);
    await admin.query(`USE ${giftDb}`);
    const sqls = statementsOf(fs.readFileSync(path.join(ROOT, 'vesopa_gift', 'schema', 'schema.sql'), 'utf8'));
    for (let run = 0; run < 2; run++) for (const s of sqls) await admin.query(s);
  };
  if (onCheck) await onCheck('the gift schema applies to an empty database, and again', applyGift);
  else await applyGift();
  await admin.end();

  const epos = mysql.createPool({ host: HOST, user: USER, password: PASS, database: eposDb, connectionLimit: 4 });
  const gift = mysql.createPool({ host: HOST, user: USER, password: PASS, database: giftDb, connectionLimit: 4 });
  const hash = await bcrypt.hash(PASSWORD, 4);
  await epos.query('INSERT INTO offices (id, name, contact_email, status) VALUES (?, ?, ?, ?)', [venue.id, venue.name, venue.email, 'active']);
  await epos.query("INSERT INTO backoffice_users (email, password, name, approved, office_id, role) VALUES (?, ?, 'Owner', 'Y', ?, 'office')", [venue.email, hash, venue.id]);
  if (brand) {
    await epos.query(
      'INSERT INTO epos_loyalty_app (office, enabled, slug, app_name, colour_primary, hero_url, logo_url) VALUES (?, 0, ?, ?, ?, ?, ?)',
      [venue.email, brand.slug || null, brand.name || null, brand.primary || null, brand.hero || null, brand.logo || null]
    );
  }

  const dojo = fakeDojo();
  const dojoPort = await freePort();
  await new Promise((r) => dojo.server.listen(dojoPort, '127.0.0.1', r));
  const eposPort = await freePort();
  const giftPort = await freePort();
  const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-mail-'));

  const eposProc = start(path.join(ROOT, 'vesopa_server', 'src', 'server.js'), {
    PORT: String(eposPort), NODE_ENV: 'test', JWT_SECRET: JWT,
    DB_HOST: HOST, DB_PORT: '3306', DB_USER: USER, DB_PASSWORD: PASS, DB_NAME: eposDb,
    SMTP_HOST: '', VESOPA_AUTH_ENABLED: '', VESOPA_AUTH_BACKOFFICE_ENABLED: '', VESOPA_AUTH_TILL_ENABLED: '',
    EXPRESS_SECRET_KEY: 'e2e-sealing', EXPRESS_DOJO_API_KEY: 'sk_sandbox_e2e', DOJO_API_KEY: '',
    DOJO_BASE_URL: `http://127.0.0.1:${dojoPort}`, GIFT_SERVICE_KEY: SERVICE_KEY,
    BACKOFFICE_URL: `http://127.0.0.1:${eposPort}`,
  }, path.join(ROOT, 'vesopa_server'));
  const giftProc = start(path.join(ROOT, 'vesopa_gift', 'src', 'server.js'), {
    PORT: String(giftPort), NODE_ENV: 'test', BASE_URL: `http://127.0.0.1:${giftPort}`,
    EPOS_API: `http://127.0.0.1:${eposPort}`, GIFT_SERVICE_KEY: SERVICE_KEY,
    DB_HOST: HOST, DB_PORT: '3306', DB_USER: USER, DB_PASSWORD: PASS, DB_NAME: giftDb,
    SESSION_SECRET: 'e2e-session', MAIL_CAPTURE_DIR: mailDir, GIFT_SWEEP_MS: '800',
    VESOPA_AUTH_CLIENT_ID: '', VESOPA_AUTH_CLIENT_SECRET: '', GIFT_TEST_OFFICES: String(venue.id),
    ...giftEnv,
  }, path.join(ROOT, 'vesopa_gift'));

  const G = `http://127.0.0.1:${giftPort}`;
  const E = `http://127.0.0.1:${eposPort}`;
  await waitUp(`${E}/health`, eposProc);
  await waitUp(`${G}/health`, giftProc);

  const tokenValue = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(16).toString('hex');
  await gift.query(
    "INSERT INTO gift_sessions (id, sub, email, name, roles, csrf, expires_at) VALUES (?, 'sub-owner', 'owner@gift.test', 'Meirion', 'owner', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR))",
    [crypto.createHash('sha256').update(tokenValue).digest('hex'), csrf]
  );
  const cookie = `vg_sid=${tokenValue}`;

  const get = async (url, { auth } = {}) => {
    const r = await fetch(G + url, { redirect: 'manual', headers: auth ? { Cookie: cookie } : {} });
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const post = async (url, form, { auth } = {}) => {
    const r = await fetch(G + url, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(auth ? { Cookie: cookie } : {}) },
      body: new URLSearchParams(auth ? { _csrf: csrf, ...form } : form).toString(),
    });
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  const mails = () => fs.readdirSync(mailDir).map((f) => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8')));
  const mailTo = (addr) => mails().filter((m) => ((m.envelope && m.envelope.to) || []).includes(addr));
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
  const tillLogin = () => fetch(`${E}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: venue.email, password: PASSWORD, terminal: true, device_id: 'e2e-till', device_name: 'Bar' }),
  }).then((r) => r.json()).then((j) => j.terminalToken);

  async function stop() {
    eposProc.child.kill();
    giftProc.child.kill();
    dojo.server.close();
    await epos.end();
    await gift.end();
  }

  return { G, E, gift, epos, dojo, cookie, csrf, get, post, mails, mailTo, until, tillLogin, mailDir, giftProc, eposProc, stop, sleep };
}

module.exports = { buildStack, sleep, statementsOf };
