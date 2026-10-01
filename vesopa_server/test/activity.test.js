/**
 * The activity log's routes (src/activity.js), against a fake pool.
 *
 *   - an app's events land against the venue on its token, never the body's;
 *   - a venue reads only its own rows, the Vesopa admin any venue;
 *   - a till may forward for its customer display, nobody else may claim it;
 *   - no token, no write.
 */
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { activityRoutes, skipActivity } = require('../src/activity');

const SECRET = 'test-secret';
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const queries = [];
const pool = {
  async query(sql, args) {
    queries.push({ sql, args });
    if (/FROM offices/.test(sql)) return [[{ contact_email: 'venue@one.test' }]];
    if (/bo_user_roles/.test(sql)) return [[]];
    if (/FROM epos_activity_log/.test(sql)) return [[{ id: 1, action: 'tap' }]];
    return [[]];
  },
  async execute() { return [{}]; },
};
const recorded = [];
const log = { record: (e) => recorded.push(e) };

const app = express();
app.use(express.json());
const { router, identify } = activityRoutes({ pool, secret: SECRET, log });
app.use(router);

const till = jwt.sign({ scope: 'terminal', office: 'venue@one.test', officeId: 1 }, SECRET);
const kitchen = jwt.sign({ scope: 'kitchen', office: 'venue@one.test' }, SECRET);
const loyalty = jwt.sign({ scope: 'loyalty', office: 'venue@one.test', cid: 42, jti: 's1' }, SECRET);
const manager = jwt.sign({ sub: 5, email: 'boss@one.test', role: 'user', officeId: 1 }, SECRET);
const admin = jwt.sign({ sub: 1, email: 'admin@vesopa.test', role: 'admin' }, SECRET);

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (token, body) => fetch(`${base}/activity/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const get = (token, qs = '') => fetch(`${base}/api/activity${qs}`, { headers: { Authorization: `Bearer ${token}` } });

  console.log('Activity log');

  await check('a till\'s events land against the venue on its token', async () => {
    recorded.length = 0;
    const res = await post(till, {
      app_version: '1.9.1.0', device_id: 'T1', device_name: 'Till 1', office: 'other@venue.test',
      events: [{ action: 'tap', target: 'Cash', actor: 'Sam' }, { action: 'screen', target: 'Payment' }],
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).accepted, 2);
    assert.strictEqual(recorded[0].office, 'venue@one.test');
    assert.strictEqual(recorded[0].app, 'epos');
    assert.strictEqual(recorded[0].actor, 'Sam');
    assert.strictEqual(recorded[0].deviceName, 'Till 1');
  });

  await check('a till may forward for its customer display', async () => {
    recorded.length = 0;
    await post(till, { app: 'display', events: [{ action: 'start' }] });
    assert.strictEqual(recorded[0].app, 'display');
  });

  await check('a kitchen screen cannot claim to be something else', async () => {
    recorded.length = 0;
    await post(kitchen, { app: 'display', events: [{ action: 'tap', target: 'Bump' }] });
    assert.strictEqual(recorded[0].app, 'kitchen');
  });

  await check('a loyalty customer is recorded by customer id, and a white-label brand is kept', async () => {
    recorded.length = 0;
    await post(loyalty, { app: 'metric', events: [{ action: 'tap', target: 'My card', customer_id: '999' }] });
    assert.strictEqual(recorded[0].customerId, '42');
    assert.strictEqual(recorded[0].app, 'metric');
    assert.strictEqual(recorded[0].actorType, 'customer');
  });

  await check('no token, no write', async () => {
    recorded.length = 0;
    const res = await post(null, { events: [{ action: 'tap' }] });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(recorded.length, 0);
  });

  await check('a batch is capped at 200', async () => {
    recorded.length = 0;
    await post(till, { events: Array.from({ length: 500 }, () => ({ action: 'tap' })) });
    assert.strictEqual(recorded.length, 200);
  });

  await check('a venue reads only its own rows, whatever it asks for', async () => {
    queries.length = 0;
    const res = await get(manager, '?office=someone@else.test&app=epos');
    assert.strictEqual(res.status, 200);
    const q = queries.find((x) => /FROM epos_activity_log/.test(x.sql));
    assert.match(q.sql, /office = \?/);
    assert.strictEqual(q.args[0], 'venue@one.test');
    assert.ok(!q.args.includes('someone@else.test'));
  });

  await check('the admin reads every venue, or the one asked for', async () => {
    queries.length = 0;
    await get(admin);
    let q = queries.find((x) => /FROM epos_activity_log/.test(x.sql));
    assert.doesNotMatch(q.sql, /office = \?/);
    queries.length = 0;
    await get(admin, '?office=Venue@Two.test');
    q = queries.find((x) => /FROM epos_activity_log/.test(x.sql));
    assert.strictEqual(q.args[0], 'venue@two.test');
  });

  await check('live mode asks only for rows newer than the one it has', async () => {
    queries.length = 0;
    await get(manager, '?after_id=40');
    const q = queries.find((x) => /FROM epos_activity_log/.test(x.sql));
    assert.match(q.sql, /id > \?/);
    assert.ok(q.args.includes(40));
  });

  await check('the summary counts the venue\'s own rows, ignoring paging', async () => {
    queries.length = 0;
    const res = await fetch(`${base}/api/activity/summary?office=someone@else.test&before_id=9&after_id=3&errors=1`, {
      headers: { Authorization: `Bearer ${manager}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.byHour.length, 24);
    const qs = queries.filter((x) => /FROM epos_activity_log/.test(x.sql));
    assert.strictEqual(qs.length, 4);
    for (const q of qs) {
      assert.strictEqual(q.args[0], 'venue@one.test');
      assert.ok(!q.args.includes('someone@else.test'));
      assert.doesNotMatch(q.sql, /id [<>] \?/);
      assert.match(q.sql, /status >= 400/);
    }
  });

  await check('a device token cannot read the summary', async () => {
    const res = await fetch(`${base}/api/activity/summary`, { headers: { Authorization: `Bearer ${till}` } });
    assert.strictEqual(res.status, 401);
  });

  await check('a device token cannot read the log', async () => {
    const res = await get(till);
    assert.strictEqual(res.status, 401);
  });

  await check('identify names a back-office user and their venue', async () => {
    const who = await identify({ headers: { authorization: `Bearer ${manager}` }, body: {} });
    assert.strictEqual(who.app, 'backoffice');
    assert.strictEqual(who.actor, 'boss@one.test');
    assert.strictEqual(who.office, 'venue@one.test');
  });

  await check('heartbeats and the log itself are skipped', async () => {
    assert.ok(skipActivity({ method: 'POST', originalUrl: '/till/devices' }));
    assert.ok(skipActivity({ method: 'POST', originalUrl: '/activity/v1/events' }));
    assert.ok(!skipActivity({ method: 'POST', originalUrl: '/api/products' }));
  });

  server.close();
  console.log(`\nactivity: ${passed} checks passed`);
})();
