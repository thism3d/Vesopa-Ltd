/**
 * The owner's switches, from the server's own shell -- for setting up and for
 * when nobody can sign in to the console.
 *
 *   node scripts/venue-access.js enable  <officeId>
 *   node scripts/venue-access.js disable <officeId>
 *   node scripts/venue-access.js staff   <officeId> <email>
 *   node scripts/venue-access.js unstaff <officeId> <email>
 *   node scripts/venue-access.js list
 *
 * Does what the console's buttons do (src/admin.js, /venues/:id/enable and
 * /staff), through the same modules, and writes the same audit rows -- signed
 * "operator (server)" so nobody mistakes them for a person's click. Run from the
 * app directory so it reads the live .env.
 */
require('dotenv').config();

const db = require('../src/db');
const epos = require('../src/epos');
const venues = require('../src/venues');
const util = require('../src/util');
const { audit } = require('../src/fulfil');

const ACTOR = 'operator (server)';

async function main() {
  const [action, office, email] = process.argv.slice(2);
  const id = Number(office);

  if (action === 'list') {
    const rows = await db.all(
      `SELECT v.office_id, v.name, v.slug, v.enabled,
              (SELECT GROUP_CONCAT(email ORDER BY email) FROM gift_staff s WHERE s.office_id = v.office_id) AS staff
         FROM gift_venues v ORDER BY v.enabled DESC, v.name`
    );
    for (const r of rows) console.log(`${r.office_id}\t${r.enabled ? 'ON ' : 'off'}\t/${r.slug}\t${r.name}\t${r.staff || '-'}`);
    return;
  }
  if (!['enable', 'disable', 'staff', 'unstaff'].includes(action) || !id) {
    throw new Error('usage: venue-access.js enable|disable <officeId> | staff|unstaff <officeId> <email> | list');
  }

  if (action === 'enable') {
    const ev = await epos.venue(id);
    await venues.ensure(ev);
    await db.run('UPDATE gift_venues SET enabled = 1, enabled_at = UTC_TIMESTAMP(), enabled_by = ? WHERE office_id = ?', [ACTOR, ev.id]);
    await venues.refreshBrand(ev.id).catch(() => {});
    const v = await venues.get(ev.id);
    await audit(ev.id, 'venue.enabled', { slug: v.slug }, ACTOR);
    console.log(`${v.name || ev.name} is on, at /${v.slug}`);
  } else if (action === 'disable') {
    await db.run('UPDATE gift_venues SET enabled = 0 WHERE office_id = ?', [id]);
    await audit(id, 'venue.disabled', null, ACTOR);
    console.log(`office ${id} is off`);
  } else {
    const who = util.clean(email, 190).toLowerCase();
    if (!util.isEmail(who)) throw new Error('that email address does not look right');
    if (action === 'staff') {
      const ev = await epos.venue(id);
      await venues.ensure(ev);
      await db.run('INSERT IGNORE INTO gift_staff (office_id, email, created_by) VALUES (?, ?, ?)', [id, who, ACTOR]);
      await audit(id, 'staff.added', { email: who }, ACTOR);
      console.log(`${who} can manage ${ev.name} once they sign in with that address`);
    } else {
      await db.run('DELETE FROM gift_staff WHERE office_id = ? AND email = ?', [id, who]);
      await audit(id, 'staff.removed', { email: who }, ACTOR);
      console.log(`${who} can no longer manage office ${id}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e.message); process.exit(1); });
