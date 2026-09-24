/**
 * The two permission screens, in a real browser against the real server.
 *
 * `permissions.test.js` proves the routes refuse what they should. That is the
 * half that matters for security and it cannot see the half that matters for
 * the customer: whether a manager can actually open the screen, tick the boxes,
 * assign a role, and find the menu shorter afterwards.
 *
 * So this boots src/server.js against a scratch database, signs in through the
 * real login form, and drives the pages with Chrome. No stubs — a stubbed API
 * would have happily passed while the real one answered 500, which is the only
 * failure worth catching at this level.
 *
 * NOT PART OF `npm test`
 *
 * It needs a database and a Chromium. Run it directly:
 *
 *     DB_NAME=vesopa_tenancy_test DB_USER=root DB_PASSWORD=... \
 *       node test/permissions.browser.js
 *
 * It creates one office and one login under an address nobody trades under, and
 * deletes both on the way out.
 */

const assert = require('assert');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const path = require('path');
const { spawn } = require('child_process');

const OFFICE = 'perm-browser@vesopa.invalid';
const LOGIN = 'manager+perm-browser@vesopa.invalid';
const PASSWORD = 'test-password-1234';
const PORT = 4671;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ---------------------------------------------------------------------------
// A venue to sign into
// ---------------------------------------------------------------------------

async function nextId(pool, table) {
  const [[row]] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${table}`);
  return row.id;
}

async function seed(pool) {
  await wipe(pool);
  await pool.query(
    `INSERT INTO offices (name, contact_email, status) VALUES (?, ?, 'active')`,
    ['Permissions Test Venue', OFFICE]
  );
  const [[office]] = await pool.query(
    'SELECT id FROM offices WHERE contact_email = ?',
    [OFFICE]
  );
  await pool.query(
    `INSERT INTO backoffice_users (id, email, password, name, approved, office_id, role)
     VALUES (?, ?, ?, 'Permissions Manager', 'Y', ?, 'office')`,
    [await nextId(pool, 'backoffice_users'), LOGIN, await bcrypt.hash(PASSWORD, 10), office.id]
  );
  // Somebody to give a permission group to.
  await pool.query(
    `INSERT INTO bo_clarks (id, email, pluid, clark_name, pin_code, active)
     VALUES (?, ?, 1, 'Test Clerk', '4321', 1)`,
    [await nextId(pool, 'bo_clarks'), OFFICE]
  );
}

async function wipe(pool) {
  for (const [table, column] of [
    ['epos_permission_groups', 'email'],
    ['bo_user_roles', 'email'],
    ['bo_clarks', 'email'],
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE ${column} = ?`, [OFFICE]).catch(() => {});
  }
  await pool.query('DELETE FROM backoffice_users WHERE email = ?', [LOGIN]);
  await pool.query('DELETE FROM offices WHERE contact_email = ?', [OFFICE]);
}

// ---------------------------------------------------------------------------
// The server, as it really runs
// ---------------------------------------------------------------------------

function bootServer() {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'src', 'server.js')],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        JWT_SECRET: 'permissions-browser-secret',
        DB_HOST: process.env.DB_HOST || '127.0.0.1',
        DB_NAME: process.env.DB_NAME || 'vesopa_tenancy_test',
        DB_USER: process.env.DB_USER || 'root',
        DB_PASSWORD: process.env.DB_PASSWORD || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  return { child, log };
}

async function waitForServer(log) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`).catch(() => null);
      if (res) return;
      // No /api/health? The page itself will do.
      const page = await fetch(BASE).catch(() => null);
      if (page && page.status < 500) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server never came up:\n${log.join('')}`);
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

