/**
 * The staff console, at /admin.
 *
 * WHO GETS IN is decided by Vesopa Auth, not here. Vesopa Gift's client has
 * self-enrolment switched off, so Auth itself refuses anybody the owner has not
 * invited; what arrives here has already been let through, with the roles Auth
 * gave them. A person with no role in this application is shown a closed door.
 *
 * WHAT THEY SEE follows the role:
 *
 *   owner    every venue, the switch for each, and who manages which
 *   support  every venue, to find, resend and refund; no switches
 *   venue    only the venues the owner has named for their verified email,
 *            and only while those venues are switched on
 *
 * Every check is on the ROUTE. The rail hides what a role cannot use, and the
 * route refuses it anyway -- a hidden link is a layout decision, not a lock.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const epos = require('./epos');
const venues = require('./venues');
const session = require('./session');
const { createClient } = require('./oidc');
const config = require('./config');
const payments = require('./payments');
const fulfil = require('./fulfil');
const orders = require('./orders');
const util = require('./util');

const router = express.Router();

const oidc = createClient({
  issuer: config.AUTH_ISSUER,
  clientId: config.AUTH_CLIENT_ID,
  clientSecret: config.AUTH_CLIENT_SECRET,
  redirectUri: `${config.BASE_URL}/admin/callback`,
});
const peopleUrl = config.AUTH_CLIENT_ID ? `${config.AUTH_ISSUER}/developers/a/${config.AUTH_CLIENT_ID}/people` : null;
const shopHost = config.BASE_URL.replace(/^https?:\/\//, '');
const TEST_OFFICES = new Set(String(process.env.GIFT_TEST_OFFICES || '9').split(',').map((s) => Number(s.trim())));

// ---- Flash messages ---------------------------------------------------------
//
// In a short-lived cookie, not a query string: a message in a URL is a message
// anybody can put in a link, and "your account is suspended, ring this number"
// is exactly the kind of thing that gets put there.

function flash(res, kind, text) {
  res.cookie('vg_flash', Buffer.from(JSON.stringify({ kind, text: String(text).slice(0, 300) })).toString('base64url'), {
    httpOnly: true, sameSite: 'lax', secure: config.production, path: '/admin', maxAge: 60000,
  });
}

function takeFlash(req, res) {
  const raw = req.cookies && req.cookies.vg_flash;
  if (!raw) return null;
  res.clearCookie('vg_flash', { path: '/admin' });
  try {
    const f = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return f.kind === 'ok' || f.kind === 'bad' ? { kind: f.kind, text: String(f.text) } : null;
  } catch {
    return null;
  }
}

// ---- Every request ----------------------------------------------------------

router.use(async (req, res, next) => {
  try {
    req.session = await session.read(req);
    res.set('Cache-Control', 'no-store');
    next();
  } catch (e) { next(e); }
});

router.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (!req.session) return res.redirect(303, '/admin');
  if (!session.csrfOk(req, req.session)) {
    if (req.path.endsWith('/scan')) return res.status(403).json({ ok: false, title: 'Reload this page', detail: 'It was open too long.' });
    return res.status(403).render('admin/noaccess', {
      session: req.session, heading: 'That did not go through', body: 'The page had been open too long. Go back, reload it and try again.',
    });
  }
  next();
});

function page(req, res, view, data = {}) {
  res.render(`admin/${view}`, {
    session: req.session,
    peopleUrl,
    shopHost,
    flash: takeFlash(req, res),
    money: util.money,
    when: util.when,
    placed: util.placed,
    dateLong: util.dateLong,
    designUrl: venues.designUrl,
    myVenues: req.myVenues || [],
    title: 'Vesopa Gift',
    ...data,
  });
}

async function audit(req, action, detail, officeId = null) {
  await fulfil.audit(officeId, action, detail, req.session ? req.session.email : null);
}

async function myVenues(email) {
  return db.all(
    `SELECT v.office_id, v.name FROM gift_staff s JOIN gift_venues v ON v.office_id = s.office_id
      WHERE s.email = ? AND v.enabled = 1 ORDER BY v.name`,
    [String(email || '').toLowerCase()]
  );
}

async function landing(s) {
  if (s.everyVenue) return '/admin/venues';
  const mine = await myVenues(s.email);
  return mine.length ? `/admin/v/${mine[0].office_id}` : '/admin/none';
}

function signedIn(req, res, next) {
  if (!req.session) return res.redirect(303, '/admin');
  next();
}

function everyVenue(req, res, next) {
  if (!req.session.everyVenue) return res.status(404).render('admin/noaccess', { session: req.session, heading: 'Not yours to see', body: 'That page is for the people who look after every venue.' });
  next();
}

function ownerOnly(req, res, next) {
  if (!req.session.isOwner) return res.status(403).render('admin/noaccess', { session: req.session, heading: 'Only the owner can do that', body: 'Ask the owner of Vesopa Gift.' });
  next();
}

// ---- Signing in --------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    if (req.session) return res.redirect(303, await landing(req.session));
    const error = req.query.error === 'signin'
      ? 'That sign-in did not work. Try again, and if it keeps happening, make sure you have been invited.'
      : null;
    res.render('admin/signin', { error, ready: oidc.enabled });
  } catch (e) { next(e); }
});

router.get('/start', (req, res) => {
  if (!oidc.enabled) return res.redirect(303, '/admin');
  res.redirect(303, oidc.begin().url);
});

router.get('/callback', async (req, res) => {
  try {
    const person = await oidc.complete(req.query);
    if (!person.roles.some((r) => ['owner', 'support', 'venue'].includes(r))) {
      return res.status(403).render('admin/noaccess', {
        session: null, heading: 'You are in, but there is nothing for you yet',
        body: 'Your Vesopa account has been let in to Vesopa Gift without a role. Ask the owner to give you one.',
      });
    }
    if (!person.email) {
      return res.status(403).render('admin/noaccess', {
        session: null, heading: 'Your email address is not confirmed',
        body: 'Sign in to your Vesopa account with an emailed code once, then come back.',
      });
    }
    await session.create(res, person, req.ip);
    await fulfil.audit(null, 'admin.signin', { roles: person.roles }, person.email);
    res.redirect(303, '/admin');
  } catch (e) {
    console.warn(`[admin] sign-in failed: ${e.message}`);
    res.redirect(303, '/admin?error=signin');
  }
});

router.post('/signout', async (req, res) => {
  await session.destroy(req, res);
  res.redirect(303, '/admin');
});

router.get('/none', signedIn, (req, res) => {
  res.render('admin/noaccess', {
    session: req.session, heading: 'No venue has been named for you yet',
    body: 'You are signed in. When the owner names you on a venue that is switched on, it will be here.',
  });
});

// ---- The owner's view --------------------------------------------------------

router.get('/venues', signedIn, everyVenue, async (req, res, next) => {
  try {
    const list = await epos.venues();
    const rows = await db.all('SELECT * FROM gift_venues');
    const byId = Object.fromEntries(rows.map((r) => [r.office_id, r]));
    const sold = await db.all(
      `SELECT office_id, COALESCE(SUM(total_minor - refunded_minor), 0) AS n FROM gift_orders
        WHERE kind = 'voucher' AND status IN ('paid', 'refunded') AND paid_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
        GROUP BY office_id`
    );
    const soldBy = Object.fromEntries(sold.map((r) => [r.office_id, Number(r.n)]));
    const tix = await db.all(
      `SELECT o.office_id, COUNT(*) AS n FROM gift_tickets t JOIN gift_orders o ON o.id = t.order_id
        WHERE t.status IN ('valid', 'used') AND t.created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
        GROUP BY o.office_id`
    );
    const tixBy = Object.fromEntries(tix.map((r) => [r.office_id, Number(r.n)]));

    const out = [];
    for (const v of list) {
      const g = byId[v.id];
      const enabled = !!(g && g.enabled);
      let outstanding = null;
      if (enabled) {
        outstanding = await epos.summary(v.id, 1).then((s) => s.outstanding_minor).catch(() => null);
      }
      const name = (v.brand && v.brand.name) || v.name;
      out.push({
        id: v.id, name, enabled, slug: g ? g.slug : null, suggestedSlug: venues.slugify(name),
        payments: v.payments || { source: 'none' }, sold30: soldBy[v.id] || 0, outstanding,
        tickets30: tixBy[v.id] || 0, test: TEST_OFFICES.has(v.id),
      });
    }
    out.sort((a, b) => (b.enabled - a.enabled) || (b.test - a.test) || a.name.localeCompare(b.name));
    const totals = {
      on: out.filter((r) => r.enabled).length,
      sold30: out.reduce((s, r) => s + r.sold30, 0),
      outstanding: out.reduce((s, r) => s + (r.outstanding || 0), 0),
      tickets30: out.reduce((s, r) => s + r.tickets30, 0),
    };
    const staff = await db.all('SELECT s.*, v.name AS venueName FROM gift_staff s LEFT JOIN gift_venues v ON v.office_id = s.office_id ORDER BY v.name, s.email');
    page(req, res, 'venues', { title: 'Venues', rows: out, totals, staff });
  } catch (e) { next(e); }
});

router.post('/venues/:officeId/enable', signedIn, ownerOnly, async (req, res, next) => {
  try {
    const ev = await epos.venue(Number(req.params.officeId));
    await venues.ensure(ev);
    await db.run(
      'UPDATE gift_venues SET enabled = 1, enabled_at = UTC_TIMESTAMP(), enabled_by = ? WHERE office_id = ?',
      [req.session.email, ev.id]
    );
    await venues.refreshBrand(ev.id).catch(() => {});
    const v = await venues.get(ev.id);
    await audit(req, 'venue.enabled', { slug: v.slug }, ev.id);
    flash(res, 'ok', `${v.name || ev.name} is live at ${shopHost}/${v.slug}.`);
    res.redirect(303, '/admin/venues');
  } catch (e) { next(e); }
});

router.post('/venues/:officeId/disable', signedIn, ownerOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.officeId);
    await db.run('UPDATE gift_venues SET enabled = 0 WHERE office_id = ?', [id]);
    await audit(req, 'venue.disabled', null, id);
    flash(res, 'ok', 'Switched off. Its shop is gone; vouchers already sold still work at the till.');
    res.redirect(303, '/admin/venues');
  } catch (e) { next(e); }
});

router.post('/staff', signedIn, ownerOnly, async (req, res, next) => {
  try {
    const id = Number(req.body.office_id);
    const email = util.clean(req.body.email, 190).toLowerCase();
    if (!util.isEmail(email)) {
      flash(res, 'bad', 'That email address does not look right.');
      return res.redirect(303, '/admin/venues');
    }
    const ev = await epos.venue(id);
    await venues.ensure(ev);
    await db.run('INSERT IGNORE INTO gift_staff (office_id, email, created_by) VALUES (?, ?, ?)', [id, email, req.session.email]);
    await audit(req, 'staff.added', { email }, id);
    flash(res, 'ok', `${email} can manage ${ev.name} once they sign in with that address.`);
    res.redirect(303, '/admin/venues');
  } catch (e) { next(e); }
});

router.post('/staff/remove', signedIn, ownerOnly, async (req, res, next) => {
  try {
    const id = Number(req.body.office_id);
    const email = String(req.body.email || '').toLowerCase();
    await db.run('DELETE FROM gift_staff WHERE office_id = ? AND email = ?', [id, email]);
    await audit(req, 'staff.removed', { email }, id);
    flash(res, 'ok', `${email} can no longer manage that venue.`);
    res.redirect(303, '/admin/venues');
  } catch (e) { next(e); }
});

// ---- One venue ---------------------------------------------------------------

async function withVenue(req, res, next) {
  try {
    const id = Number(req.params.officeId);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).render('admin/noaccess', { session: req.session, heading: 'No such venue', body: '' });
    let v = await venues.get(id);
    if (req.session.everyVenue) {
      if (!v) {
        const ev = await epos.venue(id).catch(() => null);
        if (!ev) return res.status(404).render('admin/noaccess', { session: req.session, heading: 'No such venue', body: '' });
        v = await venues.ensure(ev);
      }
    } else {
      const ok = await db.one(
        `SELECT 1 AS x FROM gift_staff s JOIN gift_venues v ON v.office_id = s.office_id
          WHERE s.office_id = ? AND s.email = ? AND v.enabled = 1`,
        [id, String(req.session.email || '').toLowerCase()]
      );
      if (!ok) return res.status(404).render('admin/noaccess', { session: req.session, heading: 'Not one of your venues', body: 'Ask the owner if you should be able to see it.' });
      req.myVenues = await myVenues(req.session.email);
    }
    req.venue = v;
    res.locals.venue = v;
    res.locals.venueName = venues.brandOf(v).name;
    next();
  } catch (e) { next(e); }
}

const V = '/v/:officeId';

/** Mondays, eight of them, as YYYY-MM-DD in UTC -- the EPOS groups the same way. */
function lastMondays(n) {
  const out = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  for (let i = n - 1; i >= 0; i--) {
    const w = new Date(d.getTime() - i * 7 * 86400000);
    out.push(w.toISOString().slice(0, 10));
  }
  return out;
}

