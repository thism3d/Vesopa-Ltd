/**
 * Signing in to the hosting panel with a Vesopa account — Phase 6, migration
 * three.
 *
 * DORMANT UNTIL TURNED ON, like the menu and the back office before it. Nothing
 * here answers anything unless `VESOPA_AUTH_PANEL_ENABLED` is set and the
 * credentials are present, so rolling it back is a flag and a restart.
 *
 * THE PASSWORD FORM IS UNTOUCHED and stays open for the whole soak. Nobody is
 * moved, no password is reset, and a customer who has never heard of any of
 * this signs in exactly as they did yesterday.
 *
 * IT NEVER CREATES A CUSTOMER. That refusal is the important one here, and more
 * important than it was for the back office: a customer row is a BILLING
 * relationship, with services, invoices and a Hestia account behind it. "A
 * stranger arrived with a Vesopa account" is not a reason to create one. An
 * address we do not recognise is told to register in the ordinary way, and
 * nothing is written.
 */

const express = require('express');

const auth = require('../auth');
const db = require('../db');
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
    const { url } = client.begin({ returnTo: safeNext(req.query.next) });
    res.redirect(303, url);
  });

  router.get('/auth/vesopa/callback', async (req, res, next) => {
    try {
      let claims;
      let returnTo = '/panel';
      try {
        const result = await client.complete(req.query);
        claims = result.claims;
        returnTo = safeNext(result.returnTo);
      } catch (error) {
        console.warn('[panel_sso] sign-in did not complete:', error.message);
        return res.status(400).render('auth/login', {
          title: 'Sign in',
          robots: 'noindex',
          values: {},
          error: 'We could not finish signing you in with Vesopa. Please try your password.',
          next: '/panel',
        });
      }

      /*
       * An unverified address proves nothing.
       *
       * Vesopa only says `email_verified: true` for an address it confirmed
       * itself, or one a provider it trusts confirmed. Matching a paying
       * customer on anything weaker would mean claiming somebody's address at a
       * provider we do not vet and being handed their hosting.
       */
      if (!claims.email || claims.email_verified !== true) {
        return res.status(403).render('auth/login', {
          title: 'Sign in',
          robots: 'noindex',
          values: {},
          error: 'Your Vesopa account has no confirmed email address, so we cannot match it to a customer.',
          next: '/panel',
        });
      }

      const customer = await linkAndFind(claims);

      if (!customer) {
        return res.status(403).render('auth/login', {
          title: 'Sign in',
          robots: 'noindex',
          values: { email: claims.email },
          error:
            'There is no hosting account for that address. Register first, then you can sign in with Vesopa.',
          next: '/panel',
        });
      }
      if (customer.status === 'suspended') {
        return res.status(403).render('auth/login', {
          title: 'Sign in',
          robots: 'noindex',
          values: {},
          error: 'This account is suspended. Please contact support.',
          next: '/panel',
        });
      }
      if (customer.status === 'closed') {
        // The same wording the password form uses for a closed account, so this
        // route does not become a way of discovering which addresses exist.
        return res.status(403).render('auth/login', {
          title: 'Sign in',
          robots: 'noindex',
          values: {},
          error: 'That email address or password is not right.',
          next: '/panel',
        });
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
    throw new Error(`customer ${byEmail.id} is already linked to another Vesopa account`);
  }

  // Conditional, so two callbacks racing cannot both claim the row.
  await db.query(
    'UPDATE customers SET vesopa_sub = ?, vesopa_linked_at = NOW() WHERE id = ? AND vesopa_sub IS NULL',
    [sub, byEmail.id],
  );

  return { ...byEmail, vesopa_sub: sub };
}

/** Only ever a path on this site — never a URL somebody handed us. */
function safeNext(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/panel';
  return raw.slice(0, 200);
}

module.exports = { router, LIVE, client };
