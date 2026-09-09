/**
 * The administrator's console — Phase 5.
 *
 * Gated on `users.is_staff`, which only the seed sets and only an existing
 * administrator can grant.
 *
 * IT IS LAID OUT LIKE THE ACCOUNT AREA, on purpose. An identity provider's
 * console is a lot of small unrelated things, and somebody arrives looking for
 * exactly one of them — so it is a rail of named destinations with a distinct
 * mark against each, the same shape a person already knows from managing their
 * own account. Nobody has to learn a second layout to run the service.
 *
 * THE FIGURES COME FROM ROLLUPS, NEVER FROM A `GROUP BY` OVER RAW EVENTS. That
 * is the rule from the plan and it is not a preference: `login_events` is kept
 * for thirteen months, and a dashboard that scans it is the thing that falls
 * over first on a busy Saturday — at which point the dashboard is the outage.
 * The live counts that remain are bounded lookups on indexed columns.
 *
 * WHAT IS DELIBERATELY NOT HERE. Signing in as another person. It is the
 * feature every admin console grows and the one that most quietly undermines an
 * identity provider, because it makes "the account did this" untrue. What is
 * built instead is read-only: an administrator can see what a person's account
 * looks like and cannot act as them.
 */

const express = require('express');

const config = require('../config');
const db = require('../db');
const sessions = require('../sessions');
const settings = require('../settings');
const events = require('../events');
const rollups = require('../rollups');
const csrf = require('../csrf');
const { normaliseEmail, normalisePhone } = require('../normalise');

const router = express.Router();

const RAIL = [
  { href: '/admin', label: 'Overview', icon: 'home', tint: 'brand' },
  { href: '/admin/people', label: 'People', icon: 'people', tint: 'blue' },
  { href: '/admin/applications', label: 'Applications', icon: 'apps', tint: 'violet' },
  { href: '/admin/activity', label: 'Activity', icon: 'chart', tint: 'teal' },
  { href: '/admin/health', label: 'Health', icon: 'shield', tint: 'amber' },
  { href: '/admin/settings', label: 'Sign-in page', icon: 'settings', tint: 'pink' },
  { group: 'Elsewhere' },
  { href: '/developers', label: 'Developer portal', icon: 'code', tint: 'slate' },
  { href: '/account/profile', label: 'Your account', icon: 'person', tint: 'slate' },
];

