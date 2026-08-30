/**
 * Customer sign-up, sign-in and password recovery.
 *
 * Email is the account. Three rules run through everything here:
 *
 * 1. **Never confirm whether an address exists.** Sign-up, sign-in and
 *    password reset all answer identically whether or not we know the address.
 *    Otherwise the forms become a tool for enumerating our customer list.
 * 2. **Tokens are single-use, hashed at rest and short-lived.**
 * 3. **Changing a password signs out every other device**, via the password
 *    fingerprint carried in the session cookie.
 */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { sendMail, shell, escapeHtml } = require('../mailer');
const { flash, rateLimited, clearRateLimit, field, isEmail } = require('../http-utils');
const { SITE_URL } = require('../config');

const router = express.Router();

const VERIFY_TTL_HOURS = 48;
const RESET_TTL_MINUTES = 60;

/** Where to send someone after they sign in. Internal paths only. */
function safeNext(raw, fallback = '/panel') {
  const value = String(raw || '');
  // A full URL, a protocol-relative URL or anything not starting with a single
  // slash is an open redirect waiting to happen.
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

async function issueToken(customerId, purpose, ttlMs) {
  const { token, hash } = auth.newToken();
  // One live token per purpose: requesting a second reset must invalidate the
  // first, or an old email in an inbox stays usable.
  await db.query('UPDATE customer_tokens SET used_at = NOW() WHERE customer_id = ? AND purpose = ? AND used_at IS NULL', [
    customerId,
    purpose,
  ]);
  await db.query(
    'INSERT INTO customer_tokens (customer_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
    [customerId, purpose, hash, Math.round(ttlMs / 1000)],
  );
  return token;
}

async function consumeToken(token, purpose) {
  const hash = auth.hashToken(token);
  const row = await db.one(
    `SELECT * FROM customer_tokens
      WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [hash, purpose],
  );
  if (!row) return null;
  await db.query('UPDATE customer_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
  return db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [row.customer_id]);
}

async function sendVerifyEmail(customer, req) {
  const token = await issueToken(customer.id, 'verify', VERIFY_TTL_HOURS * 3600_000);
  const url = `${SITE_URL}/verify/${token}`;
  await sendMail({
    to: customer.email,
    subject: 'Confirm your email — Vesopa Cloud',
    html: shell({
      title: 'Confirm your email address',
      intro: `Hello ${escapeHtml(customer.first_name || 'there')} — click below to confirm this address and finish setting up your account.`,
      ctaText: 'Confirm my email',
      ctaUrl: url,
      footNote: `This link expires in ${VERIFY_TTL_HOURS} hours. If you did not create an account, ignore this email and nothing will happen.`,
    }),
  });
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------
router.get('/register', (req, res) => {
  if (req.customer) return res.redirect('/panel');
  res.render('auth/register', {
    title: 'Create your account',
    robots: 'noindex',
    values: {},
    errors: {},
    next: safeNext(req.query.next),
  });
});

router.post('/register', async (req, res, next) => {
  try {
    const values = {
      email: field(req.body.email, 190).toLowerCase(),
      first_name: field(req.body.first_name, 80),
      last_name: field(req.body.last_name, 80),
      company: field(req.body.company, 160),
      phone: field(req.body.phone, 40),
    };
    const password = String(req.body.password || '');

    const errors = {};
    if (!auth.checkCsrf(req)) errors.form = 'Your session expired. Please try again.';
    if (!isEmail(values.email)) errors.email = 'That email address does not look right.';
    if (!values.first_name) errors.first_name = 'Required.';
    if (!values.last_name) errors.last_name = 'Required.';
    const problem = auth.passwordProblem(password);
    if (problem) errors.password = problem;
    if (rateLimited(req.ip, 'register', { max: 5, windowMs: 3600_000 })) {
      errors.form = 'Too many sign-ups from this connection. Please try again later.';
    }

    if (Object.keys(errors).length) {
      return res.status(400).render('auth/register', {
        title: 'Create your account',
        robots: 'noindex',
        values,
        errors,
        next: safeNext(req.body.next),
      });
    }

    const existing = await db.one('SELECT id FROM customers WHERE email = ? LIMIT 1', [values.email]);
    if (existing) {
      // Do not say "that address is taken" — that answers the question an
      // attacker is asking. Send the *existing* owner a note instead, which is
      // useful to them and reveals nothing to whoever submitted the form.
      sendMail({
        to: values.email,
        subject: 'Someone tried to sign up with your email — Vesopa Cloud',
        html: shell({
          title: 'You already have an account',
          intro:
            'Someone just tried to create a Vesopa Cloud account with this address. If that was you, you already have one — sign in instead.',
          ctaText: 'Sign in',
          ctaUrl: `${SITE_URL}/login`,
          footNote: 'If it was not you, you can safely ignore this. Your account has not changed and nobody has gained access to it.',
        }),
      });
      flash(res, 'Check your inbox to continue.');
      return res.redirect('/register/check-email');
    }

    const hash = await auth.hashPassword(password);
    const result = await db.query(
      `INSERT INTO customers (email, password_hash, first_name, last_name, company, phone)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [values.email, hash, values.first_name, values.last_name, values.company, values.phone],
    );

    const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [result.insertId]);
    await sendVerifyEmail(customer, req);
    await db.logActivity({ actorType: 'customer', actorId: customer.id, action: 'account.created', target: customer.email, ip: req.ip });

    // Signed in straight away. Waiting for verification before letting someone
    // into their own empty panel is friction for no security benefit — the
    // things that matter are gated on `email_verified`, not on the session.
    auth.issueCustomerSession(res, customer);
    res.redirect('/register/check-email');
  } catch (err) {
    next(err);
  }
});