function bucket(value, max) {
  if (!max || !value) return 'h-0';
  return `h-${Math.max(5, Math.round((value / max) * 20) * 5)}`;
}

function badgeFor(order, lines) {
  if (order.status === 'refunded') return { kind: 'plain', text: 'Refunded' };
  if (order.status === 'pending') return { kind: 'plain', text: 'Not paid' };
  if (order.status === 'cancelled' || order.status === 'failed') return { kind: 'plain', text: 'Not paid' };
  if (order.kind === 'tickets') {
    return lines.every((l) => l.delivered_at) ? { kind: 'ok', text: 'Tickets sent' } : { kind: 'warn', text: 'Sending' };
  }
  const l = lines[0];
  if (!l) return { kind: 'plain', text: order.status };
  if (l.voided_at) return { kind: 'plain', text: 'Cancelled' };
  if (l.delivered_at) return { kind: 'ok', text: 'Sent' };
  if (l.delivery_error && l.delivery_attempts > 1) return { kind: 'bad', text: 'Not sent yet' };
  if (l.deliver_at && new Date(l.deliver_at) > new Date()) {
    return { kind: 'warn', text: `Sends ${new Date(l.deliver_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: util.ZONE })}` };
  }
  return { kind: 'warn', text: 'Sending' };
}

