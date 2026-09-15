/**
 * Give vouchers issued before the pass art existed their picture.
 *
 *   node scripts/backfill-art.js            # how many would be sent
 *   node scripts/backfill-art.js --apply
 *
 * The issue call is idempotent on the order line's reference: asked again with
 * the art, the EPOS keeps the card it has and only fills in the picture. Run on
 * the server, in the app directory. Safe to run twice.
 */
require('dotenv').config({ quiet: true });

const db = require('../src/db');
const epos = require('../src/epos');
const venues = require('../src/venues');
const { stripsFor } = require('../src/strips');
const { ref } = require('../src/orders');

(async () => {
  const apply = process.argv.includes('--apply');
  const lines = await db.all(
    `SELECT l.*, o.buyer_name, o.office_id, o.id AS order_id FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id
      WHERE o.status = 'paid' AND l.card_id IS NOT NULL AND l.voided_at IS NULL ORDER BY l.id`
  );
  let sent = 0;
  for (const l of lines) {
    const venue = await venues.get(l.office_id);
    const design = (l.design_id && await venues.design(l.office_id, l.design_id))
      || (await venues.designs(l.office_id, { onSale: false }))[0] || null;
    if (!apply) { sent++; continue; }
    const art = await stripsFor(design);
    if (!art) continue;
    const r = await epos.issueCard(l.office_id, {
      amount_minor: l.unit_minor,
      external_ref: `${ref({ id: l.order_id })}/${l.line_no}`,
      art_strip: art,
    });
    if (r.repeated && r.card.id === l.card_id) sent++;
    else console.warn(`line ${l.id}: unexpected answer ${JSON.stringify(r).slice(0, 120)}`);
    void venue;
  }
  console.log(`${apply ? 'sent art for' : 'would send art for'} ${sent} of ${lines.length} vouchers`);
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
