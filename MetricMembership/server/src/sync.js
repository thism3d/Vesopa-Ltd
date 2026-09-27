/**
 * Keeping each camera's own allow-list equal to the members' cars.
 *
 * Runs after every change that could move a plate on or off a list (a car
 * added or removed, a member approved, suspended or expired), a few seconds
 * later so a burst of changes is one sync, and on a timer as well, which is
 * what catches expiry dates passing and a camera that was offline.
 *
 * ONLY WHAT THIS SERVER ADDED IS EVER REMOVED. gate_plates records what was
 * pushed; a plate the site's own staff typed into the camera by hand is not
 * in it and is left alone.
 */

const db = require('./db');
const access = require('./access');
const activity = require('./activity');
const { adapterFor } = require('./adapters');

async function syncGate(gate) {
  const adapter = adapterFor(gate);
  const want = await access.allowedPlates(gate.site_id);
  try {
    if (adapter.fullList) {
      if (!gate.device_url) return { gate: gate.id, skipped: 'pull' };
      await adapter.pushAll(gate, want);
      await db.run('DELETE FROM gate_plates WHERE gate_id = ?', [gate.id]);
      if (want.length) {
        await db.run('INSERT INTO gate_plates (gate_id, plate) VALUES ?', [want.map((p) => [gate.id, p])]);
      }
      await db.run("UPDATE gates SET last_sync_at = NOW(), last_sync_error = '' WHERE id = ?", [gate.id]);
      return { gate: gate.id, total: want.length };
    }
    if (typeof adapter.pushPlates !== 'function' || !gate.device_url) return { gate: gate.id, skipped: 'no push' };

    const have = await db.all('SELECT plate, device_ref FROM gate_plates WHERE gate_id = ?', [gate.id]);
    const haveSet = new Set(have.map((r) => r.plate));
    const wantSet = new Set(want);
    const add = want.filter((p) => !haveSet.has(p));
    const remove = have.filter((r) => !wantSet.has(r.plate));

    if (remove.length) {
      await adapter.removePlates(gate, remove);
      await db.run('DELETE FROM gate_plates WHERE gate_id = ? AND plate IN (?)', [gate.id, remove.map((r) => r.plate)]);
    }
    if (add.length) {
      const pushed = await adapter.pushPlates(gate, add);
      await db.run(
        'INSERT INTO gate_plates (gate_id, plate, device_ref) VALUES ? ON DUPLICATE KEY UPDATE device_ref = VALUES(device_ref), pushed_at = NOW()',
        [pushed.map((p) => [gate.id, p.plate, p.ref || ''])],
      );
    }
    await db.run("UPDATE gates SET last_sync_at = NOW(), last_sync_error = '' WHERE id = ?", [gate.id]);
    if (add.length || remove.length) {
      activity.record({
        actor: { type: 'system', label: 'allow-list sync' },
        action: 'gate.sync',
        detail: { gateId: gate.id, gate: gate.name, added: add, removed: remove.map((r) => r.plate) },
      });
    }
    return { gate: gate.id, added: add.length, removed: remove.length };
  } catch (e) {
    await db.run('UPDATE gates SET last_sync_error = ? WHERE id = ?', [String(e.message).slice(0, 500), gate.id]);
    activity.record({
      actor: { type: 'system', label: 'allow-list sync' },
      action: 'gate.sync_failed',
      detail: { gateId: gate.id, gate: gate.name, error: e.message },
    });
    return { gate: gate.id, error: e.message };
  }
}

async function syncAll() {
  const gates = await db.all("SELECT * FROM gates WHERE active = 1 AND mode IN ('allowlist','both')");
  const out = [];
  for (const g of gates) out.push(await syncGate(g));
  return out;
}

let timer = null;
/** Ask for a sync soon; many asks in a row make one sync. */
function soon(delayMs = 3000) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    syncAll().catch((e) => console.error('[sync] failed:', e.message));
  }, delayMs);
  if (timer.unref) timer.unref();
}

module.exports = { syncGate, syncAll, soon };
