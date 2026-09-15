/**
 * After the money: make what was bought, and send it when it is due.
 *
 * ORDER OF EVENTS for a paid order, each step safe to run again:
 *
 *   1. every voucher line becomes a gift card in the venue's EPOS -- the EPOS
 *      makes one card per reference however many times it is asked
 *   2. every ticket line becomes tickets here -- one row per (line, seat), so a
 *      second run finds them already there
 *   3. the buyer's receipt goes, once
 *   4. the venue is told, once
 *   5. anything due now is delivered; anything scheduled waits for the sweep
 *
 * "Once" is enforced by CLAIMING before sending: a conditional UPDATE that only
 * one caller can win. The return page and the background sweep both call
 * fulfil() for the same order within seconds of each other, and without the
 * claim a buyer would get two receipts and a recipient two vouchers.
 *
 * A send that fails is recorded and tried again later, each time a little
 * later than the last. A voucher somebody paid for is never silently dropped.
 */

const fs = require('fs');
const db = require('./db');
const epos = require('./epos');
const venues = require('./venues');
const mail = require('./mail');
const emails = require('./emails');
const pdf = require('./pdf');
const { qrPng } = require('./png');
const { stripsFor } = require('./strips');
const { token, ticketCode, addMonths, londonDate } = require('./util');
const config = require('./config');
const { ref } = require('./orders');

const BASE = () => config.BASE_URL;

const urls = {
  voucher: (line) => `${BASE()}/v/${line.view_token}`,
  tickets: (order) => `${BASE()}/t/${order.public_id}`,
  balance: (venue) => `${BASE()}/${venue.slug}/balance`,
  status: (venue, order) => `${BASE()}/${venue.slug}/paid/${order.public_id}`,
  admin: (venue, order) => `${BASE()}/admin/v/${venue.office_id}/orders/${order.id}`,
};

function log(what) {
  return (e) => console.error(`[fulfil] ${what}: ${e && e.message ? e.message : e}`);
}

async function audit(officeId, action, detail, actor = null) {
  await db.run(
    'INSERT INTO gift_audit (actor, office_id, action, detail) VALUES (?, ?, ?, ?)',
    [actor, officeId, action, detail ? JSON.stringify(detail).slice(0, 4000) : null]
  ).catch(() => {});
}

// ---- Making it -------------------------------------------------------------

async function issueCard(venue, order, line) {
  const expires = londonDate(addMonths(new Date(), venue.validity_months || 12));
  const hold = venue.hold_over_minor != null && line.unit_minor > venue.hold_over_minor;
  const usableFrom = hold ? new Date(Date.now() + (venue.hold_hours || 24) * 3600 * 1000) : null;
  const design = (line.design_id && await venues.design(venue.office_id, line.design_id))
    || (await venues.designs(venue.office_id, { onSale: false }))[0] || null;
  const r = await epos.issueCard(venue.office_id, {
    art_strip: await stripsFor(design),
    amount_minor: line.unit_minor,
    external_ref: `${ref(order)}/${line.line_no}`,
    label: line.kind === 'experience' ? line.label : null,
    recipient_name: line.recipient_name || null,
    expires_on: expires,
    usable_from: usableFrom ? usableFrom.toISOString() : null,
    single_use: line.kind === 'experience',
    notes: `${ref(order)} · bought online by ${order.buyer_name}`,
  });
  const c = r.card;
  await db.run(
    `UPDATE gift_order_lines
        SET card_id = ?, card_code = ?, expires_on = ?, usable_from = ?, wallet_url = ?,
            view_token = COALESCE(view_token, ?)
      WHERE id = ?`,
    [c.id, c.code, c.expires_on ? String(c.expires_on).slice(0, 10) : expires,
      c.usable_from ? new Date(c.usable_from) : null, r.wallet_url || null, token(16), line.id]
  );
}

