/**
 * Scheduled screen changes: src/screen_schedules.js.
 *
 * Against a small in-memory stand-in for the three tables it touches, so the
 * rules are checked without a database: a change is kept whole and lands at its
 * time and not before; it lands once even if two callers race; a cancelled or
 * applied one never lands again; a till's read catches up; the past and the
 * far future are refused; another venue's schedule cannot be touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { screenScheduleRoutes, applyDueSchedules, parseWhen, utcSql, isoFromSql } = require('../src/screen_schedules');

const SECRET = 'test-secret-not-a-real-one';
const OFFICE = 'venue@example.com';
const OTHER = 'other@example.com';

/** Now, as the fake database sees it; tests move it. */
let clock = new Date('2026-10-01T09:00:00Z');
const sqlNow = () => utcSql(clock);

function fakeDb() {
  const db = {
    offices: [{ id: 7, contact_email: OFFICE }, { id: 8, contact_email: OTHER }],
    screens: [
      { id: 1, office: OFFICE, name: 'Drinks', surface: 'sale', grid_rows: 4, grid_cols: 5 },
      { id: 2, office: OTHER, name: 'Theirs', surface: 'sale', grid_rows: 4, grid_cols: 5 },
    ],
    buttons: [],
    schedules: [],
  };
  const one = (sql, params) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    const now = sqlNow();
    if (q.startsWith('SELECT contact_email FROM offices')) return [db.offices.filter((o) => o.id === params[0])];
    if (q.startsWith('SELECT * FROM epos_screens WHERE id = ? AND office = ?')) {
      return [db.screens.filter((s) => String(s.id) === String(params[0]) && s.office === params[1]).map((s) => ({ ...s }))];
    }
    if (q.startsWith('INSERT INTO epos_screen_schedules')) {
      const [id, office, screen_id, note, effective_at, grid_rows, grid_cols, buttons, created_by] = params;
      db.schedules.push({ id, office, screen_id, note, effective_at, grid_rows, grid_cols, buttons, status: 'pending', created_by, created_at: now, applied_at: null, error: null });
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith('SELECT s.*, sc.name AS screen_name')) {
      const join = (s) => {
        const sc = db.screens.find((x) => x.id === Number(s.screen_id) && x.office === s.office);
        return { ...s, screen_name: sc ? sc.name : null, surface: sc ? sc.surface : null };
      };
      if (q.includes('WHERE s.id = ?')) return [db.schedules.filter((s) => s.id === params[0] && s.office === params[1]).map(join)];
      return [db.schedules.filter((s) => s.office === params[0]).map(join)];
    }
    if (q.startsWith("SELECT * FROM epos_screen_schedules WHERE status = 'pending' AND effective_at <= UTC_TIMESTAMP()")) {
      return [db.schedules.filter((s) => s.status === 'pending' && s.effective_at <= now && (!q.includes('AND office = ?') || s.office === params[0]))
        .sort((a, b) => a.effective_at.localeCompare(b.effective_at)).map((s) => ({ ...s }))];
    }
    if (q.startsWith("SELECT * FROM epos_screen_schedules WHERE id = ? AND office = ? AND status = 'pending'")) {
      return [db.schedules.filter((s) => s.id === params[0] && s.office === params[1] && s.status === 'pending').map((s) => ({ ...s }))];
    }
    if (q.startsWith('SELECT error FROM epos_screen_schedules')) return [db.schedules.filter((s) => s.id === params[0])];
    if (q.startsWith("UPDATE epos_screen_schedules SET status = 'applying'")) {
      const s = db.schedules.find((x) => x.id === params[0] && x.status === 'pending');
      if (s) s.status = 'applying';
      return [{ affectedRows: s ? 1 : 0 }];
    }
    if (q.startsWith("UPDATE epos_screen_schedules SET status = 'applied'")) {
      const s = db.schedules.find((x) => x.id === params[0]);
      Object.assign(s, { status: 'applied', applied_at: now, error: null });
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith("UPDATE epos_screen_schedules SET status = 'failed'")) {
      const s = db.schedules.find((x) => x.id === params[1] && (!q.includes("AND status = 'pending'") || x.status === 'pending'));
      if (s) Object.assign(s, { status: 'failed', error: params[0], applied_at: now });
      return [{ affectedRows: s ? 1 : 0 }];
    }
    if (q.startsWith("UPDATE epos_screen_schedules SET status = 'cancelled'")) {
      const s = db.schedules.find((x) => x.id === params[0] && x.office === params[1] && x.status === 'pending');
      if (s) s.status = 'cancelled';
      return [{ affectedRows: s ? 1 : 0 }];
    }
    if (q.startsWith('UPDATE epos_screens SET grid_rows')) {
      const s = db.screens.find((x) => x.id === params[2]);
      Object.assign(s, { grid_rows: params[0], grid_cols: params[1] });
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith('DELETE FROM epos_screen_buttons')) {
      db.buttons = db.buttons.filter((b) => b.screen_id !== params[0]);
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith('INSERT INTO epos_screen_buttons')) {
      db.buttons.push({ screen_id: params[0], office: params[1], grid_row: params[2], grid_col: params[3], kind: params[6], plu_id: params[7], label: params[11] });
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith('SELECT * FROM epos_screen_buttons')) return [db.buttons.filter((b) => b.screen_id === params[0])];
    throw new Error(`fake db: no answer for ${q.slice(0, 90)}`);
  };
  const pool = {
    db,
    query: async (sql, params = []) => [one(sql, params)[0], []],
    execute: async (sql, params = []) => [one(sql, params)[0], []],
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      execute: async (sql, params = []) => [one(sql, params)[0], []],
    }),
  };
  return pool;
}

