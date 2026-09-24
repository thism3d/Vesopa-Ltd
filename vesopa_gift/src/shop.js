/**
 * The venue's shop: the pages a member of the public sees.
 *
 * A shop exists only for a venue the owner has switched on. Everything else
 * answers 404 -- a venue without the product cannot find out it exists by
 * guessing an address, and there is no index of venues anywhere.
 *
 * A buyer signs nothing in. The only things that identify an order to a browser
 * are random ids in URLs: the order's own on the confirmation page, and a
 * separate token per voucher on the link the recipient is sent. Neither can be
 * walked from one order to the next.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const epos = require('./epos');
const venues = require('./venues');
const orders = require('./orders');
const payments = require('./payments');
const pdf = require('./pdf');
const { svg: qrSvg } = require('./qr');
const config = require('./config');
const { limiter } = require('./security');
const util = require('./util');

const router = express.Router();

/** What every shop template needs about the venue it is drawing. */
function theme(brand) {
  const accent = brand.primary;
  const heading = brand.fonts && brand.fonts.heading;
  const safeFamily = heading && /^[\w\s-]{1,60}$/.test(heading.family || '') ? heading.family : null;
  const origin = require('./security').BACKOFFICE;
  const faces = safeFamily
    ? (heading.faces || []).filter((f) => String(f.url || '').startsWith(`${origin}/`)
      && !/["'()\\\s]/.test(String(f.url)) && Number.isInteger(Number(f.weight))).slice(0, 4)
    : [];
  return {
    accent,
    onAccent: util.onColour(accent),
    accentInk: util.inkOf(accent),
    headingFamily: faces.length ? safeFamily : null,
    faces,
  };
}

function locals(venue, extra = {}) {
  const brand = venues.brandOf(venue);
  return {
    venue,
    brand,
    hero: venues.heroOf(venue),
    theme: theme(brand),
    initials: util.initials(brand.name),
    designUrl: venues.designUrl,
    money: util.money,
    when: util.when,
    dateLong: util.dateLong,
    scripts: ['/js/shop.js'],
    title: brand.name,
    ...extra,
  };
}

function notFound(res) {
  return res.status(404).render('shop/message', {
    title: 'Not found', heading: 'There is no shop at this address',
    body: 'A venue\u2019s shop lives at gift.vesopa.com/<venue>. Check the name on the link you were given \u2014 a letter out and the shop is not found.',
    home: config.BASE_URL,
  });
}

async function withVenue(req, res, next) {
  try {
    const venue = await venues.bySlug(req.params.slug);
    if (!venue) return notFound(res);
    req.venue = venue;
    next();
  } catch (e) { next(e); }
}

async function shopData(venue) {
  const designs = await venues.designs(venue.office_id);
  const products = await db.all(
    'SELECT * FROM gift_products WHERE office_id = ? AND on_sale = 1 ORDER BY sort, id',
    [venue.office_id]
  );
  for (const p of products) p.design = designs.find((d) => d.id === p.design_id) || null;
  const events = await db.all(
    `SELECT * FROM gift_events
      WHERE office_id = ? AND on_sale = 1 AND cancelled_at IS NULL AND starts_at > UTC_TIMESTAMP()
        AND (sales_end_at IS NULL OR sales_end_at > UTC_TIMESTAMP())
      ORDER BY starts_at LIMIT 6`,
    [venue.office_id]
  );
  for (const e of events) {
    const types = await db.all('SELECT * FROM gift_ticket_types WHERE event_id = ? AND on_sale = 1 ORDER BY price_minor', [e.id]);
    e.fromPrice = types.length ? types[0].price_minor : null;
    const left = await orders.ticketsLeft(db.pool, e, types);
    e.left = left.overall;
    e.imageUrl = e.image ? imageUrl(venue, e.image) : null;
  }
  return { designs, products, events };
}

function imageUrl(venue, image) {
  if (String(image).startsWith('builtin:')) return `/img/designs/${String(image).slice(8)}.jpg`;
  return `/u/${venue.office_id}/${encodeURIComponent(image)}`;
}

// ---- The shop ----------------------------------------------------------------

router.get('/:slug', withVenue, async (req, res, next) => {
  try {
    const venue = req.venue;
    const data = await shopData(venue);
    res.render('shop/home', locals(venue, {
      ...data,
      amounts: venues.amountsOf(venue),
      canPay: venues.canTakePayments(venue),
      title: `${venues.brandOf(venue).name} — gift vouchers`,
    }));
  } catch (e) { next(e); }
});

async function buyPage(req, res, { product, values = {}, error = null, field = null, status = 200 }) {
  const venue = req.venue;
  if (req.account) {
    values = { buyer_name: req.account.name, buyer_email: req.account.email, ...values };
  }
  const designs = await venues.designs(venue.office_id);
  const productDesign = product
    ? (designs.find((d) => d.id === product.design_id) || designs[0] || null)
    : null;
  const today = util.londonDate(new Date());
  const lastDay = util.londonDate(new Date(Date.now() + venue.schedule_max_days * 86400000));
  // The card is issued the moment it is paid for, so its clock starts today
  // even when it is emailed later (fulfil.issueCard).
  const validUntil = util.addMonths(new Date(), venue.validity_months || 12)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
  res.status(status).render('shop/buy', locals(venue, {
    designs, product, productDesign, values, error, field, today, lastDay, validUntil,
    amounts: venues.amountsOf(venue),
    title: `${product ? product.name : 'A gift voucher'} — ${venues.brandOf(venue).name}`,
  }));
}

async function productFor(venue, id) {
  if (!id) return null;
  return db.one('SELECT * FROM gift_products WHERE id = ? AND office_id = ? AND on_sale = 1', [Number(id), venue.office_id]);
}

router.get('/:slug/buy', withVenue, async (req, res, next) => {
  try {
    if (!venues.canTakePayments(req.venue)) return res.redirect(303, `/${req.venue.slug}`);
    await buyPage(req, res, { values: { design: req.query.design, amount: req.query.amount } });
  } catch (e) { next(e); }
});

router.get('/:slug/buy/:productId', withVenue, async (req, res, next) => {
  try {
    const product = await productFor(req.venue, req.params.productId);
    if (!product) return notFound(res);
    if (!venues.canTakePayments(req.venue)) return res.redirect(303, `/${req.venue.slug}`);
    await buyPage(req, res, { product });
  } catch (e) { next(e); }
});

const buyLimit = limiter({ perMinute: 12 });

async function buy(req, res, next) {
  const venue = req.venue;
  const product = req.params.productId ? await productFor(venue, req.params.productId) : null;
  if (req.params.productId && !product) return notFound(res);
  try {
    if (!venues.canTakePayments(venue)) throw new orders.OrderError('This shop cannot take payments just now');
    const designs = await venues.designs(venue.office_id);
    const design = designs.find((d) => String(d.id) === String(req.body.design))
      || (product ? designs.find((d) => d.id === product.design_id) || designs[0] : null);
    const validated = orders.validateVoucher(req.body, {
      venue, amounts: venues.amountsOf(venue), design, product,
    });
    const order = await orders.createVoucherOrder(venue, validated, req.ip);
    if (req.account) await db.run('UPDATE gift_orders SET account_sub = ? WHERE id = ?', [req.account.sub, order.id]);
    const url = await payments.startPayment(venue, order);
    res.redirect(303, url);
  } catch (e) {
    if (e instanceof orders.OrderError || (e.name === 'EposError')) {
      return buyPage(req, res, {
        product, values: req.body, status: 400,
        error: e instanceof orders.OrderError ? e.message : 'We could not start the payment just now. Nothing has been taken — please try again in a minute.',
        field: e.field || null,
      }).catch(next);
    }
    next(e);
  }
}

router.post('/:slug/buy', buyLimit, withVenue, buy);
router.post('/:slug/buy/:productId', buyLimit, withVenue, buy);

// ---- After Dojo -----------------------------------------------------------------

async function orderFor(venue, publicId) {
  if (!/^[a-z0-9]{24}$/.test(String(publicId || ''))) return null;
  return db.one('SELECT * FROM gift_orders WHERE public_id = ? AND office_id = ?', [publicId, venue.office_id]);
}

router.get('/:slug/paid/:publicId', withVenue, async (req, res, next) => {
  try {
    const venue = req.venue;
    let order = await orderFor(venue, req.params.publicId);
    if (!order) return notFound(res);
    if (order.status === 'pending') order = await payments.refresh(order).catch(() => order);

    const ref = orders.ref(order);
    if (order.status !== 'paid' && order.status !== 'refunded') {
      return res.render('shop/pending', locals(venue, {
        order, ref, gone: order.status === 'cancelled' || order.status === 'failed',
        title: `Order ${ref} — ${venues.brandOf(venue).name}`,
      }));
    }

    const lines = await db.all('SELECT * FROM gift_order_lines WHERE order_id = ? ORDER BY line_no', [order.id]);
    const voucherLine = lines.find((l) => l.kind !== 'ticket') || null;
    const design = voucherLine && voucherLine.design_id ? await venues.design(venue.office_id, voucherLine.design_id) : null;
    let headline;
    if (voucherLine) {
      if (voucherLine.send_to === 'buyer') {
        headline = `Your voucher is on its way to <strong>${util.esc(order.buyer_email)}</strong>, with a copy to print.`;
      } else if (voucherLine.deliver_at && new Date(voucherLine.deliver_at) > new Date()) {
        headline = `We will email ${util.esc(voucherLine.recipient_name)} their voucher on <strong>${util.esc(util.when(voucherLine.deliver_at))}</strong>. Your receipt is on its way to ${util.esc(order.buyer_email)}.`;
      } else {
        headline = `${util.esc(voucherLine.recipient_name)}’s voucher is on its way to ${util.esc(voucherLine.recipient_email)}. Your receipt is on its way to ${util.esc(order.buyer_email)}.`;
      }
    } else {
      headline = `Your tickets are on their way to <strong>${util.esc(order.buyer_email)}</strong>, each with its own code for the door.`;
    }

    res.render('shop/paid', locals(venue, {
      order, ref, lines, voucherLine, design, headline,
      voucherUrl: voucherLine && voucherLine.send_to === 'buyer' && voucherLine.view_token ? `/v/${voucherLine.view_token}` : null,
      ticketsUrl: order.kind === 'tickets' ? `/t/${order.public_id}` : null,
      title: `Paid — ${venues.brandOf(venue).name}`,
    }));
  } catch (e) { next(e); }
});

router.get('/:slug/paid/:publicId/status.json', withVenue, async (req, res, next) => {
  try {
    let order = await orderFor(req.venue, req.params.publicId);
    if (!order) return res.status(404).json({ error: 'not found' });
    if (order.status === 'pending') order = await payments.refresh(order).catch(() => order);
    res.set('Cache-Control', 'no-store').json({ status: order.status });
  } catch (e) { next(e); }
});

router.get('/:slug/pay/:publicId', withVenue, async (req, res, next) => {
  try {
    const order = await orderFor(req.venue, req.params.publicId);
    if (!order) return notFound(res);
    if (order.status !== 'pending') return res.redirect(303, `/${req.venue.slug}/paid/${order.public_id}`);
    res.redirect(303, await payments.startPayment(req.venue, order));
  } catch (e) { next(e); }
});

// ---- Balance ------------------------------------------------------------------

router.get('/:slug/balance', withVenue, (req, res) => {
  res.render('shop/balance', locals(req.venue, { code: '', card: null, notFound: false, title: `Check a balance — ${venues.brandOf(req.venue).name}` }));
});

router.post('/:slug/balance', limiter({ perMinute: 10 }), withVenue, async (req, res, next) => {
  const venue = req.venue;
  const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const formatted = code.length === 12 ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : String(req.body.code || '').trim().toUpperCase();
  const view = { code: formatted, card: null, notFound: false, lastUsed: null, meterClass: 'w-0', title: `Check a balance — ${venues.brandOf(venue).name}` };
  try {
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(formatted)) {
      view.notFound = true;
      return res.status(404).render('shop/balance', locals(venue, view));
    }
    const r = await epos.lookup(venue.office_id, formatted);
    view.card = r.card;
    view.lastUsed = r.last_used_at;
    const pct = r.card.initial_minor ? Math.round((r.card.balance_minor / r.card.initial_minor) * 20) * 5 : 0;
    view.meterClass = `w-${Math.max(0, Math.min(100, pct))}`;
    res.render('shop/balance', locals(venue, view));
  } catch (e) {
    if (e.name === 'EposError' && e.status === 404) {
      view.notFound = true;
      return res.status(404).render('shop/balance', locals(venue, view));
    }
    next(e);
  }
});

router.get('/:slug/terms', withVenue, (req, res) => {
  res.render('shop/terms', locals(req.venue, { title: `Terms — ${venues.brandOf(req.venue).name}` }));
});

// ---- Events -------------------------------------------------------------------

async function eventFor(venue, publicId) {
  if (!/^[a-z0-9]{12}$/.test(String(publicId || ''))) return null;
  return db.one('SELECT * FROM gift_events WHERE public_id = ? AND office_id = ?', [publicId, venue.office_id]);
}

async function eventPage(req, res, event, { values = {}, error = null, field = null, status = 200 } = {}) {
  const venue = req.venue;
  if (req.account) values = { buyer_name: req.account.name, buyer_email: req.account.email, ...values };
  const types = await db.all('SELECT * FROM gift_ticket_types WHERE event_id = ? AND on_sale = 1 ORDER BY sort, id', [event.id]);
  const left = await orders.ticketsLeft(db.pool, event, types);
  event.imageUrl = event.image ? imageUrl(venue, event.image) : null;
  let closed = null;
  if (event.cancelled_at) closed = 'This event has been cancelled.';
  else if (!event.on_sale) closed = 'Tickets are not on sale for this event.';
  else if (new Date(event.starts_at) < new Date()) closed = 'This event has already started.';
  else if (event.sales_end_at && new Date(event.sales_end_at) < new Date()) closed = 'Ticket sales for this event have closed.';
  else if (left.overall <= 0) closed = 'This event is sold out.';
  else if (!venues.canTakePayments(venue)) closed = 'Tickets cannot be bought online just now. Ask at the venue.';
  res.status(status).render('shop/event', locals(venue, {
    event, types, left, closed, values, error, field, maxPerOrder: orders.MAX_TICKETS_PER_ORDER,
    title: `${event.title} — ${venues.brandOf(venue).name}`,
  }));
}

router.get('/:slug/events/:eventId', withVenue, async (req, res, next) => {
  try {
    const event = await eventFor(req.venue, req.params.eventId);
    if (!event) return notFound(res);
    await eventPage(req, res, event);
  } catch (e) { next(e); }
});

router.post('/:slug/events/:eventId', buyLimit, withVenue, async (req, res, next) => {
  const venue = req.venue;
  const event = await eventFor(venue, req.params.eventId).catch(() => null);
  if (!event) return notFound(res);
  try {
    if (!venues.canTakePayments(venue)) throw new orders.OrderError('Tickets cannot be bought online just now');
    const order = await orders.createTicketOrder(venue, event, req.body, req.ip);
    if (req.account) await db.run('UPDATE gift_orders SET account_sub = ? WHERE id = ?', [req.account.sub, order.id]);
    res.redirect(303, await payments.startPayment(venue, order));
  } catch (e) {
    if (e instanceof orders.OrderError || e.name === 'EposError') {
      return eventPage(req, res, event, {
        values: req.body, status: 400, field: e.field || null,
        error: e instanceof orders.OrderError ? e.message : 'We could not start the payment just now. Nothing has been taken — please try again in a minute.',
      }).catch(next);
    }
    next(e);
  }
});

// ---- What the recipient and the ticket holder open ------------------------------

async function lineByToken(t) {
  if (!/^[a-f0-9]{32}$/.test(String(t || ''))) return null;
  return db.one('SELECT * FROM gift_order_lines WHERE view_token = ?', [t]);
}

router.get('/v/:token', async (req, res, next) => {
  try {
    const line = await lineByToken(req.params.token);
    if (!line) return notFound(res);
    const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [line.order_id]);
    const venue = await venues.get(order.office_id);
    if (!venue || !venue.enabled || !line.card_code) return notFound(res);
    const design = line.design_id ? await venues.design(venue.office_id, line.design_id) : null;
    let balance = null;
    let state = null;
    try {
      const r = await epos.card(venue.office_id, line.card_id);
      balance = r.card.balance_minor;
      if (r.card.status === 'void') state = 'This voucher has been cancelled.';
      else if (r.card.status === 'redeemed') state = 'This voucher has been spent.';
    } catch { /* the page still shows the code */ }
    if (line.voided_at) state = 'This voucher has been cancelled.';
    res.set('Cache-Control', 'no-store');
    res.render('shop/voucher', locals(venue, {
      line, order, design, balance, state,
      buyerFirst: order.buyer_name.split(' ')[0],
      notYet: line.usable_from && new Date(line.usable_from) > new Date(),
      qrSvg: qrSvg(line.card_code, { size: 132 }),
      title: `Your voucher — ${venues.brandOf(venue).name}`,
    }));
  } catch (e) { next(e); }
});

