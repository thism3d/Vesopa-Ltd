/**
 * The four enquiry forms: demo request, support message, job enquiry, training
 * booking.
 *
 * All four were near-identical 28 KB PHP files that differed only in table,
 * columns and wording, so they are one handler driven by a table of
 * definitions. Each still: validates, inserts, emails support, and renders the
 * confirmation page — in that order, with the mail no longer able to hold up the
 * response.
 */

const express = require('express');
const { pool } = require('../db');
const { sendMail } = require('../mailer');
const { renderNotification } = require('../emails/notification');

const router = express.Router();

/**
 * Trim, and cap length so an oversized paste cannot be truncated by MySQL into
 * a silent partial write. Values are stored raw and escaped at render time,
 * which is why the PHP's htmlspecialchars-on-input is gone: it double-encoded
 * apostrophes into the database ("O&#39;Brien" in the admin panel forever).
 */
function clean(value, maxLength) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, maxLength);
}

/** Good enough to catch typos; the confirmation email is the real check. */
function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/**
 * `datetime-local` gives "2026-08-01T14:30"; MySQL DATETIME wants a space and
 * seconds. The PHP fed the raw value straight in, so every booking_time landed
 * as 0000-00-00.
 *
 * Reformatted as a string rather than parsed into a Date. The value carries no
 * timezone — it is the wall-clock time the customer picked — so putting it
 * through Date and back out via toISOString() would rebase it to UTC and move
 * a 14:30 booking by however many hours the server happens to be from GMT.
 */
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function toMysqlDateTime(value) {
  if (!value) return null;
  const m = LOCAL_DATETIME.exec(String(value).trim());
  if (!m) return null;

  const [, year, month, day, hour, minute, second = '00'] = m;
  // Reject impossible dates ("2026-02-31T10:00") that the shape alone allows.
  const probe = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  if (probe.getUTCMonth() !== +month - 1 || probe.getUTCDate() !== +day) return null;

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

const FORMS = {
  'request-demo': {
    table: 'demo_request',
    columns: ['name', 'email', 'phone', 'business_name', 'business_brief'],
    required: ['name', 'email', 'phone', 'business_name'],
    limits: { name: 255, email: 255, phone: 255, business_name: 512, business_brief: 2000 },
    subject: (f) => `New Demo Request From ${f.name}`,
    email: {
      title: 'Vesopa EPOS | Demo Request',
      hero: '/assets/email/demo_request.png',
      headline: 'New Demo Request',
      rows: (f) => [
        { label: 'Phone', value: f.phone },
        { label: 'Email', value: f.email },
        { label: 'Business Name', value: f.business_name },
        { label: 'Business Brief', value: f.business_brief },
      ],
    },
    page: {
      title: 'Vesopa EPOS | Demo Request Received',
      heading: 'Demo Request Received!',
      brief: 'Thank You! Your Request Has Been Received Successfully. Our Team Will Get Back to You Shortly!',
    },
  },

  contact: {
    table: 'customer_message',
    columns: ['name', 'email', 'phone', 'message', 'comment'],
    required: ['name', 'email', 'phone', 'message'],
    limits: { name: 255, email: 255, phone: 255, message: 5000, comment: 1000 },
    subject: (f) => `New Support Message From ${f.name}`,
    email: {
      title: 'Vesopa EPOS | Customer Message',
      hero: '/assets/email/envelope.png',
      headline: 'New Customer Message',
      rows: (f) => [
        { label: 'Phone', value: f.phone },
        { label: 'Email', value: f.email },
        { label: 'Message', value: f.message },
        { label: 'Comment', value: f.comment },
      ],
    },
    page: {
      title: 'Vesopa EPOS | Message Received',
      heading: 'Message Received!',
      brief: 'Thank You! Your Message Has Been Received Successfully. Our Team Will Get Back to You Shortly!',
    },
  },

  'job-enquiry': {
    table: 'career_request',
    columns: ['name', 'email', 'phone', 'company', 'description'],
    required: ['name', 'email', 'phone', 'description'],
    limits: { name: 255, email: 255, phone: 255, company: 512, description: 2000 },
    subject: (f) => `New Job Request From ${f.name}`,
    email: {
      title: 'Vesopa EPOS | Job Request',
      hero: '/assets/icons/hiring-01.png',
      headline: 'New Job Position Requested',
      rows: (f) => [
        { label: 'Phone', value: f.phone },
        { label: 'Email', value: f.email },
        { label: 'Company', value: f.company },
        { label: 'Brief', value: f.description },
      ],
    },
    page: {
      title: 'Vesopa EPOS | Job Information Received',
      heading: 'Job Information Received!',
      brief: 'Thank You! Your Request Has Been Received Successfully. Our Team Will Get Back to You Shortly!',
    },
  },

  'book-training': {
    table: 'training_request',
    columns: ['name', 'email', 'phone', 'company', 'booking_time', 'message'],
    required: ['name', 'email', 'phone', 'booking_time'],
    limits: { name: 255, email: 255, phone: 255, company: 512, message: 2000 },
    dateFields: ['booking_time'],
    subject: (f) => `New Training Booking From ${f.name}`,
    email: {
      title: 'Vesopa EPOS | Training Booking',
      hero: '/assets/icons/HD_M250_062.png',
      headline: 'New Training Session Booked',
      rows: (f) => [
        { label: 'Phone', value: f.phone },
        { label: 'Email', value: f.email },
        { label: 'Company', value: f.company },
        { label: 'Booking Time', value: f.booking_time },
        { label: 'Message', value: f.message },
      ],
    },
    page: {
      title: 'Vesopa EPOS | Training Booking Received',
      heading: 'Training Booking Received!',
      brief: 'Thank You! Your Booking Has Been Received Successfully. Our Team Will Get Back to You Shortly!',
    },
  },
};

/**
 * Crude per-IP throttle on submissions.
 *
 * The PHP had none, so the forms were a free relay for writing rows and firing
 * mail. Kept in memory deliberately: the app runs as a single pm2 fork, and a
 * bot fast enough to matter is better stopped at the edge anyway.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 6;
const recent = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);

  // Keep the map from growing without bound on a long-running process.
  if (recent.size > 5000) {
    for (const [key, times] of recent) {
      if (!times.some((t) => now - t < WINDOW_MS)) recent.delete(key);
    }
  }

  return hits.length > MAX_PER_WINDOW;
}

/**
 * Post/Redirect/Get.
 *
 * Every handler used to render the confirmation page straight out of the POST.
 * That leaves the browser sitting on a POST response, so a refresh re-submits
 * the whole form — Chrome shows "Confirm Form Resubmission", and confirming it
 * writes a second enquiry and fires a second notification email. Back-button
 * navigation does the same thing.
 *
 * The POST now writes and redirects; a separate GET renders. Refreshing the
 * confirmation page just re-runs a GET, which is inert.
 *
 * 303 specifically, not 302: 303 tells the browser to switch to GET for the
 * redirected request. Some clients preserve the method on a 302 and would
 * re-POST to the thank-you URL.
 */
const THANK_YOU_BASE = '/thank-you';

/** Rendered by the GET below, keyed by the slug in the URL. */
const CONFIRMATIONS = Object.fromEntries(
  Object.entries(FORMS).map(([slug, form]) => [slug, form.page])
);

CONFIRMATIONS['too-many'] = {
  title: 'Vesopa EPOS | Too Many Requests',
  heading: 'One Moment, Please',
  brief:
    "We've had several submissions from you just now. Please wait a few minutes and try again, or call us on +44 1792 316282.",
};

router.get(`${THANK_YOU_BASE}/:slug`, (req, res) => {
  const page = CONFIRMATIONS[req.params.slug];
  // An unknown or hand-typed slug is not an error worth a page of its own.
  if (!page) return res.redirect('/');

  res.status(req.params.slug === 'too-many' ? 429 : 200).render('received', page);
});

for (const [slug, form] of Object.entries(FORMS)) {
  router.post(`/${slug}`, async (req, res, next) => {
    if (rateLimited(req.ip)) {
      return res.redirect(303, `${THANK_YOU_BASE}/too-many`);
    }

    // Build the row, field by field, from the form's own definition.
    const fields = {};
    for (const column of form.columns) {
      const isDate = (form.dateFields || []).includes(column);
      fields[column] = isDate
        ? toMysqlDateTime(req.body[column])
        : clean(req.body[column], form.limits[column]);
    }

    const missing = form.required.filter((c) => !fields[c]);
    if (missing.length || !looksLikeEmail(fields.email)) {
      // The forms are `required`-marked in the browser, so reaching here means
      // a bot or a hand-crafted post. Back to the page, no row written.
      return res.redirect('/');
    }

    try {
      const cols = form.columns.join(', ');
      const placeholders = form.columns.map(() => '?').join(', ');
      await pool.query(
        `INSERT INTO ${form.table} (${cols}) VALUES (${placeholders})`,
        form.columns.map((c) => fields[c])
      );
    } catch (e) {
      // demo_request.email carries a UNIQUE key in the live database (inherited
      // from the PHP schema; schema.sql only declares an INDEX, so a fresh
      // install and production differ here). A business enquiring a second time
      // — chasing a reply, or adding detail — therefore hit a duplicate-key
      // error and was shown "Something Went Wrong" for a perfectly reasonable
      // action.
      //
      // The existing row is deliberately left alone: it may already be approved,
      // and an UPDATE would either undo that or quietly overwrite what support
      // has been working from. Support still gets the mail below with whatever
      // the visitor has just told us, which is the part that matters.
      if (e && e.code === 'ER_DUP_ENTRY') {
        console.warn(`[forms] repeat ${slug} from ${fields.email} — notifying support, row unchanged`);
      } else {
        return next(e);
      }
    }

    // Committed. The notification goes out afterwards, and a mail failure is
    // logged rather than shown — the enquiry is safe either way.
    sendMail({
      subject: form.subject(fields),
      replyTo: fields.email,
      html: renderNotification({
        title: form.email.title,
        // res.locals, not the config import: a server left on the default
        // SITE_URL sent every notification email with a hero image pointing at
        // localhost, which renders as a broken image in the recipient's inbox.
        heroImage: res.locals.SITE_URL + form.email.hero,
        headline: form.email.headline,
        name: fields.name,
        rows: form.email.rows(fields).filter((r) => r.value),
      }),
    });

    res.redirect(303, `${THANK_YOU_BASE}/${slug}`);
  });
}

/** The PHP form targets, for any cached page still posting to them. */
const LEGACY = {
  '/received_demo_request': '/request-demo',
  '/received_customer_message': '/contact',
  '/received_job_information': '/job-enquiry',
  '/received_training_booking': '/book-training',
};
for (const [from, to] of Object.entries(LEGACY)) {
  router.post(from, (req, res, next) => {
    req.url = to;
    router.handle(req, res, next);
  });
  // A GET straight to a form target was a blank page in PHP; send it home.
  router.get(from, (_req, res) => res.redirect('/'));
  router.get(`${from}.php`, (_req, res) => res.redirect('/'));
}

module.exports = { formsRouter: router };
