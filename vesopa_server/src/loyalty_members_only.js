/**
 * A loyalty app for paid-up members only (2026-10-05).
 *
 * Pontardawe RFC: "Only the listed people who have paid their membership can
 * use the loyalty app." A club's app is a members' benefit, so a venue can
 * switch on `epos_loyalty_app.members_only` and then:
 *
 *   * nobody new can join from the app: an address the club has not listed is
 *     told to ask the club, and no customer is created for it;
 *   * a listed member whose membership is not paid up is told so, at sign-in
 *     and on every call after it, so a lapsed member's app stops working
 *     without anybody signing them out by hand.
 *
 * PAID UP means what the till and the gym door already mean by it. A member of
 * a plan (src/memberships.js) is paid up while the plan is active or frozen: a
 * freeze is paid-for time, not a lapse. A venue that keeps only an expiry date
 * (the older Loyalty › Membership, or a customer import) is paid up until that
 * date. Somebody with neither has never paid and is not let in.
 *
 * Guarded like every other optional column: a server without
 * schema_loyalty_members_only.sql treats every app as open, which is how they
 * all behaved before.
 */

const CACHE_MS = 60 * 1000;
const venues = new Map();
const members = new Map();

const today = () => new Date().toISOString().slice(0, 10);
const isoDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    // A DATE column read as a local-midnight Date: its own calendar day.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
};

/** Whether the venue's app is for paid-up members only. */
async function membersOnly(db, office) {
  if (!office) return false;
  const hit = venues.get(office);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.on;
  let on = false;
  try {
    const [[row]] = await db.query('SELECT members_only FROM epos_loyalty_app WHERE office = ?', [office]);
    on = !!(row && Number(row.members_only));
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  venues.set(office, { on, at: Date.now() });
  return on;
}

/** Forget the cached answer, after the back office changes the switch. */
function forget(office) {
  venues.delete(office);
  for (const key of members.keys()) if (key.startsWith(`${office}|`)) members.delete(key);
}

/** Paid up, from a customer row. Pure, so it is tested on its own. */
function paidUpRow(c, day = today()) {
  if (!c) return false;
  const status = c.membership_status || '';
  const expiry = isoDay(c.membership_expiry);
  if (status) {
    if (status === 'cancelled' || status === 'pending') return false;
    if (status === 'frozen') return true;
    return !expiry || expiry >= day;
  }
  return !!expiry && expiry >= day;
}

/** Whether this customer may use a members-only app now. */
async function paidUp(db, office, customerId) {
  const key = `${office}|${customerId}`;
  const hit = members.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
  let row = null;
  try {
    [[row]] = await db.query(
      'SELECT membership_status, membership_expiry FROM epos_customers WHERE id = ? AND email_key = ?',
      [customerId, office]
    );
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    [[row]] = await db.query(
      'SELECT membership_expiry FROM epos_customers WHERE id = ? AND email_key = ?',
      [customerId, office]
    );
  }
  const ok = paidUpRow(row);
  members.set(key, { ok, at: Date.now() });
  return ok;
}

const NOT_LISTED =
  'This app is for paid-up members only. If you are a member, ask the club to add this email address to your membership.';
const NOT_PAID =
  'Your membership is not paid up, so the app is switched off for now. Renew with the club and it will work again.';

module.exports = { membersOnly, paidUp, paidUpRow, forget, NOT_LISTED, NOT_PAID };
