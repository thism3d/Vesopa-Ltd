/**
 * Signing in to the hosting panel with a Vesopa account.
 *
 * DORMANT UNTIL TURNED ON. Nothing here answers anything unless
 * `VESOPA_AUTH_PANEL_ENABLED` is set and the credentials are present, so
 * rolling it back is a flag and a restart.
 *
 * THIS IS NOW THE FRONT DOOR. With `VESOPA_AUTH_PANEL_ONLY` (config.VESOPA_ONLY,
 * on by default) the password form, registration and password recovery all
 * answer with a redirect here, and this route does the one thing it used to
 * refuse: the first Vesopa sign-in from an address we have never seen CREATES
 * the customer. That refusal made sense while /register existed beside it — a
 * customer row is a billing relationship, and "a stranger arrived with a Vesopa
 * account" was no reason to open one. With registration gone, the first Vesopa
 * sign-in IS the registration, and what it creates is exactly what /register
 * created: an empty account with a verified address and nothing behind it.
 * Buying anything still happens at checkout, with a billing address, as before.
 *
 * With the flag off, nothing is created and an unknown address is told to
 * register in the ordinary way — the soak behaviour, unchanged.
 *
 * EVERY FAILURE IS A REDIRECT, NEVER A RENDER. The callback URL carries a
 * one-time code; rendering the sign-in page ON that URL meant a reload replayed
 * the callback with a dead code, and a browser that had a form in its history
 * asked whether to resubmit it. A flash and a redirect to /login leave the
 * person on a clean address where reload does nothing at all.
 *
 * STAFF COME THROUGH THE SAME DOOR. /admin/auth/vesopa/start begins a sign-in
 * marked as staff; the callback then matches `hosting_admins` instead of
 * `customers`, by Vesopa subject first and verified address second, and never
 * creates one — an administrator is a row somebody with the owner role added.
 */

const express = require('express');

const auth = require('../auth');
const db = require('../db');
const { VESOPA_ONLY } = require('../config');
const { flash } = require('../http-utils');
const { createClient } = require('../vesopa_oidc');

const router = express.Router();

const ENABLED = String(process.env.VESOPA_AUTH_PANEL_ENABLED || '').toLowerCase() === 'on';

const PANEL_HOST = (process.env.PANEL_HOST || 'cloud.vesopa.com')
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\//, '');

const client = createClient({
  label: 'panel_sso',
  clientId: process.env.VESOPA_AUTH_PANEL_CLIENT_ID || '',
  clientSecret: process.env.VESOPA_AUTH_PANEL_CLIENT_SECRET || '',
  redirectUri: `https://${PANEL_HOST}/auth/vesopa/callback`,
  scope: 'openid profile email',
});

const LIVE = ENABLED && client.enabled;

/* linkAndFind's answer when the address is ours but the link is somebody else's. */
const LINKED_ELSEWHERE = Symbol('linked to another Vesopa account');

/* The marker on a staff sign-in's return address. Never a path a customer's
   `next=` could produce, because safeNext() only ever yields a path. */
const STAFF = 'staff:';

/*
 * Every view learns whether the option exists.
 *
 * Set as a local rather than fetched by the page: the sign-in page is rendered
 * by this server anyway, so there is no reason to make the browser ask a second
 * time — and no inline script to reason about against the content policy.
 */
router.use((req, res, nextMiddleware) => {
  res.locals.vesopaSso = LIVE;
  nextMiddleware();
});

/** Whether the sign-in page should draw the button, for anything that asks. */
router.get('/auth/vesopa/enabled', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: LIVE });
});