router.get('/register/check-email', (req, res) => {
  res.render('auth/check-email', {
    title: 'Check your email',
    robots: 'noindex',
    email: req.customer ? req.customer.email : '',
  });
});

router.post('/register/resend', async (req, res, next) => {
  try {
    if (!req.customer) return res.redirect('/login');
    if (req.customer.email_verified) return res.redirect('/panel');
    if (rateLimited(req.ip, 'resend', { max: 4, windowMs: 3600_000 })) {
      flash(res, 'We have sent several already — check your spam folder.', 'warn');
      return res.redirect('/register/check-email');
    }
    await sendVerifyEmail(req.customer, req);
    flash(res, 'Sent. It should arrive within a minute.');
    res.redirect('/register/check-email');
  } catch (err) {
    next(err);
  }
});

router.get('/verify/:token', async (req, res, next) => {
  try {
    const customer = await consumeToken(req.params.token, 'verify');
    if (!customer) {
      return res.status(400).render('auth/token-invalid', {
        title: 'That link has expired',
        robots: 'noindex',
        heading: 'That confirmation link is no longer valid',
        message: 'Links expire after 48 hours and can only be used once. Sign in and we will send you a fresh one.',
      });
    }

    await db.query('UPDATE customers SET email_verified = 1 WHERE id = ?', [customer.id]);
    await db.logActivity({ actorType: 'customer', actorId: customer.id, action: 'account.verified', target: customer.email, ip: req.ip });

    auth.issueCustomerSession(res, customer);
    flash(res, 'Email confirmed — welcome aboard.');
    res.redirect('/panel');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
router.get('/login', (req, res) => {
  if (req.customer) return res.redirect(safeNext(req.query.next));
  res.render('auth/login', {
    title: 'Sign in',
    robots: 'noindex',
    values: {},
    error: null,
    next: safeNext(req.query.next),
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const email = field(req.body.email, 190).toLowerCase();
    const password = String(req.body.password || '');
    const target = safeNext(req.body.next);

    const fail = (message) =>
      res.status(401).render('auth/login', {
        title: 'Sign in',
        robots: 'noindex',
        values: { email },
        error: message,
        next: target,
      });

    if (!auth.checkCsrf(req)) return fail('Your session expired. Please try again.');

    // Both counters must trip: per-IP stops a broad sweep, per-account stops a
    // distributed attack on one known address.
    if (rateLimited(req.ip, 'login-ip', { max: 20, windowMs: 900_000 })) {
      return fail('Too many attempts from this connection. Please wait 15 minutes.');
    }
    if (rateLimited(email, 'login-account', { max: 8, windowMs: 900_000 })) {
      return fail('Too many attempts for this account. Please wait 15 minutes, or reset your password.');
    }

    const customer = await db.one('SELECT * FROM customers WHERE email = ? LIMIT 1', [email]);
    // checkPassword spends the bcrypt time even with no row, so a missing
    // account and a wrong password take the same time to answer.
    const ok = await auth.checkPassword(password, customer?.password_hash);

    if (!customer || !ok) return fail('That email address or password is not right.');

    if (customer.status === 'suspended') {
      return fail('This account is suspended. Please contact support.');
    }
    if (customer.status === 'closed') {
      return fail('That email address or password is not right.');
    }

    clearRateLimit(req.ip, 'login-ip');
    clearRateLimit(email, 'login-account');

    await db.query('UPDATE customers SET last_login_at = NOW() WHERE id = ?', [customer.id]);
    await db.logActivity({ actorType: 'customer', actorId: customer.id, action: 'account.login', target: customer.email, ip: req.ip });

    auth.issueCustomerSession(res, customer);
    res.redirect(target);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  auth.clearCustomerSession(res);
  flash(res, 'Signed out.');
  res.redirect('/');
});

// A GET fallback so a "sign out" link works without a form.
router.get('/logout', (req, res) => {
  auth.clearCustomerSession(res);
  res.redirect('/');
});

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------
router.get('/forgot', (req, res) => {
  res.render('auth/forgot', { title: 'Reset your password', robots: 'noindex', sent: false, error: null });
});

router.post('/forgot', async (req, res, next) => {
  try {
    const email = field(req.body.email, 190).toLowerCase();

    if (!auth.checkCsrf(req)) {
      return res.render('auth/forgot', { title: 'Reset your password', robots: 'noindex', sent: false, error: 'Your session expired. Please try again.' });
    }
    if (rateLimited(req.ip, 'forgot', { max: 6, windowMs: 3600_000 })) {
      // Still answer as if it worked. "You have asked too often" tells an
      // attacker their guesses are landing somewhere.
      return res.render('auth/forgot', { title: 'Reset your password', robots: 'noindex', sent: true, error: null });
    }

    const customer = await db.one('SELECT * FROM customers WHERE email = ? AND status = ? LIMIT 1', [email, 'active']);
    if (customer) {
      const token = await issueToken(customer.id, 'reset', RESET_TTL_MINUTES * 60_000);
      await sendMail({
        to: customer.email,
        subject: 'Reset your password — Vesopa Cloud',
        html: shell({
          title: 'Reset your password',
          intro: 'Click below to choose a new password. If you did not ask for this, ignore this email — your password has not changed.',
          ctaText: 'Choose a new password',
          ctaUrl: `${SITE_URL}/reset/${token}`,
          footNote: `This link expires in ${RESET_TTL_MINUTES} minutes and can only be used once.`,
        }),
      });
      await db.logActivity({ actorType: 'customer', actorId: customer.id, action: 'password.reset_requested', target: email, ip: req.ip });
    }

    // Identical response either way.
    res.render('auth/forgot', { title: 'Reset your password', robots: 'noindex', sent: true, error: null });
  } catch (err) {
    next(err);
  }
});

router.get('/reset/:token', async (req, res) => {
  // Peek without consuming: a mail client that pre-fetches links would
  // otherwise burn the token before the customer ever clicks it.
  const row = await db.one(
    'SELECT id FROM customer_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
    [auth.hashToken(req.params.token), 'reset'],
  );
  if (!row) {
    return res.status(400).render('auth/token-invalid', {
      title: 'That link has expired',
      robots: 'noindex',
      heading: 'That reset link is no longer valid',
      message: 'Reset links expire after an hour and can only be used once. Request a new one below.',
    });
  }
  res.render('auth/reset', { title: 'Choose a new password', robots: 'noindex', token: req.params.token, error: null });
});

router.post('/reset/:token', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    const again = String(req.body.password_confirm || '');

    const fail = (message) =>
      res.status(400).render('auth/reset', { title: 'Choose a new password', robots: 'noindex', token: req.params.token, error: message });

    if (!auth.checkCsrf(req)) return fail('Your session expired. Please try again.');
    if (password !== again) return fail('The two passwords do not match.');
    const problem = auth.passwordProblem(password);
    if (problem) return fail(problem);

    const customer = await consumeToken(req.params.token, 'reset');
    if (!customer) {
      return res.status(400).render('auth/token-invalid', {
        title: 'That link has expired',
        robots: 'noindex',
        heading: 'That reset link is no longer valid',
        message: 'It may already have been used. Request a new one below.',
      });
    }

    const hash = await auth.hashPassword(password);
    // A reset is also a proof of email ownership, so it verifies the address.
    await db.query('UPDATE customers SET password_hash = ?, email_verified = 1 WHERE id = ?', [hash, customer.id]);
    await db.logActivity({ actorType: 'customer', actorId: customer.id, action: 'password.reset', target: customer.email, ip: req.ip });

    sendMail({
      to: customer.email,
      subject: 'Your password was changed — Vesopa Cloud',
      html: shell({
        title: 'Your password was changed',
        intro: 'This is a confirmation that the password on your Vesopa Cloud account has just been changed, and every other device has been signed out.',
        footNote: '<b>If this was not you</b>, reply to this email immediately — someone else has access to your inbox.',
      }),
    });

    // The new hash changes the fingerprint, which invalidates every cookie
    // already out there. Issue a fresh one for this browser.
    const updated = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [customer.id]);
    auth.issueCustomerSession(res, updated);

    flash(res, 'Password changed — you are signed in.');
    res.redirect('/panel');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
