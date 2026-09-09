/**
 * The account area: what a person can see and change about themselves.
 *
 * The owner's list, and where each part lives:
 *
 *   profile image, name, date of birth         /account/profile
 *   link phone, recovery phone, recovery email
 *   link Google, Microsoft, Apple, GitHub      /account/linked
 *   authenticator app, passkeys, password      /account/security
 *   devices and the addresses they signed in from  /account/devices
 *   login history                              /account/history
 *   connected apps, with revoke                /account/apps
 *
 * EVERY DESTRUCTIVE ACTION HERE IS A POST WITH A CSRF TOKEN, and several of
 * them notify the person by email afterwards. A change somebody did not make is
 * the only warning they will ever get that their session is not theirs alone.
 */

const express = require('express');
const multer = require('multer');

const config = require('../config');
const avatars = require('../avatars');
const db = require('../db');
const sessions = require('../sessions');
const identity = require('../identity');
const challenges = require('../challenges');
const events = require('../events');
const webhooks = require('../webhooks');
const csrf = require('../csrf');
const providers = require('../providers');
const tokens = require('../oauth/tokens');
const { hashPassword, verifyPassword } = require('../crypto');
const { normaliseEmail, normalisePhone } = require('../normalise');

const router = express.Router();

/** Every page here needs a live session; an expired one comes back afterwards. */
async function guard(req, res) {
  const session = await sessions.load(req);
  if (!session) {
    res.redirect(303, `/login?return_to=${encodeURIComponent(req.originalUrl)}`);
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
    /*
     * The console shell — the same one the administrator's pages and the
     * developer portal use. `_shell.ejs` builds the rail; all the route has to
     * do is ask for the stylesheet that draws it.
     */
    styles: ['console'],
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

router.get('/account/profile', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const user = await identity.getUser(session.user_id);
    return page(res, 'account/profile', session, {
      title: 'Your profile',
      user,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/account/profile', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    /*
     * Date of birth is stored as a DATE or not at all. An empty string written
     * into a DATE column becomes '0000-00-00' on some MariaDB settings, which
     * then formats as a real date in the year zero and is impossible to clear
     * through the form.
     */
    const dob = String(req.body.date_of_birth || '').trim();
    const validDob = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null;

    await db.execute(
      `UPDATE users
          SET display_name = ?, given_name = ?, family_name = ?, date_of_birth = ?
        WHERE id = ?`,
      [
        String(req.body.display_name || '').slice(0, 120),
        String(req.body.given_name || '').slice(0, 80),
        String(req.body.family_name || '').slice(0, 80),
        validDob,
        session.user_id,
      ],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'profile.updated',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
    });

    /*
     * Tell every application that holds this person. Their copy of the name is
     * now wrong, and an application that has to poll to find that out will
     * never bother.
     */
    await webhooks.emitForUser(session.user_id, 'user.updated', async (user, subject) => ({
      sub: subject,
      name: user.display_name || undefined,
      given_name: user.given_name || undefined,
      family_name: user.family_name || undefined,
      birthdate: user.date_of_birth ? String(user.date_of_birth).slice(0, 10) : undefined,
      picture: user.avatar_path ? `${config.issuer}${user.avatar_path}` : undefined,
    }));

    return res.redirect(303, '/account/profile?saved=1');
  } catch (error) {
    return next(error);
  }
});

/*
 * Profile picture upload.
 *
 * IN MEMORY, NOT TO A TEMPORARY FILE, and capped before anything is read. A
 * disk-backed upload on a public endpoint is a way to fill the partition that
 * MariaDB is also using; two megabytes held briefly in memory is not.
 *
 * The type is checked twice — here on what the browser claimed, and again in
 * avatars.js on what actually arrived — because a `Content-Type` header is
 * something the client chooses.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: avatars.MAX_BYTES, files: 1 },
  fileFilter(req, file, callback) {
    if (avatars.TYPES[file.mimetype]) return callback(null, true);
    return callback(null, false);
  },
});

router.post('/account/avatar', upload.single('avatar'), csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    if (!req.file) {
      return res.redirect(
        303,
        '/account/profile?error=' +
          encodeURIComponent('Choose a JPEG, PNG, WebP or GIF image under 2 MB.'),
      );
    }

    await avatars.store(session.user_id, session.user_public_id, req.file.buffer, req.file.mimetype);
    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'profile.avatar_changed',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
    });

    return res.redirect(303, '/account/profile?saved=1');
  } catch (error) {
    if (String(error.message || '').includes('unsupported image type')) {
      return res.redirect(
        303,
        '/account/profile?error=' + encodeURIComponent('That file is not an image we can use.'),
      );
    }
    return next(error);
  }
});

router.post('/account/avatar/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    await avatars.clear(session.user_id);
    return res.redirect(303, '/account/profile?saved=1');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

router.get('/account/security', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const [totp, passkeys, password, recovery] = await Promise.all([
      db.one(
        'SELECT id, label, created_at, last_used_at FROM user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL',
        [session.user_id],
      ),
      db.query(
        `SELECT id, name, device_type, backup_state, created_at, last_used_at
           FROM user_passkeys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at`,
        [session.user_id],
      ),
      db.one(
        'SELECT created_at FROM user_passwords WHERE user_id = ? AND retired_at IS NULL',
        [session.user_id],
      ),
      db.one(
        'SELECT COUNT(*) AS remaining FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
        [session.user_id],
      ),
    ]);

    return page(res, 'account/security', session, {
      title: 'Security',
      totp,
      passkeys,
      hasPassword: Boolean(password),
      passwordSince: password ? password.created_at : null,
      recoveryRemaining: recovery ? recovery.remaining : 0,
      error: req.query.error || '',
      saved: req.query.saved === '1',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Set or change a password.
 *
 * The owner's rule: once verified, a person may choose a password as a faster
 * way back in. Most never will, and that must stay free — the code works every
 * time.
 */
router.post('/account/password', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const next_password = String(req.body.password || '');
    if (next_password.length < 12) {
      return res.redirect(303, '/account/security?error=Passwords+must+be+at+least+12+characters.');
    }

    const existing = await db.one(
      'SELECT password_hash FROM user_passwords WHERE user_id = ? AND retired_at IS NULL',
      [session.user_id],
    );

    // Changing an existing password costs the old one. Setting a first password
    // does not, because the session was already earned by a code or a provider.
    if (existing) {
      const good = await verifyPassword(
        existing.password_hash,
        req.body.current_password || '',
        config.secrets.passwordPepper,
      );
      if (!good) {
        return res.redirect(303, '/account/security?error=That+current+password+is+not+right.');
      }
    }

    const hash = await hashPassword(next_password, config.secrets.passwordPepper);
    await db.transaction(async (tx) => {
      await tx.execute(
        'UPDATE user_passwords SET retired_at = NOW() WHERE user_id = ? AND retired_at IS NULL',
        [session.user_id],
      );
      await tx.execute(
        'INSERT INTO user_passwords (user_id, password_hash, algorithm) VALUES (?, ?, ?)',
        [session.user_id, hash, 'argon2id'],
      );
    });

    /*
     * A password change ends every OTHER session. Somebody changing their
     * password because they think they have been compromised expects exactly
     * that, and would be right to be angry if the intruder stayed signed in.
     */
    await db.execute(
      `UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = 'password_changed'
        WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
      [session.user_id, session.id],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      action: existing ? 'password.changed' : 'password.set',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    await notify(session.user_id, {
      heading: existing ? 'Your password was changed' : 'A password was set on your account',
      body: 'Every other device has been signed out.',
      req,
    });

    return res.redirect(303, '/account/security?saved=1');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Linked accounts
// ---------------------------------------------------------------------------

router.get('/account/linked', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const linked = await identity.identitiesOf(session.user_id);
    const held = new Set(linked.map((row) => row.type));

    return page(res, 'account/linked', session, {
      title: 'Linked accounts',
      linked,
      // Only providers this server can actually complete are offered.
      available: providers.enabled().filter((provider) => !held.has(provider.key)),
      methodCount: await identity.countAuthMethods(session.user_id),
      error: req.query.error || '',
      saved: req.query.saved === '1',
    });
  } catch (error) {
    return next(error);
  }
});

/** Add an email address or phone number. Verified by code before it counts. */
router.post('/account/linked/add', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const type = req.body.type === 'phone' ? 'phone' : 'email';
    const typed = String(req.body.value || '').trim();
    const normalised = type === 'email' ? normaliseEmail(typed) : normalisePhone(typed, 'GB');

    if (!normalised) {
      return res.redirect(303, `/account/linked?error=That+${type}+does+not+look+right.`);
    }

    // Already somebody's? The index would refuse it anyway; saying so plainly
    // is better than a duplicate-key error page.
    const taken = await identity.findIdentity(type, normalised);
    if (taken) {
      const message =
        taken.user_id === session.user_id
          ? 'You have already added that.'
          : 'That is already in use on another Vesopa account.';
      return res.redirect(303, `/account/linked?error=${encodeURIComponent(message)}`);
    }

    const result = await challenges.create({
      channel: type === 'email' ? 'email' : 'sms',
      purpose: 'link_identity',
      destination: typed,
      destinationNorm: normalised,
      userId: session.user_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    if (!result.ok) {
      return res.redirect(303, '/account/linked?error=We+could+not+send+a+code+to+that.');
    }

    return page(res, 'account/confirm-identity', session, {
      title: 'Confirm it is yours',
      type,
      destination: typed,
      normalised,
      isRecovery: req.body.recovery === '1',
      challengeId: result.challengeId,
      error: '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/account/linked/confirm', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const check = await challenges.verify({
      challengeId: req.body.challenge_id,
      code: req.body.code,
      ip: req.clientIp,
    });
    if (!check.ok) {
      return page(res, 'account/confirm-identity', session, {
        title: 'Confirm it is yours',
        type: req.body.type,
        destination: req.body.destination,
        normalised: req.body.normalised,
        isRecovery: req.body.recovery === '1',
        challengeId: req.body.challenge_id,
        error: 'That code is not right. Check it and try again.',
      });
    }

    /*
     * The challenge must have been raised BY THIS PERSON FOR THIS PURPOSE.
     * Without both checks, a code sent to verify a new address could be
     * presented here to attach somebody else's address to this account.
     */
    if (check.challenge.user_id !== session.user_id || check.challenge.purpose !== 'link_identity') {
      return res.redirect(303, '/account/linked?error=That+code+was+not+for+this.');
    }

    try {
      await identity.attachIdentity(session.user_id, {
        type: req.body.type === 'phone' ? 'phone' : 'email',
        identifier: check.challenge.destination,
        normalised: check.challenge.destination_norm,
        verified: true,
        verifiedVia: check.challenge.channel === 'sms' ? 'sms' : 'email_code',
        isRecovery: req.body.recovery === '1',
      });
    } catch (error) {
      if (!db.isDuplicate(error)) throw error;
      return res.redirect(303, '/account/linked?error=That+is+already+in+use.');
    }

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'identity.linked',
      targetType: 'identity',
      targetId: req.body.type,
      ip: req.clientIp,
    });

    await webhooks.emitForUser(session.user_id, 'identity.linked', async (user, subject) => ({
      sub: subject,
      type: req.body.type === 'phone' ? 'phone' : 'email',
    }));
    await notify(session.user_id, {
      heading: 'Something was added to your account',
      body: `${check.challenge.destination} can now be used with your Vesopa account.`,
      req,
    });

    return res.redirect(303, '/account/linked?saved=1');
  } catch (error) {
    return next(error);
  }
});

router.post('/account/linked/:id/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const result = await identity.revokeIdentity(session.user_id, req.params.id, 'user');
    if (!result.ok) {
      const messages = {
        last_auth_method:
          'That is your only way of signing in. Add another first, or delete the account.',
        not_found: 'That was not found on your account.',
      };
      return res.redirect(
        303,
        `/account/linked?error=${encodeURIComponent(messages[result.error] || 'Could not remove that.')}`,
      );
    }

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'identity.unlinked',
      targetType: 'identity',
      targetId: String(req.params.id),
      detail: { type: result.identity.type },
      ip: req.clientIp,
    });

    /*
     * The identifier is FREE NOW — under the owner's rule it can be claimed by
     * a different Vesopa account this afternoon. An application still treating
     * it as this person's address would then be wrong about who somebody is,
     * which is the worst kind of stale copy, so this event matters more than it
     * looks.
     */
    await webhooks.emitForUser(session.user_id, 'identity.unlinked', async (user, subject) => ({
      sub: subject,
      type: result.identity.type,
    }));
    await notify(session.user_id, {
      heading: 'Something was removed from your account',
      body: `${result.identity.identifier} can no longer be used with your Vesopa account. It is now free to be added to another account.`,
      req,
    });

    return res.redirect(303, '/account/linked?saved=1');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Devices, history, connected apps
// ---------------------------------------------------------------------------

router.get('/account/devices', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    return page(res, 'account/devices', session, {
      title: 'Your devices',
      devices: await sessions.listDevices(session.user_id),
      liveSessions: await sessions.listForUser(session.user_id),
      describeDevice: sessions.describeDevice,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/account/devices/:id/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    await sessions.revokeDevice(session.user_id, req.params.id);
    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'device.revoked',
      targetType: 'device',
      targetId: String(req.params.id),
      ip: req.clientIp,
    });
    return res.redirect(303, '/account/devices');
  } catch (error) {
    return next(error);
  }
});

router.post('/account/signout-everywhere', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const ended = await sessions.revokeAllForUser(session.user_id, 'signout_everywhere');
    /*
     * Refresh tokens as well as sessions. Ending only the browser sessions
     * would leave every application still able to mint access tokens, and
     * "sign out everywhere" would be a button that did almost nothing — which
     * is worse than not offering it.
     */
    await db.execute(
      `UPDATE oauth_refresh_tokens SET revoked_at = NOW(), revoked_reason = 'signout_everywhere'
        WHERE user_id = ? AND revoked_at IS NULL`,
      [session.user_id],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'session.signout_everywhere',
      targetType: 'user',
      targetId: session.user_public_id,
      detail: { sessions: ended },
      ip: req.clientIp,
    });

    await webhooks.emitForUser(session.user_id, 'session.revoked', async (user, subject) => ({
      sub: subject,
      reason: 'signed_out_everywhere',
    }));

    sessions.clearCookie(res);
    return res.redirect(303, '/login');
  } catch (error) {
    return next(error);
  }
});

router.get('/account/history', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const history = await db.query(
      `SELECT e.method, e.outcome, e.failure_reason, e.ip, e.country, e.user_agent,
              e.created_at, a.name AS application_name
         FROM login_events e
         LEFT JOIN applications a ON a.id = e.application_id
        WHERE e.user_id = ?
        ORDER BY e.created_at DESC
        LIMIT 100`,
      [session.user_id],
    );
    return page(res, 'account/history', session, {
      title: 'Sign-in history',
      history,
      describeDevice: sessions.describeDevice,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/account/apps', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const apps = await db.query(
      `SELECT a.id, a.name, a.description, a.logo_path, a.homepage_url,
              a.is_first_party, o.name AS organisation_name,
              c.scope, c.granted_at,
              m.last_seen_at
         FROM application_members m
         JOIN applications a ON a.id = m.application_id
         JOIN organisations o ON o.id = a.organisation_id
         LEFT JOIN oauth_consents c
                ON c.application_id = a.id AND c.user_id = m.user_id AND c.revoked_at IS NULL
        WHERE m.user_id = ? AND m.status = 'active'
        ORDER BY m.last_seen_at DESC`,
      [session.user_id],
    );
    return page(res, 'account/apps', session, { title: 'Connected apps', apps });
  } catch (error) {
    return next(error);
  }
});

router.post('/account/apps/:id/revoke', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    await db.transaction(async (tx) => {
      await tx.execute(
        'UPDATE oauth_consents SET revoked_at = NOW() WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL',
        [session.user_id, req.params.id],
      );
      await tx.execute(
        "UPDATE application_members SET status = 'removed' WHERE user_id = ? AND application_id = ?",
        [session.user_id, req.params.id],
      );
    });
    await tokens.revokeForUserAndApplication(session.user_id, req.params.id, 'user_revoked');

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'application.revoked',
      targetType: 'application',
      targetId: String(req.params.id),
      ip: req.clientIp,
    });

    /*
     * Told to the application being disconnected, and to it alone. It is the
     * one that must stop using the tokens it holds — and telling anybody else
     * that this person left would be reporting somebody's behaviour to a third
     * party, which is not what an identity provider is for.
     */
    const revoked = await db.one('SELECT id FROM applications WHERE id = ?', [req.params.id]);
    if (revoked) {
      const application = await db.one(
        'SELECT id, client_id, subject_type, sector_salt FROM applications WHERE id = ?',
        [revoked.id],
      );
      const person = await identity.getUser(session.user_id);
      await webhooks.emit(application.id, 'consent.revoked', {
        subject: tokens.subjectFor(application, person.public_id),
        payload: { sub: tokens.subjectFor(application, person.public_id) },
      });
    }

    return res.redirect(303, '/account/apps');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/*
 * A working route to delete an account is not optional: Apple requires it of
 * anything offering Sign in with Apple, and UK GDPR gives the right to erasure
 * regardless. It is also read by the OAuth reviewers, so it must resolve.
 */
router.get('/account/delete', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    return page(res, 'account/delete', session, {
      title: 'Delete your account',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/account/delete', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      return res.redirect(303, '/account/delete?error=Type+DELETE+to+confirm.');
    }

    /*
     * Marked, not erased, and the grace period is the reason.
     *
     * An account deleted the instant somebody clicks is an account a stranger
     * with a borrowed session can destroy, and a person who changes their mind
     * cannot recover. The identifiers are revoked immediately — so they become
     * free for use elsewhere at once, which is the behaviour the owner asked
     * for — and the row itself is purged by the sweeper after the published
     * thirty days.
     */
    await db.transaction(async (tx) => {
      await tx.execute(
        "UPDATE users SET status = 'deleted', deletion_requested_at = NOW() WHERE id = ?",
        [session.user_id],
      );
      await tx.execute(
        "UPDATE user_identities SET revoked_at = NOW(), revoked_reason = 'account_deleted' WHERE user_id = ? AND revoked_at IS NULL",
        [session.user_id],
      );
      await tx.execute(
        "UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = 'account_deleted' WHERE user_id = ? AND revoked_at IS NULL",
        [session.user_id],
      );
      await tx.execute(
        "UPDATE oauth_refresh_tokens SET revoked_at = NOW(), revoked_reason = 'account_deleted' WHERE user_id = ? AND revoked_at IS NULL",
        [session.user_id],
      );
    });

    await events.recordAudit({
      actorUserId: session.user_id,
      action: 'account.deletion_requested',
      targetType: 'user',
      targetId: session.user_public_id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    /*
     * The most important event this system sends, and the reason webhooks exist
     * at all: the person exercised a legal right to be erased, and a dozen
     * applications are each holding a copy of their name and address. It is
     * emitted after the tombstone but the memberships survive it, so the
     * fan-out still knows who to tell.
     */
    await webhooks.emitForUser(session.user_id, 'user.deleted', async (user, subject) => ({
      sub: subject,
      deleted_at: new Date().toISOString(),
    }));

    sessions.clearCookie(res);
    return res.render('account/deleted', {
      title: 'Your account has been deleted',
      nonce: res.locals.nonce,
      config,
      days: config.retention.deletedAccountDays,
      noindex: true,
    });
  } catch (error) {
    return next(error);
  }
});

async function notify(userId, { heading, body, req }) {
  try {
    const mailer = require('../mailer');
    const address = await db.one(
      `SELECT identifier FROM user_identities
        WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL AND verified_at IS NOT NULL
        ORDER BY is_recovery, created_at LIMIT 1`,
      [userId],
    );
    if (!address) return;
    await mailer.sendSecurityNotice({
      to: address.identifier,
      heading,
      body,
      when: new Date().toUTCString(),
      ip: req.clientIp,
      device: sessions.describeDevice(req.userAgent),
    });
  } catch (error) {
    console.error('[account] notification failed:', error.message);
  }
}

module.exports = router;