function describeOrder(o, lines) {
  if (o.kind === 'tickets') {
    const n = lines.reduce((s, l) => s + l.quantity, 0);
    return `${n} × ${(lines[0] || {}).label ? lines[0].label.split(' — ')[0] : 'tickets'}`;
  }
  const l = lines[0] || {};
  return l.kind === 'experience' ? l.label : `Voucher${l.recipient_name ? ' for ' + l.recipient_name : ''}`;
}

async function withLines(list) {
  if (!list.length) return list;
  const lines = await db.all(`SELECT * FROM gift_order_lines WHERE order_id IN (${list.map(() => '?').join(',')}) ORDER BY line_no`, list.map((o) => o.id));
  for (const o of list) {
    o.lines = lines.filter((l) => l.order_id === o.id);
    o.ref = orders.ref(o);
    o.badge = badgeFor(o, o.lines);
    o.what = describeOrder(o, o.lines);
  }
  return list;
}

router.get(V, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const monthStart = util.londonToUtc(`${util.londonDate().slice(0, 7)}-01`, '00:00');
    const soldM = await db.one(
      `SELECT COALESCE(SUM(o.total_minor - o.refunded_minor), 0) AS sold, COUNT(*) AS n
         FROM gift_orders o WHERE o.office_id = ? AND o.kind = 'voucher' AND o.status IN ('paid', 'refunded') AND o.paid_at >= ?`,
      [v.office_id, monthStart]
    );
    const tixM = await db.one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(tt.price_minor), 0) AS takings
         FROM gift_tickets t JOIN gift_orders o ON o.id = t.order_id JOIN gift_ticket_types tt ON tt.id = t.ticket_type_id
        WHERE o.office_id = ? AND t.status IN ('valid', 'used') AND o.paid_at >= ?`,
      [v.office_id, monthStart]
    );
    const summary = await epos.summary(v.office_id, 8).catch(() => null);

    const mondays = lastMondays(8);
    const soldWeeks = await db.all(
      `SELECT DATE_FORMAT(DATE_SUB(DATE(paid_at), INTERVAL WEEKDAY(paid_at) DAY), '%Y-%m-%d') AS wk,
              COALESCE(SUM(total_minor), 0) AS n
         FROM gift_orders WHERE office_id = ? AND kind = 'voucher' AND status IN ('paid', 'refunded')
          AND paid_at >= ? GROUP BY wk`,
      [v.office_id, new Date(`${mondays[0]}T00:00:00Z`)]
    );
    const soldBy = Object.fromEntries(soldWeeks.map((r) => [r.wk, Number(r.n)]));
    const spentBy = {};
    if (summary) for (const w of summary.spent_by_week) spentBy[String(w.week).slice(0, 10)] = w.spent_minor;
    const max = Math.max(1, ...mondays.map((m) => Math.max(soldBy[m] || 0, spentBy[m] || 0)));
    const weeks = mondays.map((m) => ({
      label: new Date(`${m}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      sold: soldBy[m] || 0,
      spent: spentBy[m] || 0,
      soldClass: bucket(soldBy[m] || 0, max),
      spentClass: bucket(spentBy[m] || 0, max),
    }));
    const spent4 = summary ? mondays.slice(-4).reduce((s, m) => s + (spentBy[m] || 0), 0) : null;

    const waiting = await db.all(
      `SELECT l.*, o.buyer_name FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id
        WHERE o.office_id = ? AND o.status = 'paid' AND l.delivered_at IS NULL AND l.voided_at IS NULL
          AND l.deliver_at > UTC_TIMESTAMP() ORDER BY l.deliver_at LIMIT 5`,
      [v.office_id]
    );
    const latest = await withLines(await db.all(
      "SELECT * FROM gift_orders WHERE office_id = ? AND status IN ('paid', 'refunded') ORDER BY id DESC LIMIT 8",
      [v.office_id]
    ));

    page(req, res, 'dashboard', {
      title: 'Dashboard',
      shopUrl: `${config.BASE_URL}/${v.slug}`,
      canPay: venues.canTakePayments(v),
      stats: {
        soldMonth: Number(soldM.sold), vouchersMonth: Number(soldM.n),
        spentMonth: spent4, outstanding: summary ? summary.outstanding_minor : null,
        ticketsMonth: Number(tixM.n), ticketTakingsMonth: Number(tixM.takings),
      },
      weeks, waiting, latest,
    });
  } catch (e) { next(e); }
});

// ---- Orders -------------------------------------------------------------------

async function orderList(v, show, q) {
  const where = ['o.office_id = ?'];
  const args = [v.office_id];
  if (show === 'waiting') {
    where.push("o.status = 'paid' AND EXISTS (SELECT 1 FROM gift_order_lines l WHERE l.order_id = o.id AND l.delivered_at IS NULL AND l.voided_at IS NULL)");
  } else if (show === 'sent') {
    where.push("o.status = 'paid' AND NOT EXISTS (SELECT 1 FROM gift_order_lines l WHERE l.order_id = o.id AND l.delivered_at IS NULL AND l.voided_at IS NULL)");
  } else if (show === 'tickets') {
    where.push("o.kind = 'tickets' AND o.status IN ('paid', 'refunded')");
  } else if (show === 'refunded') {
    where.push('o.refunded_minor > 0');
  } else {
    where.push("o.status IN ('paid', 'refunded')");
  }
  if (q) {
    const refNum = /^vg-?(\d+)$/i.exec(q.trim());
    const like = `%${q.trim().toLowerCase()}%`;
    where.push(`(o.buyer_name LIKE ? OR o.buyer_email LIKE ? OR ${refNum ? 'o.id = ? OR ' : ''}
      EXISTS (SELECT 1 FROM gift_order_lines l WHERE l.order_id = o.id
              AND (l.recipient_name LIKE ? OR l.recipient_email LIKE ? OR l.card_code LIKE ?)))`);
    args.push(like, like);
    if (refNum) args.push(Number(refNum[1]) - 10000);
    args.push(like, like, `%${q.trim().toUpperCase()}%`);
  }
  return withLines(await db.all(`SELECT o.* FROM gift_orders o WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 100`, args));
}

