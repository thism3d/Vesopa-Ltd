/**
 * A brand-new venue sees nothing but its own, on the live back office.
 *
 * WHY THIS EXISTS
 *
 * A venue created one morning opened Import, chose their spreadsheet, and read
 * "Products — 510 new, 17 to update". On a site with no products at all, "to
 * update" can only mean the import is looking at somebody else's catalogue —
 * which is exactly what it looked like, and exactly the fault that had just
 * been fixed in the report routes.
 *
 * It was not that. All 17 were rows the venue's own file repeated within
 * itself, and the preview counts a repeat as an update because the second row
 * updates the one the first row creates. But "it is fine, I checked the
 * database" is not something a venue can verify, and the next new site will
 * raise it again. So this proves it from the outside, the way they saw it:
 * a real office, created for this run, driven through Chrome against the live
 * server, asked what it can see.
 *
 * WHAT IT ASSERTS
 *
 *   * a login for a new office can reach the back office at all;
 *   * every catalogue screen it opens is empty — no products, no departments,
 *     no sub departments belonging to anybody else;
 *   * an import preview of a file with no repeats says nothing is "to update";
 *   * an import preview of a file that repeats one row says exactly one is,
 *     which is the number the venue saw and the reason for it.
 *
 * IT WRITES TO THE LIVE DATABASE
 *
 * One office and one login, under an address nobody trades under, both removed
 * on the way out — including if an assertion fails. It touches no existing
 * office, and nothing it creates is reachable by anybody else. Run it directly:
 *
 *     node test/new-office-live.browser.js
 *
 * Credentials come from .env.claude-tools, which is gitignored.
 */

const assert = require('assert');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer');

const BASE = 'https://backoffice.vesopaepos.com';

// Nobody trades under .invalid — it is reserved by RFC 2606 precisely so a
// test address cannot collide with a real one.
//
// KEEP is the standing office, created once and left in place so the check can
// be re-run against a site that is genuinely a few days old rather than a few
// seconds. Without it, every run creates and drops an office, and an office
// that has never existed for longer than one run cannot prove much about the
// state a real new venue is in. Pass --ephemeral to have it made and removed.
const KEEP_EMAIL = 'isolation@vesopa.invalid';
const KEEP_PASSWORD = 'Isolate@2026';
const EPHEMERAL = process.argv.includes('--ephemeral');