async function issueTickets(order, line) {
  for (let seq = 1; seq <= line.quantity; seq++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.run(
          `INSERT INTO gift_tickets (order_id, line_id, event_id, ticket_type_id, seq, code, holder_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [order.id, line.id, line.event_id, line.ticket_type_id, seq, ticketCode(), order.buyer_name]
        );
        break;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
        // Already made on an earlier run: that is the idempotent case.
        if (/uq_gift_ticket_line/.test(e.message)) break;
        // Otherwise the random code collided. Draw another.
      }
    }
  }
}

async function fulfil(orderId) {
  const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [orderId]);
  if (!order || order.status !== 'paid') return;
  const venue = await venues.get(order.office_id);
  const lines = await db.all('SELECT * FROM gift_order_lines WHERE order_id = ? ORDER BY line_no', [order.id]);

  for (const line of lines) {
    if ((line.kind === 'voucher' || line.kind === 'experience') && !line.card_id && !line.voided_at) {
      await issueCard(venue, order, line);
    } else if (line.kind === 'ticket') {
      await issueTickets(order, line);
    }
  }
  await db.run('UPDATE gift_orders SET fulfilled_at = COALESCE(fulfilled_at, UTC_TIMESTAMP()) WHERE id = ?', [order.id]);

  await sendReceipt(order.id).catch(log(`receipt for ${order.id}`));
  await tellVenue(order.id).catch(log(`venue notice for ${order.id}`));
  await deliverOrder(order.id).catch(log(`delivery for ${order.id}`));
}

// ---- Sending it ------------------------------------------------------------

/** Claim a once-only column. True for exactly one caller. */
async function claim(column, orderId) {
  const r = await db.run(`UPDATE gift_orders SET ${column} = UTC_TIMESTAMP() WHERE id = ? AND ${column} IS NULL`, [orderId]);
  return r.affectedRows === 1;
}

async function unclaim(column, orderId) {
  await db.run(`UPDATE gift_orders SET ${column} = NULL WHERE id = ?`, [orderId]);
}

async function sendReceipt(orderId) {
  if (!(await claim('receipt_sent_at', orderId))) return;
  try {
    const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [orderId]);
    const venue = await venues.get(order.office_id);
    const brand = venues.brandOf(venue);
    const lines = await db.all('SELECT * FROM gift_order_lines WHERE order_id = ? ORDER BY line_no', [orderId]);
    const { html, text } = emails.receiptEmail({ brand, order, lines, ref: ref(order), statusUrl: urls.status(venue, order) });
    await mail.send({
      to: order.buyer_email, subject: `Your receipt from ${brand.name}`, html, text,
      fromName: brand.name, replyTo: venue.notify_email || undefined,
    });
  } catch (e) {
    await unclaim('receipt_sent_at', orderId);
    throw e;
  }
}

async function tellVenue(orderId) {
  const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [orderId]);
  const venue = await venues.get(order.office_id);
  if (!venue.notify_email) return;
  if (!(await claim('venue_told_at', orderId))) return;
  try {
    const brand = venues.brandOf(venue);
    const lines = await db.all('SELECT * FROM gift_order_lines WHERE order_id = ? ORDER BY line_no', [orderId]);
    const { html, text } = emails.venueSaleEmail({ brand, order, lines, ref: ref(order), adminUrl: urls.admin(venue, order) });
    await mail.send({ to: venue.notify_email, subject: `New sale ${ref(order)}: ${require('./util').money(order.total_minor, { always: true })}`, html, text, fromName: 'Vesopa Gift' });
  } catch (e) {
    await unclaim('venue_told_at', orderId);
    throw e;
  }
}

/**
 * Take a line for sending. Holding next_try_at ten minutes ahead is the claim:
 * nobody else will pick it up while this caller is sending, and if this caller
 * dies half way, the line comes back on its own in ten minutes.
 */
async function claimLine(lineId) {
  const r = await db.run(
    `UPDATE gift_order_lines SET next_try_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
      WHERE id = ? AND delivered_at IS NULL AND voided_at IS NULL
        AND (next_try_at IS NULL OR next_try_at <= UTC_TIMESTAMP())`,
    [lineId]
  );
  return r.affectedRows === 1;
}

async function failed(lineId, error) {
  await db.run(
    `UPDATE gift_order_lines
        SET delivery_attempts = delivery_attempts + 1,
            delivery_error = ?,
            next_try_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL LEAST(360, 5 * POW(2, delivery_attempts)) MINUTE)
      WHERE id = ?`,
    [String(error && error.message ? error.message : error).slice(0, 255), lineId]
  );
}

function readArt(design) {
  try {
    return fs.readFileSync(venues.designFile(design));
  } catch {
    return null;
  }
}

async function deliverVoucher(venue, order, line, { copyTo = null } = {}) {
  const brand = venues.brandOf(venue);
  const design = (line.design_id && await venues.design(venue.office_id, line.design_id))
    || (await venues.designs(venue.office_id, { onSale: false }))[0] || null;
  const art = readArt(design);
  const toBuyer = line.send_to === 'buyer';
  const viewUrl = urls.voucher(line);
  const balanceUrl = urls.balance(venue);
  const { html, text } = emails.voucherEmail({
    brand, order, line, viewUrl, balanceUrl, artCid: art ? 'art' : null, qrCid: 'qr', toBuyer,
  });
  const file = await pdf.voucherPdf({ brand, order, line, art, balanceUrl });
  const attachments = [
    ...(art ? [{ filename: 'voucher.jpg', content: art, cid: 'art' }] : []),
    { filename: 'code.png', content: qrPng(line.card_code, { scale: 6 }), cid: 'qr' },
    { filename: `${brand.name.replace(/[^\w &'-]/g, '')} gift voucher.pdf`, content: file, contentType: 'application/pdf' },
  ];
  const first = order.buyer_name.split(' ')[0];
  await mail.send({
    to: copyTo || (toBuyer ? order.buyer_email : line.recipient_email),
    subject: toBuyer ? `Your voucher for ${brand.name}` : `${first} sent you a gift for ${brand.name}`,
    html, text, attachments, fromName: brand.name, replyTo: venue.notify_email || undefined,
  });
  // A copy to somebody who already holds it changes nothing about the delivery.
  if (copyTo) return audit(venue.office_id, 'voucher.copied', { order: ref(order), line: line.line_no });
  await db.run('UPDATE gift_order_lines SET delivered_at = UTC_TIMESTAMP(), delivery_error = NULL WHERE id = ?', [line.id]);
  await audit(venue.office_id, 'voucher.delivered', { order: ref(order), line: line.line_no, to: toBuyer ? 'buyer' : 'recipient' });

  // A voucher that waited for a birthday: tell the buyer it has gone.
  if (!toBuyer && line.deliver_at) {
    const sent = emails.sentEmail({ brand, order, line });
    await mail.send({
      to: order.buyer_email, subject: `${line.recipient_name}'s voucher has been sent`,
      html: sent.html, text: sent.text, fromName: brand.name, replyTo: venue.notify_email || undefined,
    }).catch(log(`sent-notice for line ${line.id}`));
  }
}

async function deliverTickets(venue, order) {
  const brand = venues.brandOf(venue);
  const tickets = await db.all('SELECT * FROM gift_tickets WHERE order_id = ? ORDER BY line_id, seq', [order.id]);
  if (!tickets.length) throw new Error('no tickets were made for this order');
  const event = await db.one('SELECT * FROM gift_events WHERE id = ?', [tickets[0].event_id]);
  const types = await db.all('SELECT * FROM gift_ticket_types WHERE event_id = ?', [event.id]);
  const typesById = Object.fromEntries(types.map((t) => [t.id, t]));
  const qrCids = tickets.map((_, i) => `qr${i}`);
  const { html, text } = emails.ticketsEmail({ brand, order, event, tickets, typesById, viewUrl: urls.tickets(order), qrCids });
  const file = await pdf.ticketsPdf({ brand, event, tickets, typesById, holder: order.buyer_name });
  await mail.send({
    to: order.buyer_email,
    subject: `Your tickets: ${event.title}`,
    html, text,
    attachments: [
      ...tickets.map((t, i) => ({ filename: `ticket-${i + 1}.png`, content: qrPng(t.code, { scale: 5 }), cid: qrCids[i] })),
      { filename: `${event.title.replace(/[^\w &'-]/g, '')} tickets.pdf`, content: file, contentType: 'application/pdf' },
    ],
    fromName: brand.name, replyTo: venue.notify_email || undefined,
  });
}

/** Everything on one order that is due now. */
async function deliverOrder(orderId) {
  const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [orderId]);
  if (!order || order.status !== 'paid') return;
  const venue = await venues.get(order.office_id);
  const lines = await db.all(
    `SELECT * FROM gift_order_lines
      WHERE order_id = ? AND delivered_at IS NULL AND voided_at IS NULL
        AND (deliver_at IS NULL OR deliver_at <= UTC_TIMESTAMP())
        AND (next_try_at IS NULL OR next_try_at <= UTC_TIMESTAMP())
      ORDER BY line_no`,
    [orderId]
  );

  const ticketLines = lines.filter((l) => l.kind === 'ticket');
  if (ticketLines.length) {
    const owned = [];
    for (const l of ticketLines) if (await claimLine(l.id)) owned.push(l);
    if (owned.length === ticketLines.length) {
      try {
        await deliverTickets(venue, order);
        await db.run(
          `UPDATE gift_order_lines SET delivered_at = UTC_TIMESTAMP(), delivery_error = NULL
            WHERE order_id = ? AND kind = 'ticket'`,
          [order.id]
        );
        await audit(venue.office_id, 'tickets.delivered', { order: ref(order) });
      } catch (e) {
        for (const l of owned) await failed(l.id, e);
        throw e;
      }
    }
  }

  for (const line of lines.filter((l) => l.kind !== 'ticket' && l.card_id)) {
    if (!(await claimLine(line.id))) continue;
    try {
      await deliverVoucher(venue, order, line);
    } catch (e) {
      await failed(line.id, e);
      log(`voucher line ${line.id}`)(e);
    }
  }
}

/** Resend a delivered voucher, or send one now instead of on its day. */
async function sendLineNow(order, line) {
  const venue = await venues.get(order.office_id);
  await db.run('UPDATE gift_order_lines SET deliver_at = NULL, delivered_at = NULL, next_try_at = NULL WHERE id = ?', [line.id]);
  const fresh = await db.one('SELECT * FROM gift_order_lines WHERE id = ?', [line.id]);
  if (fresh.kind === 'ticket') {
    return deliverOrder(order.id);
  }
  if (!(await claimLine(fresh.id))) throw new Error('That voucher is being sent right now');
  try {
    await deliverVoucher(venue, order, fresh);
  } catch (e) {
    await failed(fresh.id, e);
    throw e;
  }
}

/** The voucher again, to an address that already holds it, with nothing else changed. */
async function copyLineTo(order, line, to) {
  const venue = await venues.get(order.office_id);
  await deliverVoucher(venue, order, line, { copyTo: to });
}

module.exports = { fulfil, deliverOrder, sendLineNow, copyLineTo, sendReceipt, tellVenue, issueCard, issueTickets, audit, urls };
