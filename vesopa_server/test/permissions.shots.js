/**
 * Screenshots of the two permission screens, for review.
 *
 * Not a test — it asserts nothing. It boots the real server against a scratch
 * database, seeds the standard roles and groups, and photographs each screen so
 * the layout can be looked at without anybody installing anything.
 *
 *     DB_NAME=vesopa_tenancy_test DB_USER=root DB_PASSWORD=... \
 *       node test/permissions.shots.js [outputDir]
 */

const bcrypt = require('bcryptjs');
const fs = require('fs');
const mysql = require('mysql2/promise');
const path = require('path');
const { spawn } = require('child_process');

const OFFICE = 'perm-shots@vesopa.invalid';
const LOGIN = 'manager+perm-shots@vesopa.invalid';
const PASSWORD = 'test-password-1234';
const PORT = 4673;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] || path.join(__dirname, '..', 'shots');

async function nextId(pool, table) {
  const [[row]] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${table}`);
  return row.id;
}

async function wipe(pool) {
  for (const t of ['epos_permission_groups', 'bo_user_roles', 'bo_clarks']) {
    await pool.query(`DELETE FROM ${t} WHERE email = ?`, [OFFICE]).catch(() => {});
  }
  await pool.query('DELETE FROM backoffice_users WHERE email = ?', [LOGIN]);
  await pool.query('DELETE FROM offices WHERE contact_email = ?', [OFFICE]);
}

async function seed(pool) {
  await wipe(pool);
  await pool.query(
    `INSERT INTO offices (name, contact_email, status) VALUES (?, ?, 'active')`,
    ['The Bridge Llangennech', OFFICE]
  );
  const [[office]] = await pool.query(
    'SELECT id FROM offices WHERE contact_email = ?', [OFFICE]
  );
  await pool.query(
    `INSERT INTO backoffice_users (id, email, password, name, approved, office_id, role)
     VALUES (?, ?, ?, 'Nicki', 'Y', ?, 'office')`,
    [await nextId(pool, 'backoffice_users'), LOGIN, await bcrypt.hash(PASSWORD, 10), office.id]
  );
  for (const [pin, name] of [['4321', 'Alex Morgan'], ['1122', 'Sam Reilly'], ['3344', 'Jo Patel']]) {
    await pool.query(
      `INSERT INTO bo_clarks (id, email, pluid, clark_name, pin_code, active)
       VALUES (?, ?, 1, ?, ?, 1)`,
      [await nextId(pool, 'bo_clarks'), OFFICE, name, pin]
    );
  }
}

async function main() {
  const puppeteer = require('puppeteer');
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_tenancy_test',
    connectionLimit: 4,
  });
  await seed(pool);
  fs.mkdirSync(OUT, { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'permissions-shots-secret',
      DB_HOST: process.env.DB_HOST || '127.0.0.1',
      DB_NAME: process.env.DB_NAME || 'vesopa_tenancy_test',
      DB_USER: process.env.DB_USER || 'root',
      DB_PASSWORD: process.env.DB_PASSWORD || '',
    },
    stdio: 'ignore',
  });

  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(BASE).catch(() => null);
      if (res && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 2 });

    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.type('#email', LOGIN);
    await page.type('#password', PASSWORD);
    await Promise.all([
      page.click('#login-form button[type="submit"]'),
      page.waitForSelector('#app:not([hidden])'),
    ]);

    const openView = async (view) => {
      await page.evaluate((v) => {
        const btn = document.querySelector(`.nav[data-view="${v}"]`);
        let el = btn.previousElementSibling;
        while (el && !el.classList.contains('nav-group')) el = el.previousElementSibling;
        if (el?.classList.contains('collapsed')) el.click();
      }, view);
      await page.click(`.nav[data-view="${view}"]`);
      await page.waitForSelector(`#view-${view}:not([hidden])`);
      await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});
    };

    const shot = async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    };

    // Empty states first — this is what a venue sees on day one.
    await openView('permission_groups');
    await shot('01-staff-permissions-empty');
    await page.click('#seed-groups');
    await page.waitForSelector('#permission-groups [data-edit-group]');
    await shot('02-staff-permissions-seeded');

    // The editor, with its eleven switches and their explanations.
    const gid = await page.evaluate(
      () => document.querySelector('[data-edit-group]').dataset.editGroup
    );
    await page.click(`[data-edit-group="${gid}"]`);
    await page.waitForSelector('#perm-form');
    await shot('03-staff-permission-editor');
    await page.click('#perm-cancel');

    await openView('user_roles');
    await shot('04-user-roles-empty');
    await page.click('#seed-roles');
    await page.waitForSelector('#user-roles [data-edit-role]');
    await shot('05-user-roles-seeded');

    // The Accountant's own switches: the customer's example, on screen.
    const rid = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#user-roles tr')].find(
        (tr) => tr.querySelector('td')?.textContent.trim() === 'Accountant'
      );
      return row?.querySelector('[data-edit-role]')?.dataset.editRole;
    });
    await page.click(`[data-edit-role="${rid}"]`);
    await page.waitForSelector('#perm-form');
    await shot('06-role-editor-accountant');
    await page.evaluate(() => {
      document.querySelector('.perm-modal').scrollTop = 700;
    });
    await shot('07-role-editor-scrolled');
    await page.click('#perm-cancel');

    // Staff, showing the Permissions column.
    await openView('staff');
    await shot('08-staff-list');

    // And the menu an accountant actually gets.
    const [[role]] = await pool.query(
      'SELECT id FROM bo_user_roles WHERE email = ? AND display_name = ?',
      [OFFICE, 'Accountant']
    );
    await pool.query('UPDATE backoffice_users SET role_id = ? WHERE email = ?', [role.id, LOGIN]);
    await page.evaluate(() => localStorage.clear());
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.type('#email', LOGIN);
    await page.type('#password', PASSWORD);
    await Promise.all([
      page.click('#login-form button[type="submit"]'),
      page.waitForSelector('#app:not([hidden])'),
    ]);
    await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
    await shot('09-accountant-menu');
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