const STAMP = Date.now();
const OFFICE_EMAIL = EPHEMERAL ? `new-office-${STAMP}@vesopa.invalid` : KEEP_EMAIL;
const OFFICE_NAME = EPHEMERAL ? `Isolation check ${STAMP}` : 'Isolation Test Venue';
const PASSWORD = EPHEMERAL ? `Check-${STAMP}-pw` : KEEP_PASSWORD;

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** Read .env.claude-tools ourselves; Git Bash mangles paths through the shell. */
function settings() {
  const file = path.join(__dirname, '..', '..', '.env.claude-tools');
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#') || !text.includes('=')) continue;
    const [key, ...rest] = text.split('=');
    values[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

/**
 * Run one SQL statement on the live server over SSH.
 *
 * The database does not listen to the outside world, so there is no route to it
 * but the box itself.
 *
 * The statement travels base64-encoded and is decoded on the far side. Sending
 * it as text does not survive the trip: a bcrypt hash is full of `$`, and by
 * the time it had been through this shell and the remote one, `$2b$10$ckX...`
 * arrived as `\b\0\` — which inserts an account whose password can never match,
 * and the only symptom is a login that fails for no visible reason. Base64 is
 * alphanumeric, so there is nothing left for a shell to interpret.
 */
function sql(statement) {
  const { execFileSync } = require('child_process');
  const env = settings();
  const script = path.join(
    __dirname, '..', '..', '.claude', 'skills', 'vesopa-ops', 'scripts', 'vesopa_ssh.py'
  );
  const b64 = Buffer.from(statement, 'utf8').toString('base64');
  const out = execFileSync(
    'python',
    [script, 'run',
     `echo ${b64} | base64 -d | mysql -uroot -p'${env.MYSQL_ROOT_PASSWORD}' -N -B`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  return out
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('mysql: Deprecated'))
    .map((l) => l.split('\t'));
}

/** A workbook in memory, as a browser would upload it. */
async function workbook(rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Products');
  sheet.addRow(['PLU', 'Product', 'Department', 'Sub department', 'Price']);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------

async function createOffice() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  // Explicit ids: these tables carry no default for `id` on this server, which
  // is why an insert without one fails with "doesn't have a default value".
  sql(
    `INSERT INTO vesopa_eposdb.offices (id, name, contact_email, status)
     SELECT COALESCE(MAX(id),0)+1, '${OFFICE_NAME}', '${OFFICE_EMAIL}', 'active'
       FROM vesopa_eposdb.offices`
  );
  const [[officeId]] = sql(
    `SELECT id FROM vesopa_eposdb.offices WHERE contact_email = '${OFFICE_EMAIL}'`
  );
  sql(
    `INSERT INTO vesopa_eposdb.backoffice_users
       (id, email, password, name, approved, office_id, role)
     SELECT COALESCE(MAX(id),0)+1, '${OFFICE_EMAIL}', '${hash}',
            'Isolation check', 'Y', ${officeId}, 'office'
       FROM vesopa_eposdb.backoffice_users`
  );
  return officeId;
}

function removeOffice() {
  // The login first: it points at the office.
  sql(`DELETE FROM vesopa_eposdb.backoffice_users WHERE email = '${OFFICE_EMAIL}'`);
  sql(`DELETE FROM vesopa_eposdb.offices WHERE contact_email = '${OFFICE_EMAIL}'`);
}

/**
 * Sign in through the real form and hand back the page.
 *
 * The back office is one page: signing in swaps the login card for the app
 * rather than navigating, so there is no navigation to wait for. What says it
 * worked is the session the page stores under `vesopa_token` — in local
 * storage or session storage depending on the Remember me box.
 */
async function signIn(browser) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#login-form #email', { timeout: 30000 });
  await page.type('#login-form #email', OFFICE_EMAIL);
  await page.type('#login-form #password', PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page
    .waitForFunction(
      () =>
        localStorage.getItem('vesopa_token') ||
        sessionStorage.getItem('vesopa_token'),
      { timeout: 30000 }
    )
    .catch(() => {});
  return page;
}

/** The session the browser is actually holding, wherever it put it. */
const TOKEN_IN_PAGE =
  "localStorage.getItem('vesopa_token') || sessionStorage.getItem('vesopa_token')";

/** Ask the API the way the page does, with the session the browser holds. */
const api = (page, url, options) =>
  page.evaluate(
    async (u, o, tokenExpr) => {
      // eslint-disable-next-line no-eval
      const token = eval(tokenExpr);
      const res = await fetch(u, {
        ...(o || {}),
        headers: { ...((o || {}).headers || {}), Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text.slice(0, 400) };
      }
    },
    url,
    options || null,
    TOKEN_IN_PAGE
  );

// ---------------------------------------------------------------------------

check('a new office can sign in to the live back office', async ({ page }) => {
  const session = await page.evaluate(
    (expr) => eval(expr), // eslint-disable-line no-eval
    TOKEN_IN_PAGE
  );
  assert.ok(session, 'no session was stored — the sign-in did not go through');
});

check('its catalogue is empty, not somebody else’s', async ({ page }) => {
  for (const [name, url] of [
    ['products', '/api/products'],
    ['departments', '/api/departments'],
    ['sub departments', '/api/groups'],
  ]) {
    const res = await api(page, url);
    assert.strictEqual(res.status, 200, `${name} answered ${res.status}`);
    const rows = Array.isArray(res.body) ? res.body : res.body.rows || res.body.data || [];
    assert.strictEqual(
      rows.length,
      0,
      `a brand-new office can see ${rows.length} ${name} belonging to somebody`
    );
  }
});

check('a file with no repeats has nothing to update', async ({ page }) => {
  const file = await workbook([
    ['', 'Cola', 'Drink', '', 2.2],
    ['', 'Lemonade', 'Drink', '', 2.4],
    ['', 'Cheeseburger', 'Food', '', 9.5],
  ]);
  const res = await preview(page, file);
  assert.strictEqual(res.status, 200, `preview answered ${res.status}`);
  assert.strictEqual(res.body.summary.products.created, 3);
  assert.strictEqual(
    res.body.summary.products.updated,
    0,
    'a new office previewing a clean file must have nothing to update'
  );
});

check('and a file that repeats a row says so, and only that', async ({ page }) => {
  const file = await workbook([
    ['', 'Cola', 'Drink', '', 2.2],
    ['', 'Lemonade', 'Drink', '', 2.4],
    // The same product again, the way a venue's own sheet lists it twice.
    ['', 'Cola', 'Drink', '', 2.6],
  ]);
  const res = await preview(page, file);
  assert.strictEqual(res.body.summary.products.created, 2);
  assert.strictEqual(
    res.body.summary.products.updated,
    1,
    'the repeat inside the file is the whole of "to update"'
  );
});

/** Post a workbook to the preview endpoint, as the Import screen does. */
async function preview(page, buffer) {
  const base64 = buffer.toString('base64');
  return page.evaluate(async (b64, tokenExpr) => {
    // eslint-disable-next-line no-eval
    const token = eval(tokenExpr);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'catalogue.xlsx');
    const res = await fetch('/api/import/catalogue/preview', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text.slice(0, 400) };
    }
  }, base64, TOKEN_IN_PAGE);
}

// ---------------------------------------------------------------------------

(async () => {
  let browser;
  let created = false;
  try {
    if (EPHEMERAL) {
      console.log(`Creating ${OFFICE_EMAIL} on the live server\n`);
      await createOffice();
      created = true;
    } else {
      console.log(`Signing in as the standing test office ${OFFICE_EMAIL}\n`);
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await signIn(browser);

    for (const { name, fn } of checks) {
      try {
        await fn({ page, browser });
        passed++;
        console.log(`  ok  ${name}`);
      } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
        process.exitCode = 1;
      }
    }
  } catch (e) {
    console.log(`FAIL  the run itself\n      ${e.stack || e.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Always, including after a failure: a test office left on a live server is
    // somebody else's confusing morning.
    if (created) {
      try {
        removeOffice();
        console.log(`\nRemoved ${OFFICE_EMAIL}`);
      } catch (e) {
        console.log(`\nCOULD NOT REMOVE ${OFFICE_EMAIL} — do it by hand: ${e.message}`);
        process.exitCode = 1;
      }
    }
    console.log(`\n${passed} of ${checks.length} checks passed`);
  }
})();
