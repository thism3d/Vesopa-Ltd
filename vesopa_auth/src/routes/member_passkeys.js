/**
 * A member's Vesopa passkeys, for the account page of an app they use
 * (2026-10-12). The owner: "passkey delete and passkey device info should show".
 *
 * WHY AN APP'S SERVER ASKS, NOT THE APP. A venue's own app signs in natively
 * (routes/native.js) and keeps no Vesopa session afterwards: it holds its own
 * server's token. So that server asks here on the member's behalf, for the
 * subject this application was given, signed with the same privacy-provider
 * secret it already signs deletion requests with (routes/deletion.js):
 *
 *   POST /privacy/v1/member-passkeys          { sub }      -> { passkeys }
 *   POST /privacy/v1/member-passkeys/remove   { sub, id }  -> { ok }
 *
 * `application/vesopa+json`, so the global JSON parser leaves the raw bytes for
 * the signature check, and `vesopa-application` names the application.
 *
 * WHAT IT MAY NOT DO. It cannot add a passkey: a passkey here is two factors
 * (aal2), and an app's session may rest on nothing more than an emailed code.
 * It sees only subjects of ITS OWN application -- a pairwise subject means
 * nothing anywhere else, and a public one is checked against the people who
 * have used that application. And removing keeps the last-way-in guard the
 * account page has (routes/mfa.js): nobody is locked out from an app.
 */
const express = require('express');

const db = require('../db');
const deletion = require('../deletion');
const events = require('../events');
const identity = require('../identity');
const { userFromSubject } = require('./oidc');

const router = express.Router();
const body = express.text({ type: 'application/vesopa+json', limit: '8kb' });

/** The application and the person, or null with the answer already sent. */
async function caller(req, res) {
  const slug = String(req.get('vesopa-application') || '');
  const provider = slug ? await deletion.providerBySlug(slug) : null;
  const raw = typeof req.body === 'string' ? req.body : '';
  if (!provider || !raw || !deletion.verifySignature(deletion.secretOf(provider), req.get('vesopa-signature'), raw)) {
    res.status(401).json({ error: 'invalid_signature' });
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return null;
  }
  const application = await db.one('SELECT * FROM applications WHERE id = ?', [provider.application_id]);
  const user = application && payload.sub ? await userFromSubject(application, String(payload.sub)) : null;
  if (!user || user.status !== 'active' || !(await usesApplication(application.id, user.id))) {
    res.status(404).json({ error: 'unknown_subject' });
    return null;
  }
  return { application, user, payload };
}

/** Has this person ever been let into this application? Consent or membership. */
async function usesApplication(applicationId, userId) {
  const row = await db.one(
    `SELECT (SELECT COUNT(*) FROM application_members
              WHERE application_id = ? AND user_id = ? AND status = 'active')
          + (SELECT COUNT(*) FROM oauth_consents
              WHERE application_id = ? AND user_id = ? AND revoked_at IS NULL) AS n`,
    [applicationId, userId, applicationId, userId],
  );
  return Number(row && row.n) > 0;
}

/** What an app is told about one passkey: never the key, never the credential id. */
function shape(row) {
  return {
    id: row.id,
    name: row.name || 'Passkey',
    aaguid: row.aaguid || '',
    device_type: row.device_type || '',
    backup_state: Number(row.backup_state) ? 1 : 0,
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
  };
}

router.post('/privacy/v1/member-passkeys', body, async (req, res, next) => {
  try {
    const who = await caller(req, res);
    if (!who) return undefined;
    const rows = await db.query(
      `SELECT id, name, aaguid, device_type, backup_state, created_at, last_used_at
         FROM user_passkeys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at`,
      [who.user.id],
    );
    return res.json({ passkeys: rows.map(shape) });
  } catch (error) {
    return next(error);
  }
});

router.post('/privacy/v1/member-passkeys/remove', body, async (req, res, next) => {
  try {
    const who = await caller(req, res);
    if (!who) return undefined;
    const id = Number(who.payload.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_request' });
    if ((await identity.countAuthMethods(who.user.id)) <= 1) {
      return res.status(409).json({ error: 'last_auth_method' });
    }
    const done = await db.execute(
      'UPDATE user_passkeys SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [id, who.user.id],
    );
    if (!done || !done.affectedRows) return res.status(404).json({ error: 'not_found' });
    await events.recordAudit({
      actorUserId: who.user.id,
      action: 'mfa.passkey.removed',
      targetType: 'passkey',
      targetId: String(id),
      applicationId: who.application.id,
      detail: { via: 'app' },
      ip: req.clientIp,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.shape = shape;
