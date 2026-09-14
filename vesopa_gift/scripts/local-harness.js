/**
 * The whole product running on this machine, filled with a believable week, for
 * looking at: every page of the shop and the console, with real orders in them.
 *
 *   EXPRESS_TEST_USER=vesopa_test EXPRESS_TEST_PASS=vesopa_test node scripts/local-harness.js
 *
 * Prints the addresses and an owner's cookie, writes them to harness.json in the
 * OS temp folder for the screenshot script, and stays up until Ctrl+C.
 *
 * Sample data only, on scratch databases. It touches nothing live.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { buildStack, sleep } = require('../test/lib/stack');

const VENUE = { id: 931, email: 'kitchen@harness.test', name: 'The Vesopa Kitchen' };
const IMAGES = process.env.HARNESS_IMAGES || path.join(os.homedir(), 'Documents', 'Vesopa-Claude-Images', '2026-09-13-gift-design');

async function main() {
  // A stand-in for the back office's uploads: serves the sample photograph.
  const img = http.createServer((req, res) => {
    const file = path.join(IMAGES, path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => img.listen(0, '127.0.0.1', r));
  const imgOrigin = `http://127.0.0.1:${img.address().port}`;

  const S = await buildStack({
    eposDb: 'vesopa_gift_harness_epos', giftDb: 'vesopa_gift_harness_gift', venue: VENUE,
    brand: { name: 'The Vesopa Kitchen', primary: '#8C2F39', hero: `${imgOrigin}/hero-venue.jpg` },
    giftEnv: { BACKOFFICE_ORIGIN: imgOrigin },
  });
  if (!S) return;
  const { gift, dojo, post, get } = S;

  await post(`/admin/venues/${VENUE.id}/enable`, {}, { auth: true });
  await post(`/admin/v/${VENUE.id}/settings`, {
    amounts: '25, 50, 75, 100', allow_custom: '1', min: '10', max: '500', validity_months: '12',
    allow_schedule: '1', schedule_max_days: '183', max_order: '500', orders_per_email_day: '20',
    hold: '1', hold_over: '250', hold_hours: '24', notify_email: 'manager@harness.test', terms: '',
  }, { auth: true });

  const [designs] = await gift.query('SELECT id, name FROM gift_designs WHERE office_id = ? ORDER BY sort', [VENUE.id]);
  const byName = Object.fromEntries(designs.map((d) => [d.name, d.id]));
  await gift.query(
    `INSERT INTO gift_products (office_id, name, description, price_minor, design_id, sort) VALUES
      (?, 'Sunday lunch for two', 'Two courses and a glass of wine each.', 4800, ?, 1),
      (?, 'Winter supper club', 'Three courses by the fire, November to February.', 6500, ?, 2)`,
    [VENUE.id, byName['Dinner for two'], VENUE.id, byName.Winter]
  );

  // The event's picture goes where an uploaded one would.
  const uploads = path.join(__dirname, '..', 'uploads', String(VENUE.id));
  fs.mkdirSync(uploads, { recursive: true });
  fs.copyFileSync(path.join(IMAGES, 'event-tasting.jpg'), path.join(uploads, 'harnesseventtasting01.jpg'));
  const [ev] = await gift.query(
    `INSERT INTO gift_events (office_id, public_id, title, description, starts_at, doors_at, location, image, capacity)
     VALUES (?, 'winetasting1', 'Welsh wine tasting', 'Six wines from three Welsh vineyards, poured and talked through by the people who made them, with cheese from down the road.',
             -- 7pm and doors at half six, London summer time, nine days out.
             CONCAT(DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 9 DAY)), ' 18:00:00'), CONCAT(DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 9 DAY)), ' 17:30:00'),
             'The back room', 'harnesseventtasting01.jpg', 50)`,
    [VENUE.id]
  );
  await gift.query(
    `INSERT INTO gift_ticket_types (event_id, name, description, price_minor, sort) VALUES
      (?, 'Tasting', 'six wines and cheese', 2800, 0), (?, 'Tasting and supper', 'with a two-course supper after', 4500, 1)`,
    [ev.insertId, ev.insertId]
  );

  const pay = async (res) => {
    const it = dojo.last();
    dojo.capture(it.id);
    await get(new URL(it.config.redirectUrl).pathname);
    return it;
  };
  const buyer = (name, email) => ({ buyer_name: name, buyer_email: email });
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  await post('/vesopa-kitchen/buy', { design: String(byName.Celebrate), amount: '5000', send_to: 'recipient', recipient_name: 'Alex Morgan', recipient_email: 'alex@harness.test', message: 'Happy birthday! Dinner is on me — take someone nice.', when: 'later', deliver_date: d(11), deliver_time: '09:00', ...buyer('Sam Jones', 'sam@harness.test') }); await pay();
  await post('/vesopa-kitchen/buy', { design: String(byName['Thank you']), amount: '2500', send_to: 'recipient', recipient_name: 'Dafydd Hughes', recipient_email: 'dafydd@harness.test', message: 'Thank you for everything this year.', when: 'now', ...buyer('Kate Lewis', 'kate@harness.test') }); await pay();
  await post('/vesopa-kitchen/buy', { design: String(byName.Winter), amount: '10000', send_to: 'recipient', recipient_name: 'Mum and Dad', recipient_email: 'parents@harness.test', when: 'later', deliver_date: d(40), deliver_time: '07:00', ...buyer('Tom Roberts', 'tom@harness.test') }); await pay();
  const [[lunch]] = await gift.query("SELECT id FROM gift_products WHERE name = 'Sunday lunch for two'");
  await post(`/vesopa-kitchen/buy/${lunch.id}`, { send_to: 'recipient', recipient_name: 'Priya Shah', recipient_email: 'priya@harness.test', when: 'now', ...buyer('Rhian Morgan', 'rhian@harness.test') }); await pay();
  const [[tt]] = await gift.query("SELECT id FROM gift_ticket_types WHERE name = 'Tasting'");
  await post('/vesopa-kitchen/events/winetasting1', { [`qty_${tt.id}`]: '2', ...buyer('Rhian Morgan', 'rhian@harness.test') }); await pay();
  await post('/vesopa-kitchen/buy', { design: String(byName.Celebrate), custom_amount: '40', send_to: 'buyer', ...buyer('Jo Evans', 'jo@harness.test') }); await pay();
  await sleep(2500);

  // A few weeks of trading rather than six orders in one second: some of the
  // vouchers spent at the till, and everything moved back in time. Shifted
  // relative to what is stored, so no time zone can move it.
  const till = await S.tillLogin();
  const tillCall = (p, body) => fetch(`${S.E}/api/gift-cards/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${till}` }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const [lines] = await gift.query('SELECT order_id, card_id, card_code FROM gift_order_lines WHERE card_code IS NOT NULL');
  const lineOf = (orderId) => lines.find((l) => l.order_id === orderId);
  const HOUR = 60;
  // Oldest first, so the order numbers still run in the order things happened.
  const history = [ // order id, placed this long ago, and what was spent of it how long ago
    { id: 1, ago: 26 * 24 * HOUR },
    { id: 2, ago: 19 * 24 * HOUR, spend: 1850, spentAgo: 12 * 24 * HOUR },
    { id: 3, ago: 9 * 24 * HOUR },
    { id: 4, ago: 50 * HOUR, spend: 4800, spentAgo: 20 * HOUR },
    { id: 5, ago: 30 * HOUR },
    { id: 6, ago: 3 * HOUR, spend: 1200, spentAgo: 1 * HOUR },
  ];
  for (const h of history) {
    await gift.query(
      `UPDATE gift_orders SET created_at = created_at - INTERVAL ? MINUTE, paid_at = paid_at - INTERVAL ? MINUTE WHERE id = ?`,
      [h.ago, h.ago, h.id]
    );
    await gift.query(
      'UPDATE gift_order_lines SET delivered_at = delivered_at - INTERVAL ? MINUTE WHERE order_id = ? AND delivered_at IS NOT NULL AND deliver_at IS NULL',
      [h.ago, h.id]
    );
    const l = lineOf(h.id);
    if (!l) continue;
    await S.epos.query('UPDATE epos_gift_cards SET created_at = created_at - INTERVAL ? MINUTE WHERE id = ?', [h.ago, l.card_id]);
    await S.epos.query("UPDATE epos_gift_card_txns SET created_at = created_at - INTERVAL ? MINUTE WHERE gift_card_id = ? AND kind <> 'redeem'", [h.ago, l.card_id]);
    if (h.spend) {
      const hold = await tillCall('hold', { code: l.card_code, amount_minor: h.spend, order_id: require('crypto').randomUUID() });
      if (!hold.hold_id) throw new Error(`the till could not hold ${h.spend} on order ${h.id}: ${JSON.stringify(hold)}`);
      await tillCall('capture', { hold_id: hold.hold_id });
      await S.epos.query("UPDATE epos_gift_card_txns SET created_at = created_at - INTERVAL ? MINUTE WHERE gift_card_id = ? AND kind = 'redeem'", [h.spentAgo, l.card_id]);
    }
  }

  const [[someVoucher]] = await gift.query("SELECT view_token FROM gift_order_lines WHERE kind = 'voucher' AND card_id IS NOT NULL ORDER BY id DESC LIMIT 1");
  const [[someOrder]] = await gift.query("SELECT id, public_id FROM gift_orders WHERE status = 'paid' AND kind = 'voucher' ORDER BY id LIMIT 1");
  const [[ticketsOrder]] = await gift.query("SELECT public_id FROM gift_orders WHERE kind = 'tickets' LIMIT 1");
  const [[code]] = await gift.query("SELECT card_code FROM gift_order_lines WHERE card_code IS NOT NULL ORDER BY id LIMIT 1");

  const info = {
    G: S.G, cookie: S.cookie, office: VENUE.id, slug: 'vesopa-kitchen', event: ev.insertId, eventPublic: 'winetasting1',
    lunch: lunch.id, voucher: someVoucher.view_token, order: someOrder.id, paidPublic: someOrder.public_id,
    tickets: ticketsOrder.public_id, code: code.card_code, mailDir: S.mailDir,
  };
  const out = path.join(os.tmpdir(), 'vesopa-gift-harness.json');
  fs.writeFileSync(out, JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info, null, 2));
  console.log(`\nwritten to ${out}. Up until Ctrl+C.`);

  const stop = async () => { await S.stop(); img.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.env.HARNESS_SECONDS) setTimeout(stop, Number(process.env.HARNESS_SECONDS) * 1000);
}

main().catch((e) => { console.error(e); process.exit(1); });
