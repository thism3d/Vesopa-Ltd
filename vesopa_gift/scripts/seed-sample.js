/**
 * Ten days of believable trading for the TEST venue, so the console has
 * something to show. Run on the server, in the app directory:
 *
 *   node scripts/seed-sample.js            # what it would make
 *   node scripts/seed-sample.js --apply    # make it; prints the card ids for the EPOS side
 *   node scripts/seed-sample.js --remove   # take every seeded row out again
 *
 * Real orders through the real code -- validated, fulfilled, the cards issued in
 * the live EPOS -- but paid for by nobody: each is marked paid by hand with
 * intent_id 'seed-<n>', which is also how --remove finds them. No email goes
 * anywhere: mail is switched off for the run, and the addresses are
 * example.com. Only an office named in GIFT_TEST_OFFICES is ever touched.
 *
 * The EPOS side (backdating the cards, spending some at a till) needs root on
 * the box: scripts/seed-live.py does that, and calls this.
 */
require('dotenv').config({ quiet: true });

const mail = require('../src/mail');
// Mail off before anything that sends is loaded: fulfil() holds this module.
mail.send = async () => true;
mail.mailEnabled = () => true;

const db = require('../src/db');
const venues = require('../src/venues');
const orders = require('../src/orders');
const fulfil = require('../src/fulfil');
const { publicId } = require('../src/util');

const OFFICE = Number(process.env.SEED_OFFICE || 9);
const TEST = new Set(String(process.env.GIFT_TEST_OFFICES || '9').split(',').map((s) => Number(s.trim())));
const TODAY = process.env.SEED_TODAY || new Date().toISOString().slice(0, 10);
const EVENT_IMAGE = 'seedeventtasting01.jpg';