if (LIVE) {
  router.get('/auth/vesopa/start', (req, res) => {
    const hint = /^[^\s@]{1,120}@[^\s@]{1,120}$/.test(String(req.query.hint || '')) ? String(req.query.hint) : '';
    const { url } = client.begin({ returnTo: safeNext(req.query.next), select: req.query.switch === '1', hint });
    res.redirect(303, url);
  });

  router.get('/admin/auth/vesopa/start', (req, res) => {
    const { url, state } = client.begin({
      returnTo: STAFF + safeNext(req.query.next, '/admin'),
      select: req.query.switch === '1',
    });
    rememberStaffState(state);
    res.redirect(303, url);
  });

  router.get('/auth/vesopa/callback', async (req, res, next) => {
    try {
      let claims;
      let returnTo = '/panel';
      try {
        const result = await client.complete(req.query);
        claims = result.claims;
        returnTo = String(result.returnTo || '/panel');
      } catch (error) {
        console.warn('[panel_sso] sign-in did not complete:', error.message);
        /*
         * The one refusal worth wording: auth.vesopa.com turned the account
         * away from this application and the person chose "Back to Vesopa
         * Cloud". With self-enrolment on that means an administrator switched
         * it off on purpose, and "try your password" — there is no password —
         * would send them in circles.
         */
        const denied = String(req.query.error || '') === 'access_denied';
        const staff = isStaffReturn(req);
        return refuse(
          res,
          denied
            ? 'Your Vesopa account has not been given access to Vesopa Cloud. Ask us and we will add it.'
            : 'We could not finish signing you in with Vesopa. Please try again.',
          staff ? '/admin/login' : '/login',
        );
      }

      const staff = returnTo.startsWith(STAFF);
      staffStates.delete(String(req.query.state || ''));
      if (staff) returnTo = safeNext(returnTo.slice(STAFF.length), '/admin');
      else returnTo = safeNext(returnTo);

      /*
       * An unverified address proves nothing.
       *
       * Vesopa only says `email_verified: true` for an address it confirmed
       * itself, or one a provider it trusts confirmed. Matching a paying
       * customer on anything weaker would mean claiming somebody's address at a
       * provider we do not vet and being handed their hosting.
       */
      if (!claims.email || claims.email_verified !== true) {
        return refuse(
          res,
          'Your Vesopa account has no confirmed email address yet. Confirm it at auth.vesopa.com and try again.',
          staff ? '/admin/login' : '/login',
        );
      }

      if (staff) return signInStaff(req, res, claims, returnTo);

      let customer = await linkAndFind(claims);

      if (customer === LINKED_ELSEWHERE) {
        /*
         * Said in words, not a 500. One address, two Vesopa accounts — a
         * GitHub sign-in and an emailed-code sign-in that both carry it, say —
         * and the hosting is joined to the other one. The person is told
         * which fact matters and what to do about it; nothing is relinked.
         */
        return refuse(
          res,
          'This hosting account is already joined to a different Vesopa account with the same address. '
            + 'Use a different Vesopa account below and sign in with that one, or contact support.',
          '/login',
        );
      }

      if (!customer && VESOPA_ONLY) customer = await createCustomer(claims, req);

      if (!customer) {
        return refuse(
          res,
          'There is no hosting account for that address. Register first, then you can sign in with Vesopa.',
          '/login',
        );
      }
      if (customer.status === 'suspended') {
        return refuse(res, 'This account is suspended. Please contact support.', '/login');
      }
      if (customer.status === 'closed') {
        // Nothing that reveals a closed account is different from an unknown one.
        return refuse(res, 'We could not sign you in with that account. Please contact support.', '/login');
      }

      await db.query('UPDATE customers SET last_login_at = NOW() WHERE id = ?', [customer.id]);
      await db.logActivity({
        actorType: 'customer',
        actorId: customer.id,
        action: 'account.login.vesopa',
        target: customer.email,
        ip: req.ip,
      });

      /*
       * The panel's OWN session cookie, issued by the panel's own function.
       * Nothing downstream can tell which door somebody came through — which is
       * exactly what keeps the blast radius of this file at zero.
       */
      auth.issueCustomerSession(res, customer);
      return res.redirect(returnTo);
    } catch (error) {
      return next(error);
    }
  });
}

/** Back to a sign-in page with the reason, on an address a reload cannot replay. */
function refuse(res, message, to) {
  flash(res, message, 'error');
  return res.redirect(303, to);
}

/*
 * Which sign-in page a FAILED staff sign-in goes back to.
 *
 * The client consumes the state before it reports a failure, and the return
 * address went with it — so the states begun from /admin are also remembered
 * here, for ten minutes, which is longer than the client keeps them. Read once
 * and forgotten, like the state itself.
 */
const staffStates = new Map();
const STAFF_STATE_TTL_MS = 10 * 60_000;

function rememberStaffState(state) {
  const now = Date.now();
  for (const [key, at] of staffStates) if (now - at > STAFF_STATE_TTL_MS) staffStates.delete(key);
  staffStates.set(state, now);
}

function isStaffReturn(req) {
  const state = String(req.query.state || '');
  if (!state || !staffStates.has(state)) return false;
  staffStates.delete(state);
  return true;
}

/**
 * Find the customer this Vesopa account belongs to, and remember the link.
 *
 * By subject first, address second. Once linked, the address stops mattering —
 * which lets somebody change their email at either end without losing access,
 * and stops a recycled address matching an old customer years later.
 */