async function orderDetail(v, orderId) {
  const order = await db.one('SELECT * FROM gift_orders WHERE id = ? AND office_id = ?', [Number(orderId), v.office_id]);
  if (!order) return null;
  const lines = await db.all('SELECT * FROM gift_order_lines WHERE order_id = ? ORDER BY line_no', [order.id]);
  for (const l of lines) {
    if (l.design_id) {
      const d = await venues.design(v.office_id, l.design_id);
      l.designUrl = d ? venues.designUrl(d) : null;
    }
    if (l.card_id) {
      l.balance = await epos.card(v.office_id, l.card_id).then((r) => r.card.balance_minor).catch(() => null);
    }
    if (l.kind === 'ticket') {
      const c = await db.one(
        "SELECT SUM(status = 'used') AS used, SUM(status = 'void') AS voided FROM gift_tickets WHERE line_id = ?",
        [l.id]
      );
      l.used = Number(c.used) || 0;
      l.voidCount = Number(c.voided) || 0;
    }
    if (l.deliver_at) {
      const d = new Date(l.deliver_at);
      l.deliverDate = util.londonDate(d);
      l.deliverTime = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: util.ZONE });
    } else {
      l.deliverDate = util.londonDate(new Date(Date.now() + 86400000));
      l.deliverTime = '09:00';
    }
  }
  return { order, lines, ref: orders.ref(order), badge: badgeFor(order, lines) };
}

async function ordersPage(req, res, orderId) {
  const v = req.venue;
  const show = ['waiting', 'sent', 'tickets', 'refunded'].includes(req.query.show) ? req.query.show : 'all';
  const q = util.clean(req.query.q, 80);
  const list = await orderList(v, show, q);
  const selected = orderId ? await orderDetail(v, orderId) : null;
  const qs = [show !== 'all' ? `show=${show}` : null, q ? `q=${encodeURIComponent(q)}` : null].filter(Boolean).join('&');
  page(req, res, 'orders', { title: 'Orders', list, selected, filter: show, q, qs: qs ? `?${qs}` : '' });
}

router.get(`${V}/orders`, signedIn, withVenue, (req, res, next) => ordersPage(req, res, null).catch(next));
router.get(`${V}/orders/:orderId`, signedIn, withVenue, (req, res, next) => ordersPage(req, res, req.params.orderId).catch(next));

async function lineFor(req) {
  const order = await db.one('SELECT * FROM gift_orders WHERE id = ? AND office_id = ?', [Number(req.params.orderId), req.venue.office_id]);
  if (!order) return {};
  const line = await db.one('SELECT * FROM gift_order_lines WHERE id = ? AND order_id = ?', [Number(req.params.lineId), order.id]);
  return { order, line };
}

function back(req, res) {
  res.redirect(303, `/admin/v/${req.venue.office_id}/orders/${Number(req.params.orderId)}`);
}

const L = `${V}/orders/:orderId/lines/:lineId`;

router.post(`${L}/send-now`, signedIn, withVenue, async (req, res, next) => {
  try {
    const { order, line } = await lineFor(req);
    if (!line || order.status !== 'paid') { flash(res, 'bad', 'That cannot be sent.'); return back(req, res); }
    await fulfil.sendLineNow(order, line);
    await audit(req, 'line.sent_now', { order: orders.ref(order), line: line.line_no }, req.venue.office_id);
    flash(res, 'ok', line.kind === 'ticket' ? `Tickets sent to ${order.buyer_email}.` : `Sent to ${line.send_to === 'buyer' ? order.buyer_email : line.recipient_email}.`);
    back(req, res);
  } catch (e) {
    flash(res, 'bad', `It did not send: ${e.message}. It will be tried again automatically.`);
    back(req, res);
  }
});

router.post(`${L}/reschedule`, signedIn, withVenue, async (req, res, next) => {
  try {
    const { order, line } = await lineFor(req);
    if (!line || line.delivered_at) { flash(res, 'bad', 'That has already been sent.'); return back(req, res); }
    const at = util.londonToUtc(req.body.date, req.body.time);
    if (!at || at.getTime() < Date.now() + 60000) { flash(res, 'bad', 'Choose a day and time that has not passed.'); return back(req, res); }
    await db.run('UPDATE gift_order_lines SET deliver_at = ?, next_try_at = NULL WHERE id = ? AND delivered_at IS NULL', [at, line.id]);
    await audit(req, 'line.rescheduled', { order: orders.ref(order), at }, req.venue.office_id);
    flash(res, 'ok', `It will be sent on ${util.when(at)}.`);
    back(req, res);
  } catch (e) { next(e); }
});

router.post(`${L}/address`, signedIn, withVenue, async (req, res, next) => {
  try {
    const { order, line } = await lineFor(req);
    if (!line || line.kind === 'ticket') return back(req, res);
    const name = util.clean(req.body.recipient_name, 120);
    const email = util.clean(req.body.recipient_email, 190).toLowerCase();
    if (!name || !util.isEmail(email)) { flash(res, 'bad', 'Give a name and a proper email address.'); return back(req, res); }
    await db.run('UPDATE gift_order_lines SET recipient_name = ?, recipient_email = ? WHERE id = ?', [name, email, line.id]);
    if (line.card_id) await epos.patchCard(req.venue.office_id, line.card_id, { recipient_name: name }).catch(() => {});
    await audit(req, 'line.address_changed', { order: orders.ref(order), email }, req.venue.office_id);
    if (line.delivered_at && order.status === 'paid') {
      await fulfil.sendLineNow(order, { ...line, recipient_name: name, recipient_email: email });
      flash(res, 'ok', `Fixed, and sent again to ${email}.`);
    } else {
      flash(res, 'ok', `Fixed. It will go to ${email}.`);
    }
    back(req, res);
  } catch (e) {
    flash(res, 'bad', `Saved, but it did not send: ${e.message}`);
    back(req, res);
  }
});

router.post(`${L}/release`, signedIn, withVenue, async (req, res, next) => {
  try {
    const { order, line } = await lineFor(req);
    if (!line || !line.card_id) return back(req, res);
    await epos.patchCard(req.venue.office_id, line.card_id, { usable_from: null });
    await db.run('UPDATE gift_order_lines SET usable_from = NULL WHERE id = ?', [line.id]);
    await audit(req, 'line.released', { order: orders.ref(order) }, req.venue.office_id);
    flash(res, 'ok', 'It can be spent now.');
    back(req, res);
  } catch (e) { next(e); }
});

