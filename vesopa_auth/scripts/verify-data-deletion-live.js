#!/usr/bin/env node
/**
 * Account and data deletion, end to end, on live.
 *
 *   cd <auth app> && node scripts/verify-data-deletion-live.js
 *
 * Runs ON the cloud box as root (it reads the back office's database with the
 * mariadb client to check what was erased).
 *
 * IT ONLY EVER TOUCHES THE TEST VENUE'S DEMONSTRATION MEMBERS: customers of
 * manager@vesopa.co.uk tagged notes = 'demo-seed' with an @example.com address,
 * made by vesopa_server/tool/seed-demo-loyalty.js. Three of them are used:
 *
 *   reviewed   asked for "as soon as possible", approved by the administrator
 *   scheduled  7 days, brought due, run by the timer's own function
 *   cancelled  15 days, cancelled with the emailed token
 *
 * Emails go to their @example.com addresses (nowhere) and to the notification
 * address, and are real.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execFileSync } = require('child_process');
const db = require('../src/db');
const deletion = require('../src/deletion');

const BACKOFFICE_DB = process.env.VERIFY_BACKOFFICE_DB || 'vesopasoftware_eposdb';
let passed = 0;
const failures = [];

function bo(sql) {
  return execFileSync('mariadb', ['-N', '-B', BACKOFFICE_DB, '-e', sql], { encoding: 'utf8' }).trim();
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function main() {
  const demo = bo(
    "SELECT email FROM epos_customers WHERE email_key = 'manager@vesopa.co.uk' AND notes = 'demo-seed' " +
      "AND email LIKE '%@example.com' ORDER BY created_at DESC LIMIT 3",
  ).split('\n').filter(Boolean);
  assert(demo.length === 3, 'fewer than three demonstration members to test with');
  const [reviewed, scheduled, cancelled] = demo;
  const admin = await db.one('SELECT id FROM users WHERE is_staff = 1 ORDER BY id LIMIT 1');

  let found;
  await check('lookup finds the demo membership at The Vesopa Kitchen', async () => {
    found = await deletion.discover(reviewed);
    assert(!found.problems.length, `provider problems: ${found.problems.join(', ')}`);
    const kitchen = found.items.find((i) => i.kind === 'app_data' && i.venue === 'vesopa-test');
    assert(kitchen, `no Kitchen membership in ${JSON.stringify(found.items)}`);
  });

  await check('an unproved address finds nothing it should not (nobody@example.invalid)', async () => {
    const none = await deletion.discover('nobody@example.invalid');
    assert(!none.items.length, 'items found for an address with no membership');
  });

  await check('the page names the venue app', async () => {
    const d = await deletion.describe({ app: 'vesopa-loyalty', venue: 'vesopa-test' });
    assert(d && d.label === 'The Vesopa Kitchen', `label ${d && d.label}`);
  });

  await check('reviewed: waits, then the administrator approves and it is erased', async () => {
    const items = found.items.filter((i) => i.kind === 'app_data');
    const { request } = await deletion.create({ email: reviewed, mode: 'review', items, ip: '127.0.0.1', userAgent: 'verify' });
    assert(request.status === 'awaiting_review', `status ${request.status}`);
    const again = await deletion.create({ email: reviewed, mode: 'review', items, ip: '127.0.0.1', userAgent: 'verify' });
    assert(again.existing && again.request.public_id === request.public_id, 'a second request was made');
    const result = await deletion.approve(request, admin.id, 'verify-data-deletion-live');
    assert(result.ok, 'approval did not finish');
    const after = await deletion.getByPublicId(request.public_id);
    assert(after.status === 'completed', `status ${after.status}`);
    assert(after.email.includes('••••'), 'address not masked after completion');
    const row = bo(`SELECT CONCAT_WS('|', name, IFNULL(email,'-'), IFNULL(card_number,'-'), IFNULL(photo_url,'-')) FROM epos_customers WHERE id = '${items[0].reference}'`);
    assert(row === 'Deleted member|-|-|-', `customer row is ${row}`);
    const sessions = bo(`SELECT COUNT(*) FROM epos_loyalty_app_sessions WHERE customer_id = '${items[0].reference}'`);
    assert(sessions === '0', `${sessions} sessions left`);
  });

  await check('scheduled: runs by itself once due', async () => {
    const f = await deletion.discover(scheduled);
    const items = f.items.filter((i) => i.kind === 'app_data');
    const { request } = await deletion.create({ email: scheduled, mode: 'scheduled', delayDays: 7, items, ip: '127.0.0.1', userAgent: 'verify' });
    assert(request.status === 'scheduled' && request.delay_days === 7, `status ${request.status} days ${request.delay_days}`);
    const days = Math.round((new Date(request.due_at) - Date.now()) / 86400000);
    assert(days === 7, `due in ${days} days`);
    await db.execute('UPDATE deletion_requests SET due_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [request.id]);
    await deletion.runDue();
    const after = await deletion.getByPublicId(request.public_id);
    assert(after.status === 'completed', `status ${after.status}`);
  });

  await check('cancelled: the emailed token cancels, and nothing is erased', async () => {
    const f = await deletion.discover(cancelled);
    const items = f.items.filter((i) => i.kind === 'app_data');
    const { request, token } = await deletion.create({ email: cancelled, mode: 'scheduled', delayDays: 15, items, ip: '127.0.0.1', userAgent: 'verify' });
    assert(deletion.tokenMatches(request, token), 'token does not match');
    assert(!deletion.tokenMatches(request, `${token}x`), 'a wrong token matched');
    assert(await deletion.cancel(request), 'cancel refused');
    const after = await deletion.getByPublicId(request.public_id);
    assert(after.status === 'cancelled', `status ${after.status}`);
    const row = bo(`SELECT email FROM epos_customers WHERE id = '${items[0].reference}'`);
    assert(row === cancelled, 'the cancelled member was erased');
  });

  console.log(`\nverify-data-deletion-live: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.close());
