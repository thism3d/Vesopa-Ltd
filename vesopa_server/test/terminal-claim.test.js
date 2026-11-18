/**
 * Which terminal a till is (src/terminal_licences.js, store.claim).
 *
 * Nicky, 2026-11-18: a till that replaces a broken one must report under the
 * terminal it replaces, not appear as a new terminal named after its PC.
 */
'use strict';

const assert = require('assert');
const { terminalStore } = require('../src/terminal_licences');
const tillSeats = require('../src/till_seats');

/** Just enough of MySQL for bo_terminals. */
function fakePool() {
  const rows = [];
  const settings = [];
  let nextId = 1;
  const released = [];
  const q = async (sql, args = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return [[]];
    if (s.startsWith('SELECT * FROM bo_terminals WHERE office = ? AND kind = ? AND device_id = ? AND revoked_at IS NULL')) {
      const [o, k, d] = args;
      return [rows.filter((r) => r.office === o && r.kind === k && r.device_id === d && !r.revoked_at)];
    }
    if (s.startsWith('SELECT * FROM bo_terminals WHERE office = ? AND device_id = ? AND kind = ? AND revoked_at IS NULL')) {
      const [o, d, k] = args;
      return [rows.filter((r) => r.office === o && r.kind === k && r.device_id === d && !r.revoked_at)];
    }
    if (s.startsWith('SELECT * FROM bo_terminals WHERE office = ? AND device_id = ? AND kind = ?')) {
      const [o, d, k] = args;
      return [rows.filter((r) => r.office === o && r.kind === k && r.device_id === d)];
    }
    if (s.startsWith('SELECT * FROM bo_terminals WHERE office = ? AND kind = ? AND terminal_no = ?')) {
      const [o, k, n] = args;
      return [rows.filter((r) => r.office === o && r.kind === k && r.terminal_no === n)];
    }
    if (s.startsWith('SELECT * FROM bo_terminals WHERE id = ? AND office = ?')) {
      return [rows.filter((r) => r.id === args[0] && r.office === args[1])];
    }
    if (s.startsWith('SELECT COALESCE(MAX(terminal_no), 0) + 1 AS n')) {
      const [o, k] = args;
      const n = rows.filter((r) => r.office === o && r.kind === k).reduce((m, r) => Math.max(m, r.terminal_no), 0) + 1;
      return [[{ n }]];
    }
    if (s.startsWith('INSERT INTO bo_terminals (office, kind, terminal_no, name, device_id, device_name, app_version, licensed_at, created_by)')) {
      const [office, kind, terminal_no, name, device_id, device_name] = args;
      rows.push({ id: nextId++, office, kind, terminal_no, name, device_id, device_name, created_by: 'enrolled', key_hash: null, last_ping_at: new Date() });
      return [{ insertId: nextId - 1 }];
    }
    if (s.startsWith('INSERT INTO bo_terminals (office, kind, terminal_no, name, device_id, device_name, seat_id, licensed_at, last_ping_at, created_by)')) {
      const [office, kind, terminal_no, name, device_id, device_name, seat_id] = args;
      rows.push({ id: nextId++, office, kind, terminal_no, name, device_id, device_name, seat_id, created_by: 'claimed', key_hash: null, last_ping_at: new Date() });
      return [{ insertId: nextId - 1 }];
    }
    if (s.startsWith('UPDATE bo_terminals SET name = ? WHERE id = ?')) {
      rows.find((r) => r.id === args[1]).name = args[0];
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('DELETE FROM bo_terminal_settings WHERE terminal_id = ?')) {
      for (let i = settings.length - 1; i >= 0; i--) if (settings[i].terminal_id === args[0]) settings.splice(i, 1);
      return [{}];
    }
    if (s.startsWith('DELETE FROM bo_terminals WHERE id = ?')) {
      rows.splice(rows.findIndex((r) => r.id === args[0]), 1);
      return [{}];
    }
    if (s.startsWith('UPDATE bo_terminals SET device_id = NULL')) {
      Object.assign(rows.find((r) => r.id === args[0]), { device_id: null, device_name: null, seat_id: null });
      return [{}];
    }
    if (s.startsWith('UPDATE bo_terminals SET device_id = ?, device_name = ?, device_fingerprint = NULL')) {
      const [device_id, device_name, seat_id, name, id] = args;
      const r = rows.find((x) => x.id === id);
      Object.assign(r, { device_id, device_name, seat_id, revoked_at: null, last_ping_at: new Date() });
      if (name) r.name = name;
      return [{}];
    }
    throw new Error(`fake pool: ${s}`);
  };
  return { pool: { query: q, execute: q }, rows, released };
}