router.post(`${L}/refund`, signedIn, withVenue, async (req, res) => {
  try {
    const { order, line } = await lineFor(req);
    if (!line || order.status === 'pending' || order.status === 'cancelled') { flash(res, 'bad', 'There is nothing to refund on that.'); return back(req, res); }
    const amount = await payments.refundLine(order, line, { by: req.session.email, reason: 'Refunded by the venue' });
    flash(res, 'ok', amount ? `${util.money(amount, { always: true })} refunded to the buyer’s card. The voucher is cancelled.` : 'Cancelled. Nothing was left on it to refund.');
    back(req, res);
  } catch (e) {
    flash(res, 'bad', e.message);
    back(req, res);
  }
});

router.get(`${V}/export/orders.csv`, signedIn, withVenue, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT o.*, l.kind AS line_kind, l.label, l.quantity, l.unit_minor, l.recipient_name, l.recipient_email,
              l.deliver_at, l.delivered_at, l.card_code, l.refunded_minor AS line_refunded
         FROM gift_orders o JOIN gift_order_lines l ON l.order_id = o.id
        WHERE o.office_id = ? AND o.status IN ('paid', 'refunded') ORDER BY o.id, l.line_no`,
      [req.venue.office_id]
    );
    const cell = (s) => {
      const t = String(s ?? '');
      // A leading =, +, - or @ is a formula to a spreadsheet. A buyer's name is not.
      const safe = /^[=+\-@]/.test(t) ? `'${t}` : t;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const iso = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '');
    const head = ['Order', 'Paid', 'Status', 'Buyer', 'Buyer email', 'Item', 'Quantity', 'Unit', 'Line total', 'Recipient', 'Recipient email', 'Arrives', 'Sent', 'Code ends', 'Refunded'];
    const lines = [head.join(',')].concat(rows.map((r) => [
      orders.ref(r), iso(r.paid_at), r.status, r.buyer_name, r.buyer_email, r.label, r.quantity,
      (r.unit_minor / 100).toFixed(2), ((r.unit_minor * r.quantity) / 100).toFixed(2), r.recipient_name || '', r.recipient_email || '',
      iso(r.deliver_at), iso(r.delivered_at), r.card_code ? r.card_code.slice(-4) : '', (r.line_refunded / 100).toFixed(2),
    ].map(cell).join(',')));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="gift-orders-${util.londonDate()}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (e) { next(e); }
});

// ---- Vouchers ------------------------------------------------------------------

router.get(`${V}/vouchers`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const q = util.clean(req.query.q, 80);
    const args = [v.office_id];
    let filter = '';
    if (q) {
      filter = 'AND (l.card_code LIKE ? OR l.recipient_name LIKE ? OR l.recipient_email LIKE ? OR o.buyer_name LIKE ? OR o.buyer_email LIKE ?)';
      const like = `%${q}%`;
      args.push(`%${q.toUpperCase()}%`, like, like, like, like);
    }
    const rows = await db.all(
      `SELECT l.*, o.buyer_name, o.paid_at FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id
        WHERE o.office_id = ? AND l.card_id IS NOT NULL ${filter} ORDER BY l.id DESC LIMIT 50`,
      args
    );
    await Promise.all(rows.map(async (r) => {
      const c = await epos.card(v.office_id, r.card_id).catch(() => null);
      r.balance = c ? c.card.balance_minor : null;
      r.status = c ? c.card.status : null;
    }));
    page(req, res, 'vouchers', { title: 'Vouchers', rows, q });
  } catch (e) { next(e); }
});

// ---- Experiences -----------------------------------------------------------------

router.get(`${V}/experiences`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const products = await db.all('SELECT * FROM gift_products WHERE office_id = ? ORDER BY sort, id', [v.office_id]);
    const designs = await venues.designs(v.office_id, { onSale: false });
    const editing = req.query.edit ? products.find((p) => String(p.id) === String(req.query.edit)) || null : null;
    page(req, res, 'experiences', { title: 'Experiences', products, designs, editing });
  } catch (e) { next(e); }
});

async function saveProduct(req, res, id) {
  const v = req.venue;
  const name = util.clean(req.body.name, 120);
  const price = util.parseMoney(req.body.price);
  const design = await venues.design(v.office_id, req.body.design_id);
  if (!name || !Number.isInteger(price) || price < 100 || price > 1000000) {
    flash(res, 'bad', 'Give it a name and a price between £1 and £10,000.');
    return res.redirect(303, `/admin/v/${v.office_id}/experiences${id ? `?edit=${id}` : ''}`);
  }
  const description = util.clean(req.body.description, 500) || null;
  if (id) {
    await db.run(
      'UPDATE gift_products SET name = ?, description = ?, price_minor = ?, design_id = ? WHERE id = ? AND office_id = ?',
      [name, description, price, design ? design.id : null, id, v.office_id]
    );
  } else {
    await db.run(
      'INSERT INTO gift_products (office_id, name, description, price_minor, design_id, sort) VALUES (?, ?, ?, ?, ?, 100)',
      [v.office_id, name, description, price, design ? design.id : null]
    );
  }
  await audit(req, id ? 'experience.changed' : 'experience.added', { name, price }, v.office_id);
  flash(res, 'ok', `${name} saved.`);
  res.redirect(303, `/admin/v/${v.office_id}/experiences`);
}

router.post(`${V}/experiences`, signedIn, withVenue, (req, res, next) => saveProduct(req, res, null).catch(next));
router.post(`${V}/experiences/:pid`, signedIn, withVenue, (req, res, next) => saveProduct(req, res, Number(req.params.pid)).catch(next));
router.post(`${V}/experiences/:pid/toggle`, signedIn, withVenue, async (req, res, next) => {
  try {
    await db.run('UPDATE gift_products SET on_sale = 1 - on_sale WHERE id = ? AND office_id = ?', [Number(req.params.pid), req.venue.office_id]);
    res.redirect(303, `/admin/v/${req.venue.office_id}/experiences`);
  } catch (e) { next(e); }
});

