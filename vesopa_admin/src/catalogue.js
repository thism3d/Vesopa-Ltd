/**
 * Everything a venue can have, in one list (2026-10-05).
 *
 * "add, remove or pause new licenses of everything including every module and
 * options" (owner). Each line says which app owns the thing, so the change is
 * made by that app, and how it is held:
 *
 *   hold: 'epos'   the back office keeps the pause itself, grace day and all
 *                  (vesopa_server/src/admin_holds.js); `holdKey` is its item.
 *   hold: 'later'  the app has no grace of its own (Gift), so admin.vesopa.com
 *                  warns now and switches it off itself when the day is up
 *                  (adm_scheduled, src/scheduler.js).
 *
 * `seats` marks a device app, whose number of licences can be set. Adding a
 * product later is adding a line here.
 */
const ITEMS = [
  { key: 'till', label: 'Till', group: 'Apps', app: 'epos', hold: 'epos', holdKey: 'till', seats: true },
  { key: 'kitchen', label: 'Kitchen screen', group: 'Apps', app: 'epos', hold: 'epos', holdKey: 'kitchen', seats: true },
  { key: 'display', label: 'Customer display', group: 'Apps', app: 'epos', hold: 'epos', holdKey: 'display', seats: true },
  { key: 'express', label: 'Express kiosk', group: 'Apps', app: 'epos', hold: 'epos', holdKey: 'express', seats: true },
  { key: 'loyalty_app', label: 'Loyalty app', group: 'Apps', app: 'loyalty', hold: 'epos', holdKey: 'loyalty_app' },
  { key: 'gift', label: 'Gift cards and tickets', group: 'Apps', app: 'gift', hold: 'later' },
  { key: 'memberships', label: 'Memberships', group: 'Modules', app: 'epos', hold: 'epos', holdKey: 'module:memberships', module: 'memberships' },
  { key: 'gym_door', label: 'Gym door', group: 'Modules', app: 'epos', hold: 'epos', holdKey: 'module:gym_door', module: 'gym_door' },
  { key: 'vehicle_access', label: 'Vehicle access', group: 'Modules', app: 'epos', hold: 'epos', holdKey: 'module:vehicle_access', module: 'vehicle_access' },
];

const BY_KEY = Object.fromEntries(ITEMS.map((i) => [i.key, i]));
const GROUPS = [...new Set(ITEMS.map((i) => i.group))];
const GRACE_HOURS = 24;

/**
 * One venue's line for one item, from what the apps said.
 *
 * `state` is what the screen shows and what the buttons follow:
 *   off      not sold to this venue
 *   active   sold and running
 *   grace    paused or removed, still running until `until`
 *   paused   paused, stopped
 *   removed  removed, stopped
 */
function lineFor(item, { limits = {}, inUse = {}, modules = {}, holds = {}, gift = null } = {}) {
  const hold = item.hold === 'epos' ? holds[item.holdKey] || null : null;
  let sold;
  let seats = null;
  let used = null;
  if (item.seats) {
    seats = limits[item.key] === undefined ? null : limits[item.key];
    used = inUse[item.key] == null ? null : Number(inUse[item.key]);
    // A device app is sold unless its limit is zero: no limit is how every
    // venue started, and it means "as many as they run".
    sold = seats !== 0;
  } else if (item.module) {
    const m = modules[item.module];
    sold = !!(m && (m.allowed || (m.hold && m.hold.stopped)));
  } else if (item.key === 'gift') {
    sold = !!(gift && gift.enabled);
  } else {
    sold = true; // the Loyalty app: the venue's own switch, held from here
  }

  let state = sold ? 'active' : 'off';
  let until = null;
  if (hold) {
    until = hold.graceUntil;
    state = hold.stopped ? hold.state : 'grace';
  } else if (item.key === 'gift' && gift && gift.pending) {
    until = gift.pending.due_at;
    state = 'grace';
  }
  return {
    key: item.key,
    label: item.label,
    group: item.group,
    app: item.app,
    hasSeats: !!item.seats,
    seats,
    used,
    state,
    holdState: hold ? hold.state : gift && item.key === 'gift' && gift.pending ? gift.pending.action : null,
    until,
    reason: hold ? hold.reason : null,
    price_minor: item.module && modules[item.module] ? modules[item.module].charge_minor : null,
  };
}

module.exports = { ITEMS, BY_KEY, GROUPS, GRACE_HOURS, lineFor };