router.get('/v/:token/voucher.pdf', async (req, res, next) => {
  try {
    const line = await lineByToken(req.params.token);
    if (!line || !line.card_code) return notFound(res);
    const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [line.order_id]);
    const venue = await venues.get(order.office_id);
    if (!venue || !venue.enabled) return notFound(res);
    const design = line.design_id ? await venues.design(venue.office_id, line.design_id) : null;
    const art = pdf.readImage(venues.designFile(design));
    const file = await pdf.voucherPdf({
      brand: venues.brandOf(venue), order, line, art, balanceUrl: `${config.BASE_URL}/${venue.slug}/balance`,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="gift-voucher.pdf"');
    res.set('Cache-Control', 'no-store');
    res.send(file);
  } catch (e) { next(e); }
});

async function ticketOrder(publicId) {
  if (!/^[a-z0-9]{24}$/.test(String(publicId || ''))) return null;
  const order = await db.one("SELECT * FROM gift_orders WHERE public_id = ? AND kind = 'tickets'", [publicId]);
  if (!order || (order.status !== 'paid' && order.status !== 'refunded')) return null;
  return order;
}

router.get('/t/:publicId', async (req, res, next) => {
  try {
    const order = await ticketOrder(req.params.publicId);
    if (!order) return notFound(res);
    const venue = await venues.get(order.office_id);
    const tickets = await db.all('SELECT * FROM gift_tickets WHERE order_id = ? ORDER BY line_id, seq', [order.id]);
    if (!tickets.length) return notFound(res);
    const event = await db.one('SELECT * FROM gift_events WHERE id = ?', [tickets[0].event_id]);
    const types = await db.all('SELECT * FROM gift_ticket_types WHERE event_id = ?', [event.id]);
    res.set('Cache-Control', 'no-store');
    res.render('shop/tickets', locals(venue, {
      order, event, tickets,
      typesById: Object.fromEntries(types.map((t) => [t.id, t])),
      qrs: tickets.map((t) => qrSvg(t.code, { size: 190 })),
      title: `Your tickets — ${event.title}`,
    }));
  } catch (e) { next(e); }
});

router.get('/t/:publicId/tickets.pdf', async (req, res, next) => {
  try {
    const order = await ticketOrder(req.params.publicId);
    if (!order) return notFound(res);
    const venue = await venues.get(order.office_id);
    const tickets = await db.all("SELECT * FROM gift_tickets WHERE order_id = ? AND status <> 'void' ORDER BY line_id, seq", [order.id]);
    if (!tickets.length) return notFound(res);
    const event = await db.one('SELECT * FROM gift_events WHERE id = ?', [tickets[0].event_id]);
    const types = await db.all('SELECT * FROM gift_ticket_types WHERE event_id = ?', [event.id]);
    const file = await pdf.ticketsPdf({
      brand: venues.brandOf(venue), event, tickets,
      typesById: Object.fromEntries(types.map((t) => [t.id, t])), holder: order.buyer_name,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="tickets.pdf"');
    res.set('Cache-Control', 'no-store');
    res.send(file);
  } catch (e) { next(e); }
});

// ---- A venue's own pictures ------------------------------------------------------

router.get('/u/:officeId/:file', (req, res) => {
  const office = String(Number(req.params.officeId));
  const file = path.basename(String(req.params.file));
  if (!/^[a-z0-9-]{8,80}\.(jpg|jpeg|png|webp)$/i.test(file)) return res.status(404).end();
  const full = path.join(config.UPLOADS_DIR, office, file);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(full);
});

module.exports = { shopRouter: router, theme, locals };