// ---- Pictures (designs and events) ----------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/** Keep a picture a venue uploaded: JPEG or PNG by its bytes, not by its name. */
function storeImage(officeId, file) {
  if (!file || !file.buffer) return null;
  const b = file.buffer;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (!jpeg && !png) throw new Error('That is not a JPEG or a PNG.');
  const dir = path.join(config.UPLOADS_DIR, String(officeId));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${jpeg ? 'jpg' : 'png'}`;
  fs.writeFileSync(path.join(dir, name), b);
  return name;
}

router.get(`${V}/designs`, signedIn, withVenue, async (req, res, next) => {
  try {
    page(req, res, 'designs', { title: 'Designs', designs: await venues.designs(req.venue.office_id, { onSale: false }) });
  } catch (e) { next(e); }
});

router.post(`${V}/designs`, signedIn, withVenue, (req, res, next) => {
  upload.single('image')(req, res, async (err) => {
    const to = `/admin/v/${req.venue.office_id}/designs`;
    try {
      if (err) throw new Error(err.code === 'LIMIT_FILE_SIZE' ? 'That picture is over 5 MB.' : err.message);
      const name = util.clean(req.body.name, 80);
      if (!name) throw new Error('Give the design a name.');
      const file = storeImage(req.venue.office_id, req.file);
      if (!file) throw new Error('Choose a picture to upload.');
      const top = await db.one('SELECT COALESCE(MAX(sort), 0) AS s FROM gift_designs WHERE office_id = ?', [req.venue.office_id]);
      await db.run('INSERT INTO gift_designs (office_id, name, image, sort) VALUES (?, ?, ?, ?)', [req.venue.office_id, name, file, Number(top.s) + 1]);
      await audit(req, 'design.added', { name }, req.venue.office_id);
      flash(res, 'ok', `${name} is on sale.`);
      res.redirect(303, to);
    } catch (e) {
      flash(res, 'bad', e.message);
      res.redirect(303, to);
    }
  });
});

router.post(`${V}/designs/:did/toggle`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const d = await venues.design(v.office_id, req.params.did);
    if (d && d.on_sale) {
      const on = await db.one('SELECT COUNT(*) AS n FROM gift_designs WHERE office_id = ? AND on_sale = 1', [v.office_id]);
      if (Number(on.n) <= 1) {
        flash(res, 'bad', 'Keep at least one design on sale, or buyers have nothing to choose.');
        return res.redirect(303, `/admin/v/${v.office_id}/designs`);
      }
    }
    if (d) await db.run('UPDATE gift_designs SET on_sale = 1 - on_sale WHERE id = ?', [d.id]);
    res.redirect(303, `/admin/v/${v.office_id}/designs`);
  } catch (e) { next(e); }
});

router.post(`${V}/designs/:did/first`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const low = await db.one('SELECT COALESCE(MIN(sort), 0) AS s FROM gift_designs WHERE office_id = ?', [v.office_id]);
    await db.run('UPDATE gift_designs SET sort = ? WHERE id = ? AND office_id = ?', [Number(low.s) - 1, Number(req.params.did), v.office_id]);
    res.redirect(303, `/admin/v/${v.office_id}/designs`);
  } catch (e) { next(e); }
});

// ---- Settings ----------------------------------------------------------------------

router.get(`${V}/settings`, signedIn, withVenue, (req, res) => {
  const b = venues.brandOf(req.venue);
  page(req, res, 'settings', { title: 'Settings', amounts: venues.amountsOf(req.venue), payments: b.payments });
});

router.post(`${V}/settings`, signedIn, withVenue, async (req, res, next) => {
  const v = req.venue;
  const to = `/admin/v/${v.office_id}/settings`;
  try {
    const b = req.body;
    const amounts = String(b.amounts || '').split(/[,\s]+/).filter(Boolean).map((s) => util.parseMoney(s));
    if (!amounts.length || amounts.length > 8 || amounts.some((a) => !Number.isInteger(a) || a < 100 || a > 1000000)) {
      throw new Error('Give between one and eight amounts, each at least £1.');
    }
    const min = util.parseMoney(b.min);
    const max = util.parseMoney(b.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 100 || max < min || max > 1000000) {
      throw new Error('The smallest amount must be at least £1 and no more than the largest.');
    }
    const validity = [6, 12, 18, 24, 36].includes(Number(b.validity_months)) ? Number(b.validity_months) : 12;
    const scheduleDays = [31, 92, 183, 366].includes(Number(b.schedule_max_days)) ? Number(b.schedule_max_days) : 183;
    const maxOrder = util.parseMoney(b.max_order);
    if (!Number.isInteger(maxOrder) || maxOrder < 1000) throw new Error('The largest order must be at least £10.');
    const perDay = Math.min(50, Math.max(1, Number(b.orders_per_email_day) || 5));
    const holdOver = b.hold ? util.parseMoney(b.hold_over) : null;
    if (b.hold && (!Number.isInteger(holdOver) || holdOver < 100)) throw new Error('Say how large a voucher has to be before it is held.');
    const holdHours = Math.min(168, Math.max(1, Number(b.hold_hours) || 24));
    const notify = util.clean(b.notify_email, 190).toLowerCase();
    if (notify && !util.isEmail(notify)) throw new Error('The email address for sales does not look right.');

    let slug = v.slug;
    if (req.session.isOwner && b.slug && b.slug !== v.slug) {
      if (!venues.validSlug(b.slug)) throw new Error('A shop address can have lower-case letters, numbers and dashes.');
      const taken = await db.one('SELECT 1 AS x FROM gift_venues WHERE slug = ? AND office_id <> ?', [b.slug, v.office_id]);
      if (taken) throw new Error('Another venue already has that address.');
      slug = b.slug;
    }

    await db.run(
      `UPDATE gift_venues SET amounts = ?, allow_custom = ?, min_minor = ?, max_minor = ?, validity_months = ?,
              allow_schedule = ?, schedule_max_days = ?, terms = ?, notify_email = ?, max_order_minor = ?,
              orders_per_email_day = ?, hold_over_minor = ?, hold_hours = ?, slug = ?
        WHERE office_id = ?`,
      [amounts.join(','), b.allow_custom ? 1 : 0, min, max, validity, b.allow_schedule ? 1 : 0, scheduleDays,
        util.clean(b.terms, 4000) || null, notify || null, maxOrder, perDay, holdOver, holdHours, slug, v.office_id]
    );
    await audit(req, 'settings.saved', null, v.office_id);
    flash(res, 'ok', 'Saved.');
    res.redirect(303, to);
  } catch (e) {
    if (e.code) return next(e);
    flash(res, 'bad', e.message);
    res.redirect(303, to);
  }
});

// ---- Events -------------------------------------------------------------------------

router.get(`${V}/events`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const events = await db.all('SELECT * FROM gift_events WHERE office_id = ? ORDER BY starts_at DESC LIMIT 60', [v.office_id]);
    for (const e of events) {
      const c = await db.one(
        `SELECT SUM(t.status IN ('valid', 'used')) AS sold, SUM(t.status = 'used') AS used,
                COALESCE(SUM(CASE WHEN t.status IN ('valid', 'used') THEN tt.price_minor ELSE 0 END), 0) AS takings
           FROM gift_tickets t JOIN gift_ticket_types tt ON tt.id = t.ticket_type_id WHERE t.event_id = ?`,
        [e.id]
      );
      e.sold = Number(c.sold) || 0;
      e.used = Number(c.used) || 0;
      e.takings = Number(c.takings) || 0;
      e.past = new Date(e.starts_at) < new Date(Date.now() - 6 * 3600 * 1000);
      e.fillClass = `w-${Math.min(100, Math.round((e.sold / Math.max(1, e.capacity)) * 20) * 5)}`;
    }
    events.sort((a, b) => (a.past - b.past) || (a.past ? b.starts_at - a.starts_at : a.starts_at - b.starts_at));
    page(req, res, 'events', { title: 'Events', events });
  } catch (e) { next(e); }
});

function eventForm(e, types) {
  const toLocal = (d) => (d ? new Date(d) : null);
  const time = (d) => (d ? toLocal(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: util.ZONE }) : '');
  const rows = types.slice(0, 3).map((t) => ({ ...t }));
  while (rows.length < 3) rows.push({});
  return {
    event: {
      ...e,
      date: e.starts_at ? util.londonDate(new Date(e.starts_at)) : '',
      start: time(e.starts_at) || '19:00',
      end: time(e.ends_at),
      doors: time(e.doors_at),
      salesEnd: e.sales_end_at ? `${util.londonDate(new Date(e.sales_end_at))}T${time(e.sales_end_at)}` : '',
    },
    types: rows,
  };
}

router.get(`${V}/events/new`, signedIn, withVenue, (req, res) => {
  page(req, res, 'event-edit', { title: 'New event', ...eventForm({}, []), sold: 0, shopUrl: null, error: null });
});

router.get(`${V}/events/:eid`, signedIn, withVenue, async (req, res, next) => {
  try {
    const e = await db.one('SELECT * FROM gift_events WHERE id = ? AND office_id = ?', [Number(req.params.eid), req.venue.office_id]);
    if (!e) return res.redirect(303, `/admin/v/${req.venue.office_id}/events`);
    const types = await db.all('SELECT * FROM gift_ticket_types WHERE event_id = ? ORDER BY sort, id', [e.id]);
    const sold = await db.one("SELECT COUNT(*) AS n FROM gift_tickets WHERE event_id = ? AND status IN ('valid', 'used')", [e.id]);
    page(req, res, 'event-edit', {
      title: e.title, ...eventForm(e, types), sold: Number(sold.n), error: null,
      shopUrl: req.venue.enabled ? `${config.BASE_URL}/${req.venue.slug}/events/${e.public_id}` : null,
    });
  } catch (e) { next(e); }
});

function parseEvent(b) {
  const title = util.clean(b.title, 140);
  if (!title) throw new Error('Give the event a title.');
  const starts = util.londonToUtc(b.date, b.start);
  if (!starts) throw new Error('Give the day and the time it starts.');
  const at = (t) => (t ? util.londonToUtc(b.date, t) : null);
  let ends = at(b.end);
  if (ends && ends <= starts) ends = new Date(ends.getTime() + 86400000); // finishes after midnight
  const doors = at(b.doors);
  const capacity = Number(b.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000) throw new Error('Say how many places there are, between 1 and 5,000.');
  let salesEnd = null;
  if (b.sales_end) {
    const [d, t] = String(b.sales_end).split('T');
    salesEnd = util.londonToUtc(d, (t || '').slice(0, 5));
  }
  const types = [];
  for (let i = 0; i < 3; i++) {
    const name = util.clean(b[`type_name_${i}`], 120);
    if (!name) continue;
    const price = util.parseMoney(b[`type_price_${i}`]);
    if (!Number.isInteger(price) || price < 0 || price > 100000) throw new Error(`Give ${name} a price.`);
    const cap = b[`type_cap_${i}`] ? Number(b[`type_cap_${i}`]) : null;
    if (cap != null && (!Number.isInteger(cap) || cap < 1)) throw new Error(`The places for ${name} must be a whole number.`);
    types.push({ id: Number(b[`type_id_${i}`]) || null, name, price, cap, description: util.clean(b[`type_desc_${i}`], 255) || null, sort: i });
  }
  if (!types.length) throw new Error('Add at least one kind of ticket, with its price.');
  if (types.some((t) => t.price > 0 && t.price < 50)) throw new Error('A paid ticket has to be at least 50p.');
  return {
    title, description: util.clean(b.description, 2000) || null, starts, ends, doors,
    location: util.clean(b.location, 140) || null, capacity, salesEnd, onSale: b.on_sale ? 1 : 0, types,
  };
}

async function saveEvent(req, res, id) {
  const v = req.venue;
  let parsed;
  try {
    parsed = parseEvent(req.body);
    if (parsed.types.some((t) => t.price === 0)) throw new Error('Free tickets are not built yet: give every ticket a price.');
    const image = storeImage(v.office_id, req.file);
    await db.tx(async (conn) => {
      let eventId = id;
      if (id) {
        const [r] = await conn.execute(
          `UPDATE gift_events SET title = ?, description = ?, starts_at = ?, ends_at = ?, doors_at = ?, location = ?,
                  capacity = ?, sales_end_at = ?, on_sale = ?${image ? ', image = ?' : ''} WHERE id = ? AND office_id = ?`,
          [parsed.title, parsed.description, parsed.starts, parsed.ends, parsed.doors, parsed.location, parsed.capacity,
            parsed.salesEnd, parsed.onSale, ...(image ? [image] : []), id, v.office_id]
        );
        if (!r.affectedRows) throw new Error('No such event.');
      } else {
        const [r] = await conn.execute(
          `INSERT INTO gift_events (office_id, public_id, title, description, starts_at, ends_at, doors_at, location, image, capacity, on_sale, sales_end_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [v.office_id, util.publicId(12), parsed.title, parsed.description, parsed.starts, parsed.ends, parsed.doors,
            parsed.location, image, parsed.capacity, parsed.onSale, parsed.salesEnd]
        );
        eventId = r.insertId;
      }
      for (const t of parsed.types) {
        if (t.id) {
          await conn.execute(
            'UPDATE gift_ticket_types SET name = ?, description = ?, price_minor = ?, capacity = ?, sort = ? WHERE id = ? AND event_id = ?',
            [t.name, t.description, t.price, t.cap, t.sort, t.id, eventId]
          );
        } else {
          await conn.execute(
            'INSERT INTO gift_ticket_types (event_id, name, description, price_minor, capacity, sort) VALUES (?, ?, ?, ?, ?, ?)',
            [eventId, t.name, t.description, t.price, t.cap, t.sort]
          );
        }
      }
      id = eventId;
    });
    await audit(req, 'event.saved', { title: parsed.title }, v.office_id);
    flash(res, 'ok', `${parsed.title} saved.`);
    res.redirect(303, `/admin/v/${v.office_id}/events/${id}`);
  } catch (e) {
    if (e.code && e.code !== 'LIMIT_FILE_SIZE') throw e;
    const types = parsed ? parsed.types.map((t) => ({ id: t.id, name: t.name, price_minor: t.price, capacity: t.cap, description: t.description })) : [];
    const form = eventForm({ id, title: req.body.title, description: req.body.description, location: req.body.location, capacity: req.body.capacity, on_sale: req.body.on_sale ? 1 : 0 }, types);
    form.event.date = req.body.date;
    form.event.start = req.body.start;
    page(req, res, 'event-edit', { title: 'Event', ...form, sold: 0, shopUrl: null, error: e.message });
  }
}

