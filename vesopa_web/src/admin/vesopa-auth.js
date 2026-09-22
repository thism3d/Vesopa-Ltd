/**
 * "Connect with Vesopa" for /admin — the only way in.
 *
 * The third first-party migration onto auth.vesopa.com, after the menu and the
 * back office:
 *
 *   IT NEEDS ITS CONFIGURATION. Nothing here answers unless
 *   VESOPA_AUTH_ADMIN_ENABLED=on and the client id, secret and issuer are all
 *   present; without them the login page says sign-in is unavailable.
 *
 *   THERE IS NO PASSWORD FORM. The owner removed it outright on 2026-09-22
 *   (see admin/index.js). Access is an admin_table row, enabled, whose Vesopa
 *   account can sign in to the "Vesopa EPOS Administration" application.
 *
 *   IT NEVER CREATES AN ADMIN. A Vesopa account is a person; an admin_table row
 *   is Vesopa Software deciding that person may see every venue's billing. The
 *   two are joined only where that decision already exists: an existing row,
 *   matched once by VERIFIED email and then linked by subject for good.
 *
 * The session it issues is the admin's ordinary signed cookie (admin-auth.js
 * issue()), so nothing downstream — requireAdmin, the contributor limits, the
 * sidebar — can tell which door somebody used. Roles still come from
 * admin_table.status, never from Vesopa.
 */

const express = require('express');

const { createClient } = require('../vesopa-oidc');

const flag = (name) => String(process.env[name] || '').trim().toLowerCase() === 'on';

const ADMIN_HOST = String(process.env.VESOPA_ADMIN_DOMAIN || 'vesopaepos.com')
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');

const client = createClient({
  label: 'admin_auth',
  clientId: process.env.VESOPA_AUTH_ADMIN_CLIENT_ID || '',
  clientSecret: process.env.VESOPA_AUTH_ADMIN_CLIENT_SECRET || '',
  redirectUri: `https://${ADMIN_HOST}/admin/auth/vesopa/callback`,
  scope: 'openid profile email',
});

const LIVE = flag('VESOPA_AUTH_ADMIN_ENABLED') && client.enabled;

/**
 * Find the admin a Vesopa sign-in belongs to, linking on first use.
 *
 * Subject first, address second. Once linked the address stops mattering, so an
 * email change at either end keeps access, and a recycled address somewhere
 * else can never match an old admin.
 *
 * Returns the row issue() needs, `{ blocked }` for a known-but-refused admin,
 * or null for nobody.
 */
async function linkAndFind(pool, claims) {
  const sub = String(claims.sub || '');
  const email = String(claims.email || '').trim().toLowerCase();
  if (!sub) return null;

  // Named columns: the row carries a bcrypt hash, and nothing here needs it.
  const columns = 'id, fullname, username, email, status, enabled, vesopa_sub';

  const [bySub] = await pool.query(`SELECT ${columns} FROM admin_table WHERE vesopa_sub = ? LIMIT 1`, [sub]);
  let row = bySub[0];

  if (!row) {
    // `email` is NULL on the two legacy logins; an empty string can never
    // match a NULL, and a missing claim is refused before we get here.
    if (!email) return null;
    const [byEmail] = await pool.query(
      `SELECT ${columns} FROM admin_table WHERE LOWER(email) = ? LIMIT 1`,
      [email]
    );
    row = byEmail[0];
    if (!row) return null;

    // Two Vesopa accounts claiming one admin is a thing for a person to look
    // at, never something to settle by whoever signed in last.
    if (row.vesopa_sub && row.vesopa_sub !== sub) {
      throw new Error(`admin_table ${row.id} is already linked to another Vesopa account`);
    }

    // Conditional, so two racing callbacks cannot both claim the row.
    await pool.query(
      'UPDATE admin_table SET vesopa_sub = ?, vesopa_linked_at = NOW() WHERE id = ? AND vesopa_sub IS NULL',
      [sub, row.id]
    );
  }

  // A disabled admin is refused however good their Vesopa sign-in (requireAdmin
  // re-checks this on every request too, so disabling ends a session at once).
  if (row.enabled !== 'Y') return { blocked: 'This admin account is disabled.' };

  return { id: row.id, fullname: row.fullname, username: row.username, status: row.status };
}

/**
 * @param pool   the site's own database
 * @param issue  admin-auth.js issue(res, admin) — reused, so the session is
 *               the one every /admin screen already checks
 * @param render (res, status, error) — draws the login page with a message
 */
function vesopaAdminRoutes({ pool, issue, render }) {
  const router = express.Router();

  if (!LIVE) {
    // Dormant, and honestly so: an auth path that does not exist yet is a 404,
    // not a "coming soon" page inviting somebody to poke at it.
    router.use('/auth/vesopa', (_req, res) => res.status(404).end());
    return router;
  }

  router.get('/auth/vesopa/start', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.redirect(302, client.begin().url);
  });

  router.get('/auth/vesopa/callback', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');

    let claims;
    try {
      ({ claims } = await client.complete(req.query));
    } catch (error) {
      console.warn('[admin_auth] sign-in not completed:', error.message);
      return render(res, 400, 'We could not finish signing you in with Vesopa. Please try again.');
    }

    /*
     * Only an address Vesopa itself has confirmed may match an admin. Matching
     * on anything less would let somebody claim a colleague's address at a
     * provider we do not vet and be handed the whole console.
     */
    if (!claims.email || claims.email_verified !== true) {
      return render(res, 403, 'Your Vesopa account has no confirmed email address, so it cannot be matched to an admin.');
    }

    try {
      const admin = await linkAndFind(pool, claims);
      if (!admin) {
        // Deliberately the same wording whether the address is unknown or not
        // an admin, so this page cannot be used to learn who the admins are.
        return render(res, 403, 'This Vesopa account does not have access to the admin console.');
      }
      if (admin.blocked) return render(res, 403, admin.blocked);

      issue(res, admin);
      console.info(`[admin_auth] admin ${admin.id} signed in with Vesopa`);
      // A contributor has no dashboard, so they land on the File Manager.
      return res.redirect(303, admin.status === 'Contributor' ? '/admin/files' : '/admin/dashboard');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { vesopaAdminRoutes, linkAndFind, LIVE, client };