const token = jwt.sign({ sub: 1, email: 'boss@example.com', name: 'Nicky', role: 'office', officeId: 7 }, SECRET);
const otherToken = jwt.sign({ sub: 2, email: 'x@example.com', role: 'office', officeId: 8 }, SECRET);

async function serve(pool, pushes) {
  const app = express();
  app.use(express.json());
  app.use('/api', screenScheduleRoutes({ pool, broadcast: (m) => pushes.push(m), secret: SECRET, tickMs: 0, now: () => clock }));
  // Stand-ins for the real handlers the catch-up runs ahead of.
  app.get('/api/till/screens', (req, res) => res.json({ served: true }));
  app.get('/api/screens', (req, res) => res.json({ served: true }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const call = async (method, path, body, tok = token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, call };
}

const LAYOUT = [
  { row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'product', pluId: 101, label: 'Autumn Ale' },
  { row: 0, col: 1, rowSpan: 1, colSpan: 1, kind: 'product', pluId: 102, label: 'Mulled Wine' },
];

test('a change is kept whole, and lands at its time and not before', async () => {
  clock = new Date('2026-10-01T09:00:00Z');
  const pool = fakeDb();
  const pushes = [];
  const { server, call } = await serve(pool, pushes);
  try {
    const made = await call('POST', '/screens/1/schedule', { effective_at: '2026-10-05T05:00:00.000Z', note: 'Autumn menu', buttons: LAYOUT, rows: 5, cols: 6 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.status, 'pending');
    assert.equal(made.body.effective_at, '2026-10-05T05:00:00Z');
    assert.equal(made.body.button_count, 2);
    assert.equal(made.body.screen_name, 'Drinks');
    assert.equal(made.body.created_by, 'Nicky');

    // Not yet.
    assert.deepEqual(await applyDueSchedules(pool), []);
    assert.equal(pool.db.buttons.length, 0);

    clock = new Date('2026-10-05T05:00:30Z');
    assert.deepEqual(await applyDueSchedules(pool), [OFFICE]);
    assert.deepEqual(pool.db.buttons.map((b) => b.label), ['Autumn Ale', 'Mulled Wine']);
    const screen = pool.db.screens.find((s) => s.id === 1);
    assert.deepEqual([screen.grid_rows, screen.grid_cols], [5, 6], 'the grid size it was drawn at came with it');
    assert.equal(pool.db.schedules[0].status, 'applied');

    // And never again.
    pool.db.buttons = [];
    assert.deepEqual(await applyDueSchedules(pool), []);
    assert.equal(pool.db.buttons.length, 0);
  } finally {
    server.close();
  }
});

test('two callers racing apply it once', async () => {
  clock = new Date('2026-10-01T09:00:00Z');
  const pool = fakeDb();
  const { server, call } = await serve(pool, []);
  try {
    await call('POST', '/screens/1/schedule', { effective_at: '2026-10-01T10:00:00Z', buttons: LAYOUT });
    clock = new Date('2026-10-01T10:01:00Z');
    let inserts = 0;
    const exec = pool.execute;
    pool.execute = async (sql, params) => {
      if (/INSERT INTO epos_screen_buttons/.test(sql)) inserts += 1;
      return exec(sql, params);
    };
    const conn = pool.getConnection;
    pool.getConnection = async () => {
      const c = await conn();
      const e = c.execute;
      c.execute = async (sql, params) => {
        if (/INSERT INTO epos_screen_buttons/.test(sql)) inserts += 1;
        return e(sql, params);
      };
      return c;
    };
    const [a, b] = await Promise.all([applyDueSchedules(pool), applyDueSchedules(pool)]);
    assert.equal(a.length + b.length, 1);
    assert.equal(inserts, 2, 'the two buttons were written twice');
  } finally {
    server.close();
  }
});

test('a till reading its screens catches up first, and the tills are told', async () => {
  clock = new Date('2026-10-01T09:00:00Z');
  const pool = fakeDb();
  const pushes = [];
  const { server, call } = await serve(pool, pushes);
  try {
    await call('POST', '/screens/1/schedule', { effective_at: '2026-10-01T09:30:00Z', buttons: LAYOUT });
    clock = new Date('2026-10-01T09:30:05Z');
    const read = await call('GET', `/till/screens?office=${encodeURIComponent(OFFICE)}`, null, null);
    assert.equal(read.body.served, true);
    assert.equal(pool.db.buttons.length, 2);
    assert.deepEqual(pushes, [{ type: 'screens', office: OFFICE }]);
  } finally {
    server.close();
  }
});

test('cancel, apply now, and the list', async () => {
  clock = new Date('2026-10-01T09:00:00Z');
  const pool = fakeDb();
  const { server, call } = await serve(pool, []);
  try {
    const a = await call('POST', '/screens/1/schedule', { effective_at: '2026-11-01T00:00:00Z', buttons: LAYOUT });
    const b = await call('POST', '/screens/1/schedule', { effective_at: '2026-10-10T00:00:00Z', buttons: LAYOUT.slice(0, 1) });
    assert.equal((await call('DELETE', `/screens/schedules/${a.body.id}`)).status, 200);
    assert.equal((await call('DELETE', `/screens/schedules/${a.body.id}`)).status, 404, 'cancelled twice');

    const now = await call('POST', `/screens/schedules/${b.body.id}/apply`);
    assert.equal(now.status, 200, JSON.stringify(now.body));
    assert.deepEqual(pool.db.buttons.map((x) => x.label), ['Autumn Ale']);

    clock = new Date('2026-11-02T00:00:00Z');
    assert.deepEqual(await applyDueSchedules(pool), [], 'a cancelled change landed');

    const list = await call('GET', '/screens/schedules');
    assert.deepEqual(list.body.map((x) => x.status).sort(), ['applied', 'cancelled']);
  } finally {
    server.close();
  }
});

test('the past, the far future and a missing layout are refused', async () => {
  clock = new Date('2026-10-01T09:00:00Z');
  const pool = fakeDb();
  const { server, call } = await serve(pool, []);
  try {
    const past = await call('POST', '/screens/1/schedule', { effective_at: '2026-09-30T09:00:00Z', buttons: LAYOUT });
    assert.equal(past.status, 400);
    const far = await call('POST', '/screens/1/schedule', { effective_at: '2028-01-01T00:00:00Z', buttons: LAYOUT });
    assert.equal(far.status, 400);
    const none = await call('POST', '/screens/1/schedule', { effective_at: '2026-10-02T00:00:00Z' });
    assert.equal(none.status, 400);
    assert.equal(pool.db.schedules.length, 0);
  } finally {
    server.close();
  }
});

test('another venue can neither schedule on a screen nor cancel a change', async () => {
  clock = new Date('2026-10-01T09:00:00Z');
  const pool = fakeDb();
  const { server, call } = await serve(pool, []);
  try {
    assert.equal((await call('POST', '/screens/1/schedule', { effective_at: '2026-10-02T00:00:00Z', buttons: LAYOUT }, otherToken)).status, 404);
    const mine = await call('POST', '/screens/1/schedule', { effective_at: '2026-10-02T00:00:00Z', buttons: LAYOUT });
    assert.equal((await call('DELETE', `/screens/schedules/${mine.body.id}`, null, otherToken)).status, 404);
    assert.equal((await call('POST', `/screens/schedules/${mine.body.id}/apply`, null, otherToken)).status, 404);
    assert.equal((await call('GET', '/screens/schedules', null, otherToken)).body.length, 0);
    assert.equal(pool.db.schedules[0].status, 'pending');
  } finally {
    server.close();
  }
});

test('a screen deleted before its change is due marks the change failed', async () => {
  clock = new Date('2026-10-01T09:00:00Z');
  const pool = fakeDb();
  const { server, call } = await serve(pool, []);
  try {
    await call('POST', '/screens/1/schedule', { effective_at: '2026-10-01T10:00:00Z', buttons: LAYOUT });
    pool.db.screens = pool.db.screens.filter((s) => s.id !== 1);
    clock = new Date('2026-10-01T11:00:00Z');
    assert.deepEqual(await applyDueSchedules(pool), []);
    assert.equal(pool.db.schedules[0].status, 'failed');
    assert.match(pool.db.schedules[0].error, /deleted/);
  } finally {
    server.close();
  }
});

test('a database not yet migrated is nothing to do, not an error', async () => {
  const pool = { query: async () => { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; } };
  assert.deepEqual(await applyDueSchedules(pool), []);
});

test('times: parse, store and read back in UTC', () => {
  const now = new Date('2026-10-01T09:00:00Z');
  assert.ok(parseWhen('2026-10-01T08:59:30Z', now).when, 'a slow click inside the minute is allowed');
  assert.ok(parseWhen('2026-10-01T08:58:00Z', now).error);
  assert.ok(parseWhen('not a date', now).error);
  assert.equal(utcSql(new Date('2026-10-05T05:00:00Z')), '2026-10-05 05:00:00');
  assert.equal(isoFromSql('2026-10-05 05:00:00'), '2026-10-05T05:00:00Z');
  assert.equal(isoFromSql(new Date(2026, 9, 5, 5, 0, 0)), '2026-10-05T05:00:00Z');
  assert.equal(isoFromSql(null), null);
});