function withUpload(handler) {
  return (req, res, next) => upload.single('image')(req, res, (err) => {
    if (err) {
      flash(res, 'bad', err.code === 'LIMIT_FILE_SIZE' ? 'That picture is over 5 MB.' : err.message);
      return res.redirect(303, req.originalUrl.split('?')[0]);
    }
    handler(req, res).catch(next);
  });
}

router.post(`${V}/events`, signedIn, withVenue, withUpload((req, res) => saveEvent(req, res, null)));
router.post(`${V}/events/:eid`, signedIn, withVenue, withUpload((req, res) => saveEvent(req, res, Number(req.params.eid))));

router.post(`${V}/events/:eid/cancel`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const e = await db.one('SELECT * FROM gift_events WHERE id = ? AND office_id = ?', [Number(req.params.eid), v.office_id]);
    if (!e) return res.redirect(303, `/admin/v/${v.office_id}/events`);
    await db.run('UPDATE gift_events SET cancelled_at = UTC_TIMESTAMP(), on_sale = 0 WHERE id = ?', [e.id]);
    const lines = await db.all(
      `SELECT l.*, o.id AS oid FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id
        WHERE l.event_id = ? AND o.status = 'paid'
          AND EXISTS (SELECT 1 FROM gift_tickets t WHERE t.line_id = l.id AND t.status = 'valid')`,
      [e.id]
    );
    let refunded = 0;
    let failed = 0;
    for (const l of lines) {
      const order = await db.one('SELECT * FROM gift_orders WHERE id = ?', [l.oid]);
      try {
        refunded += await payments.refundLine(order, l, { by: req.session.email, reason: `${e.title} was cancelled` });
      } catch {
        failed += 1;
      }
    }
    await audit(req, 'event.cancelled', { title: e.title, refunded, failed }, v.office_id);
    flash(res, failed ? 'bad' : 'ok', failed
      ? `Cancelled. ${util.money(refunded, { always: true })} refunded, but ${failed} order${failed === 1 ? '' : 's'} could not be — see Orders.`
      : `Cancelled, and ${util.money(refunded, { always: true })} refunded.`);
    res.redirect(303, `/admin/v/${v.office_id}/events`);
  } catch (e) { next(e); }
});