async function requireAdmin(req, res) {
  const session = await sessions.load(req);
  if (!session) {
    res.redirect(303, `/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  if (!session.is_staff) {
    /*
     * 404, not 403. Telling somebody "this exists and you may not have it"
     * confirms there is an administration area at this address and invites
     * them to go looking for a way in.
     */
    res.status(404).render('error', {
      title: 'Page not found',
      heading: 'That page is not here',
      message: 'The link may be old, or it may have been mistyped.',
      config,
      nonce: res.locals.nonce,
      noindex: true,
    });
    return null;
  }
  await sessions.touch(session);
  return session;
}

function page(res, view, session, extra = {}) {
  return res.render(view, {
    nonce: res.locals.nonce,
    config,
    session,
    noindex: true,
    railTitle: 'Administration',
    railHome: '/admin',
    rail: RAIL,
    styles: ['console'],
    saved: false,
    error: '',
    ...extra,
  });
}

// ===========================================================================
// Overview
// ===========================================================================

router.get('/admin', async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    // At most once an hour, and never blocking: a stale chart is better than a
    // slow page, and far better than a failed one.
    await rollups.refreshIfStale();

    const [totals, series, mix, recent] = await Promise.all([
      db.one(`
        SELECT
          (SELECT COUNT(*) FROM users WHERE status = 'active')            AS people,
          (SELECT COUNT(*) FROM users
            WHERE status = 'active'
              AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY))          AS people_new,
          (SELECT COUNT(*) FROM applications
            WHERE status = 'active' AND deleted_at IS NULL)               AS applications,
          (SELECT COUNT(*) FROM sso_sessions
            WHERE revoked_at IS NULL AND expires_at > NOW()
              AND idle_expires_at > NOW())                                AS live_sessions,
          (SELECT COUNT(*) FROM user_passkeys WHERE revoked_at IS NULL)   AS passkeys,
          (SELECT COUNT(*) FROM user_totp
            WHERE confirmed_at IS NOT NULL AND revoked_at IS NULL)        AS authenticators,
          (SELECT COUNT(*) FROM login_events
            WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR))         AS events_today,
          (SELECT COUNT(*) FROM login_events
            WHERE outcome = 'failure'
              AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR))         AS failures_today
      `),
      rollups.series(14),
      rollups.methodMix(30),
      db.query(`
        SELECT action, actor_type, target_type, target_id, ip, created_at
          FROM audit_log
         ORDER BY id DESC
         LIMIT 8
      `),
    ]);

    /*
     * How many people can survive losing their phone.
     *
     * The single most useful number on this page, and not one any dashboard
     * shows by default: an account whose only way in is an emailed code is an
     * account that is exactly as secure as its mailbox. Watching it rise is how
     * you know the MFA work was worth doing.
     */
    const strong = await db.one(`
      SELECT COUNT(DISTINCT u.id) AS total
        FROM users u
        LEFT JOIN user_passkeys k ON k.user_id = u.id AND k.revoked_at IS NULL
        LEFT JOIN user_totp t ON t.user_id = u.id
             AND t.confirmed_at IS NOT NULL AND t.revoked_at IS NULL
       WHERE u.status = 'active' AND (k.id IS NOT NULL OR t.id IS NOT NULL)
    `);

    return page(res, 'admin/overview', session, {
      title: 'Administration',
      path: '/admin',
      totals,
      strong: strong.total,
      series,
      mix,
      recent,
    });
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// People
// ===========================================================================

router.get('/admin/people', async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    const search = String(req.query.q || '').trim().slice(0, 190);
    let people = [];

    /*
     * NOTHING IS LISTED UNTIL SOMETHING IS SEARCHED FOR.
     *
     * A console that opens on "every account, newest first" turns a curious
     * afternoon into a browse of the customer list, and every one of those
     * views is a person's data. Searching is an act with an intent behind it,
     * and it is the act this page audits.
     */
    if (search) {
      /*
       * Matched three ways, in one query, because an administrator handed a
       * detail by a customer on the telephone does not know which kind it is.
       * The identifier is normalised the same way it was when it was stored —
       * `Bob@Gmail.com` and `b.ob@gmail.com` are the same mailbox, and a search
       * that misses that is a search that fails on the commonest address in
       * Britain.
       */
      people = await db.query(
        `SELECT DISTINCT u.id, u.public_id, u.display_name, u.status, u.is_staff,
                u.is_developer, u.created_at, u.last_login_at,
                (SELECT i.identifier FROM user_identities i WHERE i.id = u.primary_email_id) AS email
           FROM users u
           LEFT JOIN user_identities i ON i.user_id = u.id AND i.revoked_at IS NULL
          WHERE u.public_id = ?
             OR i.identifier_norm = ?
             OR i.identifier_norm = ?
             OR u.display_name LIKE ?
          ORDER BY u.last_login_at IS NULL, u.last_login_at DESC
          LIMIT 50`,
        [search, normaliseEmail(search), normalisePhone(search) || ' ', `%${search}%`],
      );

      await events.recordAudit({
        actorUserId: session.user_id,
        actorType: 'admin',
        action: 'admin.searched',
        targetType: 'users',
        targetId: search.slice(0, 64),
        ip: req.clientIp,
        userAgent: req.userAgent,
      });
    }

    return page(res, 'admin/people', session, {
      title: 'People',
      path: '/admin/people',
      search,
      people,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/people/:publicId', async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    const person = await db.one('SELECT * FROM users WHERE public_id = ?', [req.params.publicId]);
    if (!person) {
      return res.status(404).render('error', {
        title: 'Page not found',
        heading: 'No such account',
        message: 'It may have been deleted.',
        config,
        nonce: res.locals.nonce,
        session,
        noindex: true,
      });
    }

    const [identities, factors, memberships, history, devices] = await Promise.all([
      db.query(
        `SELECT id, type, identifier, provider_id, verified_at, revoked_at, created_at
           FROM user_identities WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, id`,
        [person.id],
      ),
      db.one(
        `SELECT
           (SELECT COUNT(*) FROM user_passwords WHERE user_id = ?)                     AS passwords,
           (SELECT COUNT(*) FROM user_passkeys
             WHERE user_id = ? AND revoked_at IS NULL)                                 AS passkeys,
           (SELECT COUNT(*) FROM user_totp
             WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL)    AS totp,
           (SELECT COUNT(*) FROM user_recovery_codes
             WHERE user_id = ? AND used_at IS NULL)                                    AS recovery`,
        [person.id, person.id, person.id, person.id],
      ),
      db.query(
        `SELECT a.name, a.client_id, m.status, m.last_seen_at
           FROM application_members m
           JOIN applications a ON a.id = m.application_id
          WHERE m.user_id = ? ORDER BY m.last_seen_at IS NULL, m.last_seen_at DESC`,
        [person.id],
      ),
      db.query(
        `SELECT method, outcome, failure_reason, ip, country, created_at
           FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
        [person.id],
      ),
      db.query(
        `SELECT id, name, platform, browser, last_seen_at, last_ip, revoked_at
           FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 10`,
        [person.id],
      ),
    ]);

    /*
     * Looking at somebody's account is recorded, and the person can see it.
     * An admin-assisted route into an account is only safe because it is
     * observable — and observable by the customer, not only by us.
     */
    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'admin',
      action: 'admin.viewed_account',
      targetType: 'user',
      targetId: person.public_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return page(res, 'admin/person', session, {
      title: person.display_name || 'Account',
      path: '/admin/people',
      person,
      identities,
      factors,
      memberships,
      history,
      devices,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Suspend or restore an account, and grant or withdraw staff and developer
 * access. The four things an administrator genuinely needs and none of the ones
 * that would let them become somebody else.
 */
router.post('/admin/people/:publicId', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    const person = await db.one('SELECT * FROM users WHERE public_id = ?', [req.params.publicId]);
    if (!person) return res.redirect(303, '/admin/people');

    const action = String(req.body.action || '');
    const to = (query) => res.redirect(303, `/admin/people/${person.public_id}?${query}`);

    /*
     * An administrator cannot suspend or demote themselves. Not paternalism —
     * it is the one mistake with no way back, because the page that could undo
     * it is the page they have just locked themselves out of.
     */
    if (person.id === session.user_id && action !== 'note') {
      return to(`error=${encodeURIComponent('You cannot change your own access from here.')}`);
    }

    if (action === 'suspend' || action === 'restore') {
      const status = action === 'suspend' ? 'suspended' : 'active';
      await db.execute('UPDATE users SET status = ?, suspended_reason = ? WHERE id = ?', [
        status,
        action === 'suspend' ? String(req.body.reason || '').slice(0, 255) : '',
        person.id,
      ]);
      if (action === 'suspend') {
        // Suspending somebody who is signed in and leaving their session alive
        // is not suspending them.
        await db.execute(
          "UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = 'suspended' WHERE user_id = ? AND revoked_at IS NULL",
          [person.id],
        );
        await db.execute(
          'UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
          [person.id],
        );
      }
    } else if (action === 'staff' || action === 'developer') {
      const column = action === 'staff' ? 'is_staff' : 'is_developer';
      const value = req.body.value === '1' ? 1 : 0;
      await db.execute(`UPDATE users SET ${column} = ? WHERE id = ?`, [value, person.id]);
    } else {
      return to('error=' + encodeURIComponent('Unknown action.'));
    }

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'admin',
      action: `admin.${action}`,
      targetType: 'user',
      targetId: person.public_id,
      detail: { value: req.body.value, reason: req.body.reason },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return to('saved=1');
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// Applications
// ===========================================================================

router.get('/admin/applications', async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    const applications = await db.query(`
      SELECT a.*, o.name AS organisation_name,
             (SELECT COUNT(*) FROM application_members m
               WHERE m.application_id = a.id AND m.status = 'active') AS people,
             (SELECT COUNT(*) FROM application_secrets s
               WHERE s.application_id = a.id AND s.revoked_at IS NULL) AS secrets,
             (SELECT COUNT(*) FROM application_redirect_uris r
               WHERE r.application_id = a.id AND r.kind = 'login') AS redirects
        FROM applications a
        JOIN organisations o ON o.id = a.organisation_id
       ORDER BY a.deleted_at IS NOT NULL, a.is_first_party DESC, a.name
    `);

    return page(res, 'admin/applications', session, {
      title: 'Applications',
      path: '/admin/applications',
      applications,
    });
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// Activity
// ===========================================================================

router.get('/admin/activity', async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;
    await rollups.refreshIfStale();

    const [mix, series, audit] = await Promise.all([
      rollups.methodMix(30),
      rollups.series(30),
      db.query(`
        SELECT a.action, a.actor_type, a.target_type, a.target_id, a.ip, a.created_at,
               u.display_name AS actor_name
          FROM audit_log a
          LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY a.id DESC
         LIMIT 60
      `),
    ]);

    const state = await db.one("SELECT ran_at FROM rollup_state WHERE name = 'login_daily'");

    return page(res, 'admin/activity', session, {
      title: 'Activity',
      path: '/admin/activity',
      mix,
      series,
      audit,
      ranAt: state ? state.ran_at : null,
    });
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// Health
// ===========================================================================

router.get('/admin/health', async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    /*
     * The four things that break a sign-in for everybody at once, checked
     * rather than assumed. Each one has taken this service down at least
     * conceptually, and none of them is visible from the outside: the site
     * answers 200 all the way through.
     */
    const providers = require('../providers');

    let database = null;
    try {
      database = await db.check();
    } catch (error) {
      database = { error: error.message };
    }

    const keys = await db.query(
      `SELECT kid, algorithm, status, created_at, activated_at, retired_at
         FROM signing_keys ORDER BY FIELD(status,'active','next','retired'), id DESC`,
    );

    const enabled = providers.enabled();
    const all = ['google', 'apple', 'microsoft', 'github'];

    const mail = await db.one(`
      SELECT COUNT(*) AS sent_24h FROM verification_challenges
       WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
    `);

    return page(res, 'admin/health', session, {
      title: 'Health',
      path: '/admin/health',
      database,
      keys,
      providers: all.map((key) => ({
        key,
        on: enabled.some((row) => row.key === key),
        name: (enabled.find((row) => row.key === key) || {}).name || key,
      })),
      mail,
      version: config.version,
      issuer: config.issuer,
    });
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// The sign-in page
// ===========================================================================

router.get('/admin/settings', async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    return page(res, 'admin/settings', session, {
      title: 'Sign-in page',
      path: '/admin/settings',
      settings: await settings.all(),
      definitions: settings.DEFINITIONS,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/admin/settings', csrf.verify, async (req, res, next) => {
  try {
    const session = await requireAdmin(req, res);
    if (!session) return undefined;

    const changed = [];
    for (const name of Object.keys(settings.DEFINITIONS)) {
      if (!(name in req.body)) continue;
      // eslint-disable-next-line no-await-in-loop -- a handful of settings
      const result = await settings.set(name, req.body[name], session.user_id);
      if (!result.ok) {
        return res.redirect(
          303,
          `/admin/settings?error=${encodeURIComponent(`${name} could not be set: ${result.error}`)}`,
        );
      }
      changed.push(name);
    }

    /*
     * Audited like everything else an administrator does. A change to how the
     * sign-in page behaves is a change every user sees, and "who turned that
     * on, and when" should never be a matter of memory.
     */
    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'admin',
      action: 'settings.updated',
      targetType: 'settings',
      targetId: changed.join(','),
      detail: Object.fromEntries(changed.map((name) => [name, req.body[name]])),
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.redirect(303, '/admin/settings?saved=1');
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