/** London wall-clock on a day N days before today, as UTC (September: BST, UTC+1). */
function at(daysAgo, hhmm) {
  const d = new Date(`${TODAY}T${hhmm}:00+01:00`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}
function dayPlus(days) {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const ex = (s) => `${s}@example.com`;

// Oldest first, so the order numbers run the way the days did.
const SAMPLE = [
  { day: 9, time: '10:12', card: ['Visa', '4242'], buyer: ['Sam Jones', ex('sam.jones')], voucher: { amount: 5000, design: 'Celebrate', to: ['Alex Morgan', ex('alex.morgan')], message: 'Happy birthday! Dinner is on me — take someone nice.' }, spend: [{ minor: 1850, day: 6, time: '20:41' }] },
  { day: 9, time: '19:40', card: ['Mastercard', '1005'], buyer: ['Kate Lewis', ex('kate.lewis')], voucher: { amount: 2500, design: 'Thank you', to: ['Dafydd Hughes', ex('dafydd.hughes')], message: 'Thank you for everything this year.' }, spend: [{ minor: 2500, day: 3, time: '13:22' }] },
  { day: 8, time: '12:05', card: ['Visa', '0341'], buyer: ['Tom Roberts', ex('tom.roberts')], voucher: { amount: 10000, design: 'Winter', to: ['Mum and Dad', ex('roberts.family')], later: 40 } },
  { day: 7, time: '08:55', card: ['Visa', '7719'], buyer: ['Rhian Morgan', ex('rhian.morgan')], experience: { to: ['Priya Shah', ex('priya.shah')], message: 'For all the lifts to training.' }, spend: [{ minor: 4800, day: 2, time: '14:05' }] },
  { day: 7, time: '17:20', card: ['Visa', '7719'], buyer: ['Rhian Morgan', ex('rhian.morgan')], tickets: { Tasting: 2 } },
  { day: 6, time: '13:30', card: ['Mastercard', '5533'], buyer: ['Jo Evans', ex('jo.evans')], voucher: { custom: 4000, design: 'Celebrate', self: true }, spend: [{ minor: 1200, day: 1, time: '19:58' }] },
  { day: 5, time: '09:15', card: ['Visa', '2201'], buyer: ['Megan Price', ex('megan.price')], voucher: { amount: 7500, design: 'Dinner for two', to: ['Owen Price', ex('owen.price')], message: 'Happy anniversary x' } },
  { day: 4, time: '20:05', card: ['Amex', '1008'], buyer: ['Huw Davies', ex('huw.davies')], tickets: { 'Tasting and supper': 2 } },
  { day: 3, time: '11:45', card: ['Visa', '9902'], buyer: ['Elin Thomas', ex('elin.thomas')], voucher: { amount: 2500, design: 'Celebrate', to: ['Carys Thomas', ex('carys.thomas')], message: 'Well done on the exams!' } },
  { day: 2, time: '15:10', card: ['Mastercard', '6170'], buyer: ['Gareth Williams', ex('gareth.williams')], voucher: { amount: 5000, design: 'Thank you', to: ['Bethan Williams', ex('bethan.williams')], message: 'Happy birthday Beth', later: 5 } },
  { day: 1, time: '10:40', card: ['Visa', '3384'], buyer: ['Lowri Jenkins', ex('lowri.jenkins')], voucher: { amount: 10000, design: 'Winter', to: ['Ffion Jenkins', ex('ffion.jenkins')], message: 'Congratulations on the new house!' }, spend: [{ minor: 3640, day: 0, time: '13:12' }] },
  { day: 0, time: '09:05', card: ['Mastercard', '4410'], buyer: ['Ben Harris', ex('ben.harris')], voucher: { custom: 6000, design: 'Dinner for two', self: true } },
  { day: 0, time: '14:50', card: ['Visa', '8127'], buyer: ['Anna Clarke', ex('anna.clarke')], voucher: { amount: 2500, design: 'Dinner for two', to: ['Mark Clarke', ex('mark.clarke')], message: 'Enjoy your lunch, Dad.' } },
];

function fmt(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

async function remove() {
  const seeded = await db.all("SELECT id FROM gift_orders WHERE office_id = ? AND intent_id LIKE 'seed-%'", [OFFICE]);
  const ids = seeded.map((o) => o.id);
  const cards = ids.length
    ? await db.all(`SELECT card_id FROM gift_order_lines WHERE order_id IN (${ids.map(() => '?').join(',')}) AND card_id IS NOT NULL`, ids)
    : [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    await db.run(`DELETE FROM gift_tickets WHERE order_id IN (${ph})`, ids);
    await db.run(`DELETE FROM gift_refunds WHERE order_id IN (${ph})`, ids).catch(() => {});
    await db.run(`DELETE FROM gift_order_lines WHERE order_id IN (${ph})`, ids);
    await db.run(`DELETE FROM gift_orders WHERE id IN (${ph})`, ids);
  }
  const ev = await db.all("SELECT id FROM gift_events WHERE office_id = ? AND image = ?", [OFFICE, EVENT_IMAGE]);
  for (const e of ev) {
    await db.run('DELETE FROM gift_ticket_types WHERE event_id = ?', [e.id]);
    await db.run('DELETE FROM gift_events WHERE id = ?', [e.id]);
  }
  await db.run("DELETE FROM gift_products WHERE office_id = ? AND name = 'Sunday lunch for two'", [OFFICE]);
  await db.run("DELETE FROM gift_audit WHERE office_id = ? AND actor = 'seed'", [OFFICE]);
  console.log(JSON.stringify({ removed: ids.length, events: ev.length, epos_card_ids: cards.map((c) => c.card_id) }));
}

async function apply(dry) {
  const venue = await venues.get(OFFICE);
  if (!venue || !venue.enabled) throw new Error(`office ${OFFICE} has no shop switched on`);
  const already = await db.one("SELECT COUNT(*) AS n FROM gift_orders WHERE office_id = ? AND intent_id LIKE 'seed-%'", [OFFICE]);
  if (Number(already.n)) throw new Error(`office ${OFFICE} already has ${already.n} seeded orders -- --remove first`);
  const designs = await venues.designs(OFFICE);
  const byName = Object.fromEntries(designs.map((d) => [d.name, d]));
  const amounts = venues.amountsOf(venue);

  if (dry) {
    for (const s of SAMPLE) console.log(fmt(at(s.day, s.time)), s.buyer[0], JSON.stringify(s.voucher || s.experience || s.tickets));
    console.log('dry run -- nothing made. Re-run with --apply.');
    return;
  }

  // The experience and the event the sample buys from.
  await db.run(
    `INSERT INTO gift_products (office_id, name, description, price_minor, design_id, sort)
     VALUES (?, 'Sunday lunch for two', 'Two courses and a glass of wine each.', 4800, ?, 1)`,
    [OFFICE, byName['Dinner for two'].id]
  );
  const product = await db.one("SELECT * FROM gift_products WHERE office_id = ? AND name = 'Sunday lunch for two'", [OFFICE]);
  const evDay = dayPlus(9);
  const ev = await db.run(
    `INSERT INTO gift_events (office_id, public_id, title, description, starts_at, doors_at, location, image, capacity)
     VALUES (?, ?, 'Welsh wine tasting', 'Six wines from three Welsh vineyards, poured and talked through by the people who made them, with cheese from down the road.',
             ?, ?, 'The back room', ?, 50)`,
    [OFFICE, publicId(12), `${evDay} 18:00:00`, `${evDay} 17:30:00`, EVENT_IMAGE]
  );
  await db.run(
    `INSERT INTO gift_ticket_types (event_id, name, description, price_minor, sort) VALUES
       (?, 'Tasting', 'six wines and cheese', 2800, 0), (?, 'Tasting and supper', 'with a two-course supper after', 4500, 1)`,
    [ev.insertId, ev.insertId]
  );
  const event = await db.one('SELECT * FROM gift_events WHERE id = ?', [ev.insertId]);
  const types = await db.all('SELECT * FROM gift_ticket_types WHERE event_id = ? ORDER BY sort', [event.id]);
  const typeByName = Object.fromEntries(types.map((t) => [t.name, t]));

  const out = [];
  let n = 0;
  for (const s of SAMPLE) {
    n++;
    const placed = at(s.day, s.time);
    const ip = `10.9.${Math.floor(n / 250)}.${n % 250}`;
    const buyer = { buyer_name: s.buyer[0], buyer_email: s.buyer[1] };
    let order;
    if (s.tickets) {
      const input = { ...buyer };
      for (const [name, qty] of Object.entries(s.tickets)) input[`qty_${typeByName[name].id}`] = String(qty);
      order = await orders.createTicketOrder(venue, event, input, ip);
    } else {
      const v = s.voucher || s.experience;
      const input = {
        ...buyer,
        design: v.design ? String(byName[v.design].id) : String(byName['Dinner for two'].id),
        amount: v.amount ? String(v.amount) : '',
        custom_amount: v.custom ? String(v.custom / 100) : '',
        send_to: v.self ? 'buyer' : 'recipient',
        recipient_name: v.to ? v.to[0] : '',
        recipient_email: v.to ? v.to[1] : '',
        message: v.message || '',
        when: v.later ? 'later' : 'now',
        deliver_date: v.later ? dayPlus(v.later) : '',
        deliver_time: '09:00',
      };
      const design = byName[v.design] || byName['Dinner for two'];
      const validated = orders.validateVoucher(input, { venue, amounts, design, product: s.experience ? product : null });
      order = await orders.createVoucherOrder(venue, validated, ip);
    }
    await db.run(
      `UPDATE gift_orders SET status = 'paid', paid_at = ?, card_brand = ?, card_last4 = ?, intent_id = ? WHERE id = ?`,
      [placed, s.card[0], s.card[1], `seed-${n}`, order.id]
    );
    await fulfil.fulfil(order.id);
    // Everything that happened "at once" happened when it was placed.
    await db.run(
      `UPDATE gift_orders SET created_at = ?, paid_at = ?, fulfilled_at = ?, receipt_sent_at = ?, venue_told_at = ?, checked_at = ? WHERE id = ?`,
      [placed, placed, placed, placed, placed, placed, order.id]
    );
    await db.run('UPDATE gift_order_lines SET delivered_at = ? WHERE order_id = ? AND delivered_at IS NOT NULL', [placed, order.id]);
    await db.run('UPDATE gift_tickets SET created_at = ? WHERE order_id = ?', [placed, order.id]);
    await db.run("UPDATE gift_audit SET at = ?, actor = 'seed' WHERE office_id = ? AND at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) AND detail LIKE ?", [placed, OFFICE, `%${orders.ref(order)}%`]).catch(() => {});
    const lines = await db.all('SELECT * FROM gift_order_lines WHERE order_id = ?', [order.id]);
    for (const l of lines) {
      if (!l.card_id) continue;
      out.push({
        order: orders.ref(order), card_id: l.card_id, code: l.card_code, placed: fmt(placed),
        spends: (s.spend || []).map((sp) => ({ minor: sp.minor, at: fmt(at(sp.day, sp.time)) })),
      });
    }
  }
  console.log(JSON.stringify({ made: n, event: event.public_id, cards: out }));
}

(async () => {
  if (!TEST.has(OFFICE)) throw new Error(`office ${OFFICE} is not a test office (GIFT_TEST_OFFICES)`);
  if (process.argv.includes('--remove')) await remove();
  else await apply(!process.argv.includes('--apply'));
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