async function main() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.log('permissions.browser: no puppeteer installed — skipped');
    return;
  }

  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_tenancy_test',
    connectionLimit: 4,
  });

  await seed(pool);

  const { child, log } = bootServer();
  let browser;
  try {
    await waitForServer(log);
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 950 });

    // A page error is a failed test, not a line in a log nobody reads.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });

    const signIn = async () => {
      await page.goto(BASE, { waitUntil: 'networkidle2' });
      await page.type('#email', LOGIN);
      await page.type('#password', PASSWORD);
      await Promise.all([
        page.click('#login-form button[type="submit"]'),
        page.waitForSelector('#app:not([hidden])', { timeout: 15000 }),
      ]);
    };

    /**
     * Open a section the way a person does: expand its group in the rail, then
     * click the item.
     *
     * People, Programming and Administration start folded — see initNavGroups —
     * so clicking straight at the button finds a hidden element. Driving the
     * heading first is both what actually happens and a check that the fold
     * still reveals what it should.
     */
    const openView = async (view) => {
      await page.evaluate((v) => {
        const btn = document.querySelector(`.nav[data-view="${v}"]`);
        if (!btn) throw new Error(`no nav button for ${v}`);
        let el = btn.previousElementSibling;
        while (el && !el.classList.contains('nav-group')) el = el.previousElementSibling;
        if (el && el.classList.contains('collapsed')) el.click();
      }, view);
      await page.waitForSelector(`.nav[data-view="${view}"]:not(.hidden-by-group)`, {
        timeout: 10000,
      });
      await page.click(`.nav[data-view="${view}"]`);
      await page.waitForSelector(`#view-${view}:not([hidden])`, { timeout: 10000 });
    };

    // ---- The screens open at all ----------------------------------------

    check('a manager can sign in and open Staff Permissions', async () => {
      await signIn();
      await openView('permission_groups');
      const text = await page.$eval('#permission-groups', (el) => el.textContent);
      assert.match(text, /No permission groups yet/);
    });

    check('the three standard groups can be created in one press', async () => {
      await page.click('#seed-groups');
      // Waiting for a row, not for the word "Manager": the empty state's own
      // button says "Add Staff, Supervisor and Manager", so a text match is
      // satisfied by the thing it is supposed to be waiting to replace.
      await page.waitForSelector('#permission-groups [data-edit-group]', { timeout: 10000 });
      const names = await page.$$eval('#permission-groups tr td:first-child', (tds) =>
        tds.map((t) => t.textContent.trim())
      );
      assert.deepStrictEqual(names.sort(), ['Manager', 'Staff', 'Supervisor']);
    });

    check('a group opens with its switches in the state it was saved in', async () => {
      // Manager holds everything; Staff holds nothing. If the editor drew a
      // group's switches from anywhere but the group, this is where it shows.
      const rowFor = async (name) =>
        page.evaluate((n) => {
          const row = [...document.querySelectorAll('#permission-groups tr')].find((tr) =>
            tr.querySelector('td')?.textContent.trim() === n
          );
          return row?.querySelector('[data-edit-group]')?.dataset.editGroup || null;
        }, name);

      for (const [name, expected] of [['Manager', true], ['Staff', false]]) {
        const id = await rowFor(name);
        assert.ok(id, `no ${name} row`);
        await page.click(`[data-edit-group="${id}"]`);
        await page.waitForSelector('#perm-form', { timeout: 10000 });

        const refund = await page.$eval('input[name="can_refund"]', (i) => i.checked);
        assert.strictEqual(refund, expected, `${name}'s can_refund was ${refund}`);

        await page.click('#perm-cancel');
        await page.waitForFunction(() => !document.querySelector('#perm-form'));
      }
    });

    check('toggle all fills a category, and saving keeps it', async () => {
      const id = await page.evaluate(() => {
        const row = [...document.querySelectorAll('#permission-groups tr')].find(
          (tr) => tr.querySelector('td')?.textContent.trim() === 'Staff'
        );
        return row?.querySelector('[data-edit-group]')?.dataset.editGroup;
      });
      await page.click(`[data-edit-group="${id}"]`);
      await page.waitForSelector('#perm-form');

      await page.click('input[data-toggle-all="till"]');
      const allOn = await page.$$eval('input[data-group="till"]', (i) => i.every((x) => x.checked));
      assert.ok(allOn, 'toggle all did not tick the category');

      await page.click('#perm-form button[type="submit"]');
      await page.waitForFunction(() => !document.querySelector('#perm-form'), { timeout: 10000 });

      // Read it back from the server, not from the table it just drew.
      await page.reload({ waitUntil: 'networkidle2' });
      await openView('permission_groups');
      // `show()` reveals the section and *then* renders it, so a click found
      // between the two lands on a row the re-render is about to replace —
      // "Node is detached from document". Wait for the row this needs.
      await page.waitForSelector(`[data-edit-group="${id}"]`, { timeout: 10000 });
      await page.click(`[data-edit-group="${id}"]`);
      await page.waitForSelector('#perm-form');
      const stillOn = await page.$eval('input[name="can_refund"]', (i) => i.checked);
      assert.ok(stillOn, 'the save did not survive a reload');
      await page.click('#perm-cancel');
    });

    // ---- Back office roles ----------------------------------------------

    check('the standard roles can be created, and the accountant is narrow', async () => {
      await openView('user_roles');
      await page.waitForSelector('#seed-roles', { timeout: 10000 });
      await page.click('#seed-roles');
      // A row, not the word — see above. "Add Owner, Manager, Accountant and
      // Staff" is the button being waited on.
      await page.waitForSelector('#user-roles [data-edit-role]', { timeout: 10000 });

      const rows = await page.$$eval('#user-roles tr', (trs) =>
        trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
      );
      const accountant = rows.find((r) => r[0] === 'Accountant');
      const owner = rows.find((r) => r[0] === 'Owner');
      assert.ok(accountant, 'no Accountant role');
      // "13 of 50" — the accountant must hold fewer keys than the owner.
      const count = (cell) => Number(cell.split(' of ')[0]);
      assert.ok(
        count(accountant[2]) < count(owner[2]),
        `accountant ${accountant[2]} vs owner ${owner[2]}`
      );
    });

    // ---- Assigning, and the menu obeying --------------------------------

    check('a clerk can be put in a group, and the list says so', async () => {
      await openView('staff');
      await page.waitForSelector('[data-edit-staff]', { timeout: 10000 });
      await page.waitForNetworkIdle({ idleTime: 300 }).catch(() => {});
      await page.click('[data-edit-staff]');
      await page.waitForSelector('#modal-form', { timeout: 10000 });

      await page.select('select[name="permission_group_id"]', await page.evaluate(() => {
        const opt = [...document.querySelectorAll('select[name="permission_group_id"] option')]
          .find((o) => o.textContent.trim() === 'Supervisor');
        return opt?.value;
      }));
      await page.click('#modal-form button[type="submit"]');
      await page.waitForFunction(
        () => document.querySelector('#staff')?.textContent.includes('Supervisor'),
        { timeout: 10000 }
      );
    });

    check('an accountant signs in to a shorter menu', async () => {
      // The whole point of the feature, checked the way the customer described
      // it: give the login the Accountant role, and see the reporting and
      // nothing else.
      const [[role]] = await pool.query(
        'SELECT id FROM bo_user_roles WHERE email = ? AND display_name = ?',
        [OFFICE, 'Accountant']
      );
      assert.ok(role, 'the Accountant role was not created');
      await pool.query('UPDATE backoffice_users SET role_id = ? WHERE email = ?', [
        role.id,
        LOGIN,
      ]);

      await page.evaluate(() => localStorage.clear());
      await signIn();

      const visible = await page.$$eval('.nav[data-view]', (btns) =>
        btns.filter((b) => !b.hidden).map((b) => b.dataset.view)
      );
      assert.ok(visible.includes('till_report'), 'an accountant cannot see the Till Report');
      assert.ok(visible.includes('run_report'), 'an accountant cannot see the Financial Summary');
      for (const hidden of ['products', 'staff', 'users', 'user_roles', 'permission_groups']) {
        assert.ok(!visible.includes(hidden), `an accountant can still see ${hidden}`);
      }

      const badge = await page.$eval('#role-badge', (el) => el.textContent);
      assert.match(badge, /Accountant/);
    });

    /** Errors the tests below cause on purpose, and must not be failed for. */
    const EXPECTED_ERRORS = [];

    check('and the server refuses even if the menu is put back', async () => {
      // The hiding is a courtesy. This is the enforcement, asked for directly
      // from the page the accountant is sitting on.
      const status = await page.evaluate(async () => {
        const res = await fetch('/api/user-roles', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('vesopa_token') || window.token || ''}`,
          },
          body: JSON.stringify({ display_name: 'Sneaky', permissions: [] }),
        });
        return res.status;
      });
      assert.strictEqual(status, 403, `the server answered ${status}`);
      // The browser logs the refusal to the console. That is the check above
      // succeeding, not a fault, so the sweep below is told to expect it.
      EXPECTED_ERRORS.push(/403 \(Forbidden\)/);
    });

    check('nothing threw in the browser along the way', () => {
      // A page that works while shouting into the console is one bug away from
      // not working, and these two screens are all client-side rendering.
      const real = pageErrors.filter(
        (e) => !/favicon|net::ERR_/i.test(e) && !EXPECTED_ERRORS.some((r) => r.test(e))
      );
      assert.deepStrictEqual(real, [], `browser errors:\n      ${real.join('\n      ')}`);
    });

    // ---- Run ------------------------------------------------------------

    console.log('Permissions in a browser: the screens, the roles, the menu\n');
    for (const { name, fn } of checks) {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
        process.exitCode = 1;
      }
    }
    console.log(`\npermissions browser: ${passed}/${checks.length} checks passed`);
  } finally {
    if (browser) await browser.close();
    child.kill();
    await wipe(pool).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