async function linkAndFind(claims) {
  const sub = String(claims.sub || '');
  const email = String(claims.email || '').trim().toLowerCase();

  const bySub = await db.one('SELECT * FROM customers WHERE vesopa_sub = ? LIMIT 1', [sub]);
  if (bySub) return bySub;

  const byEmail = await db.one('SELECT * FROM customers WHERE email = ? LIMIT 1', [email]);
  if (!byEmail) return null;

  /*
   * Refuse to steal a link that belongs to somebody else. Two people claiming
   * one customer row would mean whoever signed in most recently owns the
   * hosting, which is not a decision this code should make quietly.
   */
  if (byEmail.vesopa_sub && byEmail.vesopa_sub !== sub) {
    console.warn(`[panel_sso] customer ${byEmail.id} is already linked to another Vesopa account`);
    return LINKED_ELSEWHERE;
  }

  // Conditional, so two callbacks racing cannot both claim the row. A Vesopa
  // sign-in is also proof of the address, which is what `email_verified` means.
  await db.query(
    'UPDATE customers SET vesopa_sub = ?, vesopa_linked_at = NOW(), email_verified = 1 WHERE id = ? AND vesopa_sub IS NULL',
    [sub, byEmail.id],
  );

  return { ...byEmail, vesopa_sub: sub, email_verified: 1 };
}

/**
 * The first sign-in from an address we have never seen.
 *
 * What /register used to create, minus the password: an empty account with a
 * verified address, signed in straight away. `password_hash` is NOT NULL and
 * carries the session fingerprint (auth.passwordVersion), so it is filled with
 * a random string that no password can ever match — the password form is off,
 * and a value bcrypt cannot verify keeps it off even if the flag is flipped.
 *
 * The name is whatever Vesopa knows; a customer fills in the rest at checkout,
 * which is the first place a name and an address are actually needed.
 */
async function createCustomer(claims, req) {
  const email = String(claims.email || '').trim().toLowerCase();
  const sub = String(claims.sub || '');
  const given = String(claims.given_name || '').trim();
  const family = String(claims.family_name || '').trim();
  const whole = String(claims.name || '').trim();
  const firstName = (given || whole.split(/\s+/)[0] || '').slice(0, 80);
  const lastName = (family || whole.split(/\s+/).slice(1).join(' ') || '').slice(0, 80);
  const noPassword = `vesopa:${auth.newToken().hash}`;

  const result = await db.query(
    `INSERT INTO customers
       (email, password_hash, first_name, last_name, email_verified, vesopa_sub, vesopa_linked_at)
     VALUES (?, ?, ?, ?, 1, ?, NOW())`,
    [email, noPassword, firstName, lastName, sub],
  );
  const customer = await db.one('SELECT * FROM customers WHERE id = ? LIMIT 1', [result.insertId]);
  await db.logActivity({
    actorType: 'customer',
    actorId: customer.id,
    action: 'account.created',
    target: customer.email,
    detail: 'Created by the first Continue with Vesopa.',
    ip: req.ip,
  });
  return customer;
}

/**
 * A member of staff, matched and never created.
 *
 * By subject once linked, by verified address the first time. An address that
 * is not in `hosting_admins` — or is, but switched off — is turned away with
 * the same sentence either way, so this route cannot be used to find out who
 * works here.
 */
async function signInStaff(req, res, claims, returnTo) {
  const sub = String(claims.sub || '');
  const email = String(claims.email || '').trim().toLowerCase();

  let admin = await db.one('SELECT * FROM hosting_admins WHERE vesopa_sub = ? AND active = 1 LIMIT 1', [sub]);
  if (!admin) {
    const byEmail = await db.one('SELECT * FROM hosting_admins WHERE email = ? AND active = 1 LIMIT 1', [email]);
    if (byEmail && (!byEmail.vesopa_sub || byEmail.vesopa_sub === sub)) {
      await db.query(
        'UPDATE hosting_admins SET vesopa_sub = ?, vesopa_linked_at = NOW() WHERE id = ? AND (vesopa_sub IS NULL OR vesopa_sub = ?)',
        [sub, byEmail.id, sub],
      );
      admin = { ...byEmail, vesopa_sub: sub };
    }
  }

  if (!admin) {
    console.warn(`[panel_sso] staff sign-in refused for ${email}`);
    return refuse(res, 'That Vesopa account is not on the staff list for Vesopa Cloud.', '/admin/login');
  }

  await db.query('UPDATE hosting_admins SET last_login_at = NOW() WHERE id = ?', [admin.id]);
  await db.logActivity({ actorType: 'admin', actorId: admin.id, action: 'admin.login.vesopa', target: admin.email, ip: req.ip });
  auth.issueAdminSession(res, admin);
  return res.redirect(returnTo);
}

/** Only ever a path on this site — never a URL somebody handed us. */
function safeNext(value, fallback = '/panel') {
  const raw = String(value || '');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  return raw.slice(0, 200);
}

module.exports = { router, LIVE, client };