(async () => {
  let checks = 0;
  const realRelease = tillSeats.releaseSeat;
  const released = [];
  tillSeats.releaseSeat = async (_db, a) => {
    released.push(a.seatId);
    return true;
  };

  const { pool, rows } = fakePool();
  const store = terminalStore(pool);
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  rows.push(
    { id: 50, office: 'v@x', kind: 'till', terminal_no: 1, name: 'Bar', device_id: 'pc-a', device_name: 'DESKTOP-A', seat_id: 's-a', created_by: 'enrolled', last_ping_at: new Date() },
    { id: 51, office: 'v@x', kind: 'till', terminal_no: 2, name: 'Lounge', device_id: 'pc-dead', device_name: 'DESKTOP-DEAD', seat_id: 's-dead', created_by: 'enrolled', last_ping_at: old },
  );

  // A new PC that reported before it was asked has a row of its own (3).
  await store.enrol('v@x', { kind: 'till', deviceId: 'pc-new', deviceName: 'DESKTOP-NEW' });
  assert.strictEqual(rows.find((r) => r.device_id === 'pc-new').terminal_no, 3);
  checks += 1;

  // It replaces Terminal 2: it takes the number and the name, the dead PC's
  // seat is given back, and its own stray row goes.
  const { row } = await store.claim('v@x', { kind: 'till', deviceId: 'pc-new', deviceName: 'DESKTOP-NEW', number: 2, seatId: 's-new' });
  assert.strictEqual(row.terminal_no, 2);
  assert.strictEqual(row.name, 'Lounge');
  assert.strictEqual(row.device_id, 'pc-new');
  assert.strictEqual(row.seat_id, 's-new');
  assert.deepStrictEqual(released, ['s-dead']);
  assert.strictEqual(rows.filter((r) => r.terminal_no === 3).length, 0);
  checks += 1;

  // Terminal 1 is in use right now: not taken without a yes.
  const busy = await store.claim('v@x', { kind: 'till', deviceId: 'pc-other', number: 1, seatId: 's-o' });
  assert.ok(busy.busy);
  assert.strictEqual(rows.find((r) => r.terminal_no === 1).device_id, 'pc-a');
  checks += 1;

  const taken = await store.claim('v@x', { kind: 'till', deviceId: 'pc-other', number: 1, seatId: 's-o', confirm: true });
  assert.strictEqual(taken.row.device_id, 'pc-other');
  assert.ok(released.includes('s-a'));
  checks += 1;

  // A number nobody has yet is made, with the name given.
  const made = await store.claim('v@x', { kind: 'till', deviceId: 'pc-z', number: 7, name: 'Patio' });
  assert.strictEqual(made.row.terminal_no, 7);
  assert.strictEqual(made.row.name, 'Patio');
  checks += 1;

  // "New terminal": the next number, named.
  const fresh = await store.claim('v@x', { kind: 'till', deviceId: 'pc-q', number: null, name: 'Function room' });
  assert.strictEqual(fresh.row.terminal_no, 8);
  assert.strictEqual(fresh.row.name, 'Function room');
  checks += 1;

  // The same machine choosing its own number again changes nothing but the name.
  const again = await store.claim('v@x', { kind: 'till', deviceId: 'pc-q', number: 8, name: 'Functions' });
  assert.strictEqual(again.row.id, fresh.row.id);
  assert.strictEqual(again.row.name, 'Functions');
  checks += 1;

  tillSeats.releaseSeat = realRelease;
  console.log(`terminal-claim: ${checks} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