router.get(`${V}/events/:eid/guests`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const event = await db.one('SELECT * FROM gift_events WHERE id = ? AND office_id = ?', [Number(req.params.eid), v.office_id]);
    if (!event) return res.redirect(303, `/admin/v/${v.office_id}/events`);
    const tickets = await db.all(
      `SELECT t.*, tt.name AS type_name, o.buyer_email, o.id AS order_id
         FROM gift_tickets t JOIN gift_ticket_types tt ON tt.id = t.ticket_type_id JOIN gift_orders o ON o.id = t.order_id
        WHERE t.event_id = ? ORDER BY t.holder_name, t.seq`,
      [event.id]
    );
    for (const t of tickets) t.ref = orders.ref({ id: t.order_id });
    page(req, res, 'guests', { title: 'Guest list', event, tickets, used: tickets.filter((t) => t.status === 'used').length });
  } catch (e) { next(e); }
});

// ---- The door ------------------------------------------------------------------------

router.get(`${V}/door/:eid`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const event = await db.one('SELECT * FROM gift_events WHERE id = ? AND office_id = ?', [Number(req.params.eid), v.office_id]);
    if (!event) return res.redirect(303, `/admin/v/${v.office_id}/events`);
    const c = await db.one(
      "SELECT SUM(status IN ('valid', 'used')) AS total, SUM(status = 'used') AS used FROM gift_tickets WHERE event_id = ?",
      [event.id]
    );
    res.render('admin/door', {
      session: req.session, venue: v, venueName: venues.brandOf(v).name, event,
      total: Number(c.total) || 0, used: Number(c.used) || 0,
    });
  } catch (e) { next(e); }
});

router.post(`${V}/door/:eid/scan`, signedIn, withVenue, async (req, res, next) => {
  try {
    const v = req.venue;
    const event = await db.one('SELECT * FROM gift_events WHERE id = ? AND office_id = ?', [Number(req.params.eid), v.office_id]);
    if (!event) return res.status(404).json({ ok: false, title: 'No such event' });
    const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const answer = (x) => res.json(x);
    const ticket = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)
      ? await db.one('SELECT t.*, tt.name AS type_name FROM gift_tickets t JOIN gift_ticket_types tt ON tt.id = t.ticket_type_id WHERE t.code = ?', [code])
      : null;
    const count = async () => Number((await db.one("SELECT SUM(status = 'used') AS n FROM gift_tickets WHERE event_id = ?", [event.id])).n) || 0;

    if (!ticket) return answer({ ok: false, title: 'Not a ticket', detail: `Nothing matches ${code || 'that code'}.`, in: await count() });
    if (ticket.event_id !== event.id) {
      const other = await db.one('SELECT title, starts_at FROM gift_events WHERE id = ?', [ticket.event_id]);
      return answer({ ok: false, title: 'Not for tonight', detail: other ? `This ticket is for ${other.title}, ${util.when(other.starts_at, { short: true })}.` : 'This ticket is for another event.', in: await count() });
    }
    if (ticket.status === 'void') return answer({ ok: false, title: 'Refunded ticket', detail: `${ticket.holder_name} · ${ticket.type_name}. It was refunded.`, in: await count() });

    const r = await db.run(
      "UPDATE gift_tickets SET status = 'used', checked_in_at = UTC_TIMESTAMP(), checked_in_by = ? WHERE id = ? AND status = 'valid'",
      [req.session.email, ticket.id]
    );
    const siblings = await db.one('SELECT COUNT(*) AS n FROM gift_tickets WHERE line_id = ?', [ticket.line_id]);
    const of = `${ticket.seq} of ${siblings.n}`;
    if (!r.affectedRows) {
      const again = await db.one('SELECT checked_in_at FROM gift_tickets WHERE id = ?', [ticket.id]);
      return answer({ ok: false, title: 'Already in', detail: `${ticket.holder_name} · ${ticket.type_name} · ${of}. Let in at ${util.when(again.checked_in_at).split(', ').pop()}.`, in: await count() });
    }
    answer({ ok: true, title: 'Let in', detail: `${ticket.holder_name} · ${ticket.type_name} · ${of}`, in: await count() });
  } catch (e) { next(e); }
});

module.exports = { adminRouter: router, badgeFor };
