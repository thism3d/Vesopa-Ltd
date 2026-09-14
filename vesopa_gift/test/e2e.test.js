/**
 * Vesopa Gift end to end, on this machine: the real gift server, the real EPOS
 * server, two scratch databases, and a stand-in for Dojo (test/lib/stack.js).
 *
 *   EXPRESS_TEST_USER=vesopa_test EXPRESS_TEST_PASS=vesopa_test node test/e2e.test.js
 *
 * WHY A FAKE DOJO. The live check (scripts/verify-gift-live.js) pays with a real
 * sandbox card on Dojo's own page. This one runs in seconds, offline, and can
 * make a payment arrive late or not at all -- which the sandbox will not do on
 * demand. It answers the four calls the EPOS makes and nothing else.
 *
 * Skipped, not failed, where there is no database or no live-shaped template.
 */
const assert = require('assert');
const { buildStack, sleep } = require('./lib/stack');

const VENUE = { id: 921, email: 'test-kitchen@gift.test', name: 'The Test Kitchen' };

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const S = await buildStack({ eposDb: 'vesopa_gift_e2e_epos', giftDb: 'vesopa_gift_e2e_gift', venue: VENUE, onCheck: check });
  if (!S) return;
  const { gift, epos, dojo, get, post, mails, mailTo, until, G, cookie, csrf } = S;

  try {
    await check('a venue with no shop is not there at all', async () => {
      assert.strictEqual((await get('/the-test-kitchen')).status, 404);
      assert.strictEqual((await get('/')).status, 404, 'no index of venues');
    });

    await check('the console refuses anybody without a session, and a form without its token', async () => {
      assert.strictEqual((await get('/admin/venues')).status, 303);
      const f = await fetch(`${G}/admin/venues/${VENUE.id}/enable`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
      assert.strictEqual(f.status, 403);
    });

    await check('the owner sees the venue, and switches its shop on', async () => {
      const list = await get('/admin/venues', { auth: true });
      assert.strictEqual(list.status, 200, list.text.slice(0, 300));
      assert.ok(list.text.includes(VENUE.name));
      const on = await post(`/admin/venues/${VENUE.id}/enable`, {}, { auth: true });
      assert.strictEqual(on.status, 303);
      const [[v]] = await gift.query('SELECT * FROM gift_venues WHERE office_id = ?', [VENUE.id]);
      assert.strictEqual(v.enabled, 1);
      assert.strictEqual(v.slug, 'test-kitchen');
      const [d] = await gift.query('SELECT * FROM gift_designs WHERE office_id = ?', [VENUE.id]);
      assert.strictEqual(d.length, 4, 'the four starting designs');
    });

    await check('the venue sets where sales are sent', async () => {
      const r = await post(`/admin/v/${VENUE.id}/settings`, {
        amounts: '25, 50, 75, 100', allow_custom: '1', min: '10', max: '500', validity_months: '12',
        allow_schedule: '1', schedule_max_days: '183', max_order: '500', orders_per_email_day: '5',
        hold: '1', hold_over: '250', hold_hours: '24', notify_email: 'venue@gift.test', terms: '',
      }, { auth: true });
      assert.strictEqual(r.status, 303);
      const [[v]] = await gift.query('SELECT notify_email, amounts FROM gift_venues WHERE office_id = ?', [VENUE.id]);
      assert.strictEqual(v.notify_email, 'venue@gift.test');
      assert.strictEqual(v.amounts, '2500,5000,7500,10000');
    });

    const [[design]] = await gift.query('SELECT id FROM gift_designs WHERE office_id = ? ORDER BY sort LIMIT 1', [VENUE.id]);

    await check('the shop is open, in the venue\'s name, with a way to pay', async () => {
      const r = await get('/test-kitchen');
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.ok(r.text.includes('The Test Kitchen'));
      assert.ok(r.text.includes('Buy a gift voucher'));
    });

    const buyer = { buyer_name: 'Sam Jones', buyer_email: 'sam@gift.test' };
    const buy = await post('/test-kitchen/buy', {
      design: String(design.id), amount: '5000', send_to: 'recipient', recipient_name: 'Alex Morgan',
      recipient_email: 'alex@gift.test', message: 'Happy birthday!', when: 'now', ...buyer,
    });
    const intent1 = dojo.last();

    await check('buying sends the buyer to Dojo with the right amount, once', async () => {
      assert.strictEqual(buy.status, 303, buy.text.slice(0, 300));
      assert.ok(buy.location.startsWith('https://pay.dojo.tech/checkout/pi_sandbox_'), buy.location);
      assert.strictEqual(intent1.amount.value, 5000);
      assert.ok(String(intent1.config.redirectUrl).includes('/test-kitchen/paid/'));
    });

    const paidPath = new URL(intent1.config.redirectUrl).pathname;

    await check('coming back before paying is not paying', async () => {
      const r = await get(paidPath);
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('Checking your payment'));
      const [[card]] = await epos.query("SELECT COUNT(*) AS n FROM epos_gift_cards WHERE source = 'gift'");
      assert.strictEqual(card.n, 0, 'no card before the money');
    });

    dojo.capture(intent1.id);

    await check('once Dojo says Captured, the order is paid and the card exists in the EPOS', async () => {
      const r = await get(paidPath);
      assert.ok(r.text.includes('Paid. Thank you, Sam'), r.text.slice(0, 400));
      const [[card]] = await epos.query("SELECT * FROM epos_gift_cards WHERE source = 'gift' AND external_ref = 'VG-10001/1'");
      assert.ok(card, 'the card was issued');
      assert.strictEqual(card.balance_minor, 5000);
      assert.strictEqual(card.recipient_name, 'Alex Morgan');
    });

    await check('the recipient gets the voucher with its PDF, the buyer a receipt, the venue a note', async () => {
      const got = await until(() => mailTo('alex@gift.test').length && mailTo('sam@gift.test').length && mailTo('venue@gift.test').length);
      assert.ok(got, `mail: ${mails().map((m) => (m.envelope || {}).to).join(' | ')}`);
      const v = mailTo('alex@gift.test')[0];
      assert.match(v.subject, /Sam sent you a gift for The Test Kitchen/);
      assert.ok(v.attachments.some((a) => a.contentType === 'application/pdf'), 'a PDF to print');
      assert.ok(v.attachments.some((a) => a.cid === 'qr'), 'the QR travels with the mail');
      assert.ok(v.html.includes('Happy birthday!'));
      assert.match(mailTo('sam@gift.test')[0].subject, /receipt/i);
      assert.strictEqual(mailTo('alex@gift.test').length, 1, 'sent exactly once');
    });

    const [[line1]] = await gift.query('SELECT * FROM gift_order_lines WHERE card_id IS NOT NULL ORDER BY id LIMIT 1');

    await check('the recipient\'s page shows the code, the balance and a PDF', async () => {
      const r = await get(`/v/${line1.view_token}`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes(line1.card_code));
      assert.ok(r.text.includes('£50.00'));
      const p = await get(`/v/${line1.view_token}/voucher.pdf`);
      assert.strictEqual(p.status, 200);
      assert.ok(p.text.startsWith('%PDF'), 'a real PDF');
    });

    await check('the balance page answers for a shop voucher, and for nothing else', async () => {
      const r = await post('/test-kitchen/balance', { code: line1.card_code.toLowerCase() });
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('£50.00'));
      assert.strictEqual((await post('/test-kitchen/balance', { code: 'AAAA-BBBB-CCCC' })).status, 404);
    });

    const till = await S.tillLogin();
    const tillCall = (p, body) => fetch(`${S.E}/api/gift-cards/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${till}` }, body: JSON.stringify(body) }).then((r) => r.json());

    await check('the till holds and spends £20 of it, and the balance page follows', async () => {
      assert.ok(till, 'the till signed in');
      const h = await tillCall('hold', { code: line1.card_code, amount_minor: 2000, order_id: '33333333-3333-4333-8333-333333333333' });
      assert.ok(h.hold_id, JSON.stringify(h));
      const c = await tillCall('capture', { hold_id: h.hold_id });
      assert.strictEqual(c.card.balance_minor, 3000);
      const r = await post('/test-kitchen/balance', { code: line1.card_code });
      assert.ok(r.text.includes('£30.00'));
    });

    await check('a refund cancels the voucher and pays back only what was left', async () => {
      const r = await post(`/admin/v/${VENUE.id}/orders/${line1.order_id}/lines/${line1.id}/refund`, {}, { auth: true });
      assert.strictEqual(r.status, 303);
      assert.strictEqual(dojo.refunds.length, 1);
      assert.strictEqual(dojo.refunds[0].amount, 3000, 'not the £20 already spent');
      const [[card]] = await epos.query('SELECT status FROM epos_gift_cards WHERE id = ?', [line1.card_id]);
      assert.strictEqual(card.status, 'void');
      const [[o]] = await gift.query('SELECT refunded_minor FROM gift_orders WHERE id = ?', [line1.order_id]);
      assert.strictEqual(o.refunded_minor, 3000);
      await post(`/admin/v/${VENUE.id}/orders/${line1.order_id}/lines/${line1.id}/refund`, {}, { auth: true });
      assert.strictEqual(dojo.refunds.length, 1, 'pressing refund twice does not pay twice');
    });

    await check('a voucher for a day next week is paid for now and sent then', async () => {
      const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const r = await post('/test-kitchen/buy', {
        design: String(design.id), amount: '', custom_amount: '42.50', send_to: 'recipient', recipient_name: 'Rhian',
        recipient_email: 'rhian@gift.test', when: 'later', deliver_date: day, deliver_time: '09:00', ...buyer,
      });
      assert.strictEqual(r.status, 303, r.text.slice(0, 300));
      const it = dojo.last();
      assert.strictEqual(it.amount.value, 4250, 'the typed amount');
      dojo.capture(it.id);
      const page = await get(new URL(it.config.redirectUrl).pathname);
      assert.ok(page.text.includes('We will email Rhian'), page.text.slice(0, 500));
      await sleep(1500);
      assert.strictEqual(mailTo('rhian@gift.test').length, 0, 'not yet');
      const [[l]] = await gift.query("SELECT * FROM gift_order_lines WHERE recipient_email = 'rhian@gift.test'");
      const s = await post(`/admin/v/${VENUE.id}/orders/${l.order_id}/lines/${l.id}/send-now`, {}, { auth: true });
      assert.strictEqual(s.status, 303);
      assert.strictEqual(mailTo('rhian@gift.test').length, 1, 'sent when asked');
    });

    await check('an experience is a voucher for one named thing, spent in one go', async () => {
      const [p] = await gift.query("INSERT INTO gift_products (office_id, name, description, price_minor, design_id) VALUES (?, 'Sunday lunch for two', 'Two courses each', 4800, ?)", [VENUE.id, design.id]);
      const page = await get(`/test-kitchen/buy/${p.insertId}`);
      assert.ok(page.text.includes('Sunday lunch for two'));
      const r = await post(`/test-kitchen/buy/${p.insertId}`, { design: String(design.id), send_to: 'buyer', buyer_email: 'priya@gift.test', buyer_name: 'Priya' });
      assert.strictEqual(r.status, 303, r.text.slice(0, 300));
      const it = dojo.last();
      assert.strictEqual(it.amount.value, 4800, 'the price comes from the product, not the form');
      dojo.capture(it.id);
      await get(new URL(it.config.redirectUrl).pathname);
      const [[card]] = await epos.query("SELECT * FROM epos_gift_cards WHERE label = 'Sunday lunch for two'");
      assert.ok(card, 'issued with its label');
      assert.strictEqual(card.kind, 'paper');
    });

    const [ev] = await gift.query(
      "INSERT INTO gift_events (office_id, public_id, title, starts_at, capacity) VALUES (?, 'evente2etest', 'Welsh wine tasting', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 DAY), 3)",
      [VENUE.id]
    );
    const [tt] = await gift.query("INSERT INTO gift_ticket_types (event_id, name, price_minor) VALUES (?, 'Tasting', 2800)", [ev.insertId]);

    await check('two tickets are bought, paid for, and sent with their codes', async () => {
      const r = await post('/test-kitchen/events/evente2etest', { [`qty_${tt.insertId}`]: '2', buyer_name: 'Dafydd', buyer_email: 'dafydd@gift.test' });
      assert.strictEqual(r.status, 303, r.text.slice(0, 300));
      const it = dojo.last();
      assert.strictEqual(it.amount.value, 5600);
      dojo.capture(it.id);
      await get(new URL(it.config.redirectUrl).pathname);
      assert.ok(await until(() => mailTo('dafydd@gift.test').find((m) => /tickets/i.test(m.subject))), 'the tickets email');
      const [t] = await gift.query('SELECT * FROM gift_tickets WHERE event_id = ?', [ev.insertId]);
      assert.strictEqual(t.length, 2);
    });

    await check('the last seat cannot be sold twice', async () => {
      const r = await post('/test-kitchen/events/evente2etest', { [`qty_${tt.insertId}`]: '2', buyer_name: 'Kate', buyer_email: 'kate@gift.test' });
      assert.strictEqual(r.status, 400);
      assert.ok(r.text.includes('Only 1 left'), r.text.slice(0, 400));
    });

    await check('the door lets a ticket in once, and says so the second time', async () => {
      const [[t]] = await gift.query('SELECT code FROM gift_tickets WHERE event_id = ? ORDER BY id LIMIT 1', [ev.insertId]);
      const scan = (code) => fetch(`${G}/admin/v/${VENUE.id}/door/${ev.insertId}/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ code }),
      }).then((r) => r.json());
      const first = await scan(t.code);
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      assert.strictEqual(first.in, 1);
      const second = await scan(t.code);
      assert.strictEqual(second.title, 'Already in');
      assert.strictEqual((await scan('ZZZZ-ZZZZ')).title, 'Not a ticket');
    });

    await check('the tickets page and PDF open from the buyer\'s link', async () => {
      const [[o]] = await gift.query("SELECT public_id FROM gift_orders WHERE kind = 'tickets' LIMIT 1");
      const r = await get(`/t/${o.public_id}`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('Welsh wine tasting'));
      assert.ok((await get(`/t/${o.public_id}/tickets.pdf`)).text.startsWith('%PDF'));
    });

    await check('five orders a day from one address, and no sixth', async () => {
      let last;
      for (let i = 0; i < 5; i++) {
        last = await post('/test-kitchen/buy', { design: String(design.id), amount: '2500', send_to: 'buyer', buyer_name: 'Greedy', buyer_email: 'greedy@gift.test' });
      }
      assert.strictEqual(last.status, 303);
      const sixth = await post('/test-kitchen/buy', { design: String(design.id), amount: '2500', send_to: 'buyer', buyer_name: 'Greedy', buyer_email: 'greedy@gift.test' });
      assert.strictEqual(sixth.status, 400);
      assert.ok(sixth.text.includes('a lot of orders'));
    });

    await check('an order nobody paid for is let go, and its payment cancelled at Dojo', async () => {
      const [[o]] = await gift.query("SELECT * FROM gift_orders WHERE buyer_email = 'greedy@gift.test' AND status = 'pending' ORDER BY id LIMIT 1");
      await gift.query('UPDATE gift_orders SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [o.id]);
      const gone = await until(async () => {
        const [[x]] = await gift.query('SELECT status FROM gift_orders WHERE id = ?', [o.id]);
        return x.status === 'cancelled';
      }, 10000);
      assert.ok(gone, 'cancelled by the sweep');
      assert.ok(dojo.cancelled.includes(o.intent_id), 'and at Dojo');
    });

    await check('a buyer who paid and closed the tab still gets their voucher', async () => {
      const r = await post('/test-kitchen/buy', { design: String(design.id), amount: '7500', send_to: 'buyer', buyer_name: 'Tom', buyer_email: 'tom@gift.test' });
      assert.strictEqual(r.status, 303);
      dojo.capture(dojo.last().id);
      assert.ok(await until(() => mailTo('tom@gift.test').find((m) => /voucher/i.test(m.subject)), 10000), 'the sweep found the payment and delivered');
    });

    await check('every email\'s inline styles survive intact', async () => {
      // A double quote inside style="..." (a font name, say) ends the attribute
      // there, and the colour and padding after it silently vanish.
      const sent = mails();
      assert.ok(sent.length >= 5, `${sent.length} emails captured`);
      for (const m of sent) {
        const broken = /style="[^"]*"(?![\s>\/])/.exec(m.html || '');
        assert.ok(!broken, `"${m.subject}" has a style attribute cut short: ${broken && broken[0].slice(0, 120)}`);
      }
    });

    await check('switched off, the shop is gone and its voucher links stop', async () => {
      assert.strictEqual((await post(`/admin/venues/${VENUE.id}/disable`, {}, { auth: true })).status, 303);
      assert.strictEqual((await get('/test-kitchen')).status, 404);
      assert.strictEqual((await get(`/v/${line1.view_token}`)).status, 404);
    });
  } finally {
    if (failed) {
      console.log('\n---- gift log ----\n' + S.giftProc.log().slice(-4000));
      console.log('\n---- epos log (tail) ----\n' + S.eposProc.log().slice(-2000));
    }
    await S.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
