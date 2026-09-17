/**
 * Deleting an account, and each app's data, when somebody asks.
 *
 * WHO ASKS, AND FROM WHERE
 *
 *   the web page   /delete-account — proved by a code emailed to the address,
 *                  and usable by somebody who has uninstalled the app or never
 *                  had a Vesopa account (a loyalty member who signs in with an
 *                  emailed code has only a membership in a venue's back office)
 *   inside an app  the app's own server files the request for its signed-in
 *                  member, signed with its privacy provider secret
 *
 * WHAT CAN BE DELETED
 *
 *   the Vesopa account itself, erased here
 *   each app's data, erased by that app: an application that holds personal
 *   data registers a privacy provider (an HTTPS endpoint and a shared secret)
 *   and answers `lookup` (what do you hold for this address) and `erase`
 *
 * WHEN (the person chooses; the owner's rule, 2026-09-17)
 *
 *   scheduled  deleted automatically after 7, 15 or 30 days. The default,
 *              because a grace period is what lets somebody who pressed the
 *              button in a temper, or on a stolen phone, take it back.
 *   review     "as soon as possible": an administrator reviews it and carries
 *              it out, normally within two working days.
 *
 * Either way an administrator sees every request at /admin/deletions and can
 * bring a scheduled one forward, and the person can cancel until it has run.
 */

const crypto = require('crypto');

const config = require('./config');
const db = require('./db');
const events = require('./events');
const identity = require('./identity');
const settings = require('./settings');
const { newId, newToken, hashToken, safeEqual, encrypt, decrypt } = require('./crypto');
const { normaliseEmail } = require('./normalise');

const OPEN = ['awaiting_review', 'scheduled', 'needs_attention'];
const DAY_CHOICES = [7, 15, 30];
const PROVIDER_TIMEOUT_MS = 10000;
const SIGNATURE_TOLERANCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Signing, both ways
// ---------------------------------------------------------------------------

/** `t=<unix>,v1=<hex>` over `t.body`, the same shape as webhooks. */
function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function verifySignature(secret, header, rawBody) {
  const parts = Object.fromEntries(
    String(header || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2),
  );
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = sign(secret, rawBody, timestamp).split('v1=')[1];
  return safeEqual(expected, parts.v1);
}

function emailHash(email) {
  return email ? hashToken(`deletion:${normaliseEmail(email)}`) : '';
}

/** o••••@example.com — enough for an administrator to recognise, not to contact. */
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}••••@${domain}`;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function providers() {
  return db.query(
    `SELECT p.application_id, p.endpoint_url, p.secret_cipher, p.data_label,
            a.slug, a.name, a.app_display_name, a.client_id
       FROM application_privacy_providers p
       JOIN applications a ON a.id = p.application_id
      WHERE p.is_enabled = 1 AND a.deleted_at IS NULL`,
  );
}

async function providerBySlug(slug) {
  const all = await providers();
  return all.find((p) => p.slug === slug) || null;
}

function secretOf(provider) {
  return decrypt(provider.secret_cipher, config.secrets.encryptionKey);
}

async function callProvider(provider, action, payload) {
  const body = JSON.stringify(payload);
  const url = `${provider.endpoint_url.replace(/\/+$/, '')}/${action}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Vesopa-Privacy/1.0',
      'vesopa-signature': sign(secretOf(provider), body),
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* reported below */
  }
  if (!response.ok || !json) {
    throw new Error(`${provider.name} answered ${response.status}${json && json.error ? `: ${json.error}` : ''}`);
  }
  return json;
}

/**
 * The app a person came from, for the page heading.
 *
 * /delete-account/thevesopakitchen is what The Vesopa Kitchen's store listing
 * links to, and Google asks that the page name the app as the listing does —
 * so the venue's own app name is asked of the provider rather than showing
 * "Vesopa Loyalty", which no member has ever seen. With only a venue, each
 * provider is asked in turn; the first that knows it is the app.
 */
async function describe({ app, venue }) {
  if (!app && venue) return describeVenue(venue);
  if (!app) return null;
  const application = await db.one(
    'SELECT id, slug, name, app_display_name FROM applications WHERE slug = ?',
    [String(app).slice(0, 80)],
  );
  if (!application) return null;
  let label = application.app_display_name || application.name;
  if (venue) {
    const provider = await providerBySlug(application.slug);
    if (provider) {
      try {
        const answer = await callProvider(provider, 'describe', { venue: String(venue).slice(0, 80) });
        if (answer && answer.name) label = String(answer.name).slice(0, 120);
      } catch (error) {
        console.error('[deletion] describe failed:', error.message);
      }
    }
  }
  return { applicationId: application.id, slug: application.slug, venue: venue || '', label };
}

async function describeVenue(venue) {
  const clean = String(venue || '').slice(0, 80);
  if (!/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/.test(clean)) return null;
  for (const provider of await providers()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a handful of providers
      const answer = await callProvider(provider, 'describe', { venue: clean });
      if (answer && answer.name) {
        return { applicationId: provider.application_id, slug: provider.slug, venue: clean, label: String(answer.name).slice(0, 120) };
      }
    } catch (error) {
      console.error(`[deletion] describe at ${provider.slug} failed:`, error.message);
    }
  }
  return null;
}

/**
 * Everything held for a proved address, as the choices on the page.
 *
 * Only ever called after the address is proved: a lookup that answered for any
 * typed address would tell a stranger which venues somebody belongs to.
 */
async function discover(email) {
  const norm = normaliseEmail(email);
  const items = [];
  const problems = [];

  const found = await identity.findIdentity('email', norm);
  if (found && found.user_status === 'active' && !found.merged_into_user_id) {
    const apps = await db.one(
      "SELECT COUNT(*) AS n FROM application_members WHERE user_id = ? AND status = 'active'",
      [found.user_id],
    );
    const count = Number(apps && apps.n) || 0;
    items.push({
      key: 'account',
      kind: 'vesopa_account',
      applicationId: null,
      reference: found.user_public_id,
      userId: found.user_id,
      label: 'Your Vesopa account',
      detail: `Your profile, email address and phone number, password, passkeys and saved devices${count ? `, and your connections to ${count} app${count === 1 ? '' : 's'}` : ''}.`,
      slug: '',
      venue: '',
    });
  }

  for (const provider of await providers()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a handful of providers
      const answer = await callProvider(provider, 'lookup', { email: norm });
      for (const item of (answer.items || []).slice(0, 50)) {
        items.push({
          key: `app:${provider.application_id}:${item.reference}`,
          kind: 'app_data',
          applicationId: provider.application_id,
          reference: String(item.reference).slice(0, 190),
          userId: null,
          label: String(item.label || provider.data_label || provider.name).slice(0, 190),
          detail: String(item.detail || '').slice(0, 255),
          slug: provider.slug,
          venue: String(item.venue || ''),
        });
      }
    } catch (error) {
      console.error(`[deletion] lookup at ${provider.slug} failed:`, error.message);
      problems.push(provider.data_label || provider.app_display_name || provider.name);
    }
  }
  return { items, problems };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function defaultDays() {
  const value = Number(await settings.get('deletion_default_days'));
  return DAY_CHOICES.includes(value) ? value : 30;
}

function cleanDays(value, fallback) {
  const n = Number(value);
  return DAY_CHOICES.includes(n) ? n : fallback;
}

async function openRequestFor(hash, items) {
  if (!hash) return null;
  const rows = await db.query(
    `SELECT r.*, i.kind, i.application_id AS item_application_id, i.reference
       FROM deletion_requests r
       JOIN deletion_request_items i ON i.request_id = r.id
      WHERE r.email_hash = ? AND r.status IN ('awaiting_review','scheduled','needs_attention','processing')`,
    [hash],
  );
  const wanted = new Set(items.map((i) => `${i.kind}:${i.applicationId || ''}:${i.reference}`));
  const hit = rows.find((r) => wanted.has(`${r.kind}:${r.item_application_id || ''}:${r.reference}`));
  return hit ? getByPublicId(hit.public_id) : null;
}

/**
 * File a request. Returns `{ request, token, existing }`.
 *
 * A second request for something already waiting returns the first rather than
 * making two: an in-app button pressed twice, or the web page after the app,
 * must not produce two emails and two rows for an administrator to reconcile.
 */
async function create({
  email = '',
  contactLabel = '',
  source = 'web',
  sourceApplicationId = null,
  appLabel = '',
  mode,
  delayDays,
  items,
  ip = '',
  userAgent = '',
}) {
  if (!items || !items.length) throw new Error('nothing chosen');
  const norm = email ? normaliseEmail(email) : '';
  const hash = norm ? emailHash(norm) : hashToken(`deletion-contact:${contactLabel}`);

  const existing = await openRequestFor(hash, items);
  if (existing) return { request: existing, token: null, existing: true };

  const chosenMode = mode === 'review' ? 'review' : 'scheduled';
  const days = chosenMode === 'scheduled' ? cleanDays(delayDays, await defaultDays()) : null;
  const token = newToken();
  const publicId = newId();
  const userItem = items.find((i) => i.kind === 'vesopa_account');

  await db.transaction(async (tx) => {
    const result = await tx.execute(
      `INSERT INTO deletion_requests
         (public_id, email, email_hash, contact_label, user_id, source, source_application_id, app_label,
          mode, delay_days, status, due_at, manage_token_hash, requested_ip, requested_user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${chosenMode === 'scheduled' ? 'NOW() + INTERVAL ? DAY' : 'NULL'}, ?, ?, ?)`,
      [
        publicId, norm, hash, String(contactLabel).slice(0, 190), userItem ? userItem.userId : null,
        source, sourceApplicationId, String(appLabel).slice(0, 120),
        chosenMode, days, chosenMode === 'scheduled' ? 'scheduled' : 'awaiting_review',
        ...(chosenMode === 'scheduled' ? [days] : []),
        hashToken(token), String(ip).slice(0, 64), String(userAgent).slice(0, 255),
      ],
    );
    for (const item of items) {
      // eslint-disable-next-line no-await-in-loop
      await tx.execute(
        `INSERT INTO deletion_request_items (request_id, kind, application_id, reference, label, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [result.insertId, item.kind, item.applicationId || null, item.reference || '', item.label, item.detail || ''],
      );
    }
  });

  const request = await getByPublicId(publicId);
  await events.recordAudit({
    actorUserId: userItem ? userItem.userId : null,
    action: 'deletion.requested',
    targetType: 'deletion_request',
    targetId: publicId,
    detail: { mode: chosenMode, days, source, items: items.length },
    ip,
    userAgent,
  }).catch(() => {});

  await notifyPersonReceived(request, token).catch((e) => console.error('[deletion] receipt mail failed:', e.message));
  await notifyAdmin(request, 'new').catch((e) => console.error('[deletion] admin mail failed:', e.message));
  return { request, token, existing: false };
}

async function getByPublicId(publicId) {
  const request = await db.one('SELECT * FROM deletion_requests WHERE public_id = ?', [String(publicId || '')]);
  if (!request) return null;
  request.items = await db.query(
    `SELECT i.*, a.name AS application_name
       FROM deletion_request_items i
       LEFT JOIN applications a ON a.id = i.application_id
      WHERE i.request_id = ? ORDER BY i.id`,
    [request.id],
  );
  return request;
}

function tokenMatches(request, token) {
  return Boolean(request && token && safeEqual(hashToken(token), request.manage_token_hash));
}

async function list({ status = '', limit = 200 } = {}) {
  const where = status ? 'WHERE r.status = ?' : '';
  const rows = await db.query(
    `SELECT r.*, (SELECT COUNT(*) FROM deletion_request_items i WHERE i.request_id = r.id) AS item_count,
            (SELECT GROUP_CONCAT(i.label ORDER BY i.id SEPARATOR ', ') FROM deletion_request_items i WHERE i.request_id = r.id) AS item_labels,
            d.display_name AS decided_by_name
       FROM deletion_requests r
       LEFT JOIN users d ON d.id = r.decided_by_user_id
       ${where}
      ORDER BY FIELD(r.status, 'awaiting_review', 'needs_attention', 'processing', 'scheduled') = 0,
               FIELD(r.status, 'awaiting_review', 'needs_attention', 'processing', 'scheduled'),
               COALESCE(r.due_at, r.created_at), r.created_at DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 500)}`,
    status ? [status] : [],
  );
  return rows;
}

async function counts() {
  const rows = await db.query('SELECT status, COUNT(*) AS n FROM deletion_requests GROUP BY status');
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/**
 * Tell each app involved that a request will not run after all, so an app that
 * shows "deletion scheduled" to its member stops saying so. Best effort: the
 * request is already cancelled here whether or not the app hears.
 */
async function tellProviders(request, status) {
  const all = await providers();
  const ids = new Set((request.items || []).filter((i) => i.kind === 'app_data').map((i) => i.application_id));
  for (const provider of all.filter((p) => ids.has(p.application_id))) {
    // eslint-disable-next-line no-await-in-loop
    await callProvider(provider, 'status', { request: request.public_id, status }).catch((error) =>
      console.error(`[deletion] could not tell ${provider.slug}:`, error.message));
  }
}

async function cancel(request, { byUserId = null, note = '' } = {}) {
  const done = await db.execute(
    `UPDATE deletion_requests
        SET status = 'cancelled', cancelled_at = NOW(), decided_by_user_id = ?, decision_note = ?
      WHERE id = ? AND status IN ('awaiting_review','scheduled','needs_attention')`,
    [byUserId, String(note).slice(0, 500), request.id],
  );
  if (done.affectedRows !== 1) return false;
  await db.execute("UPDATE deletion_request_items SET status = 'cancelled' WHERE request_id = ? AND status <> 'done'", [request.id]);
  await tellProviders(request, 'cancelled');
  await events.recordAudit({
    actorUserId: byUserId,
    actorType: byUserId ? 'admin' : 'user',
    action: 'deletion.cancelled',
    targetType: 'deletion_request',
    targetId: request.public_id,
  }).catch(() => {});
  await mailPerson(request, {
    subject: 'Your deletion request has been cancelled',
    heading: 'Nothing will be deleted',
    paragraphs: [
      byUserId
        ? `Your request to delete ${summary(request)} was cancelled by Vesopa.${note ? ` ${note}` : ''}`
        : `You cancelled your request to delete ${summary(request)}. Everything stays as it was.`,
      'If you did not do this, reply to this email.',
    ],
  }).catch(() => {});
  return true;
}

async function reject(request, adminUserId, note) {
  const done = await db.execute(
    `UPDATE deletion_requests
        SET status = 'rejected', decided_by_user_id = ?, decided_at = NOW(), decision_note = ?
      WHERE id = ? AND status IN ('awaiting_review','scheduled','needs_attention')`,
    [adminUserId, String(note || '').slice(0, 500), request.id],
  );
  if (done.affectedRows !== 1) return false;
  await db.execute("UPDATE deletion_request_items SET status = 'cancelled' WHERE request_id = ? AND status <> 'done'", [request.id]);
  await tellProviders(request, 'rejected');
  await events.recordAudit({
    actorUserId: adminUserId,
    actorType: 'admin',
    action: 'deletion.rejected',
    targetType: 'deletion_request',
    targetId: request.public_id,
    detail: { note },
  }).catch(() => {});
  await mailPerson(request, {
    subject: 'About your deletion request',
    heading: 'We could not carry out your request',
    paragraphs: [
      `We have not deleted ${summary(request)}.`,
      note || 'Reply to this email and we will explain.',
    ],
  }).catch(() => {});
  return true;
}

/** An administrator approves a reviewed request, or brings a scheduled one forward. */
async function approve(request, adminUserId, note = '') {
  await db.execute(
    `UPDATE deletion_requests SET decided_by_user_id = ?, decided_at = NOW(), decision_note = ?
      WHERE id = ? AND status IN ('awaiting_review','scheduled','needs_attention')`,
    [adminUserId, String(note).slice(0, 500), request.id],
  );
  await events.recordAudit({
    actorUserId: adminUserId,
    actorType: 'admin',
    action: 'deletion.approved',
    targetType: 'deletion_request',
    targetId: request.public_id,
  }).catch(() => {});
  return execute(request.id);
}

// ---------------------------------------------------------------------------
// Carrying it out
// ---------------------------------------------------------------------------

/**
 * Run a request. Claimed with a conditional UPDATE, so the timer and an
 * administrator's button cannot run the same one twice.
 *
 * Items that already succeeded are not repeated; failed ones are retried. A
 * request finishes `completed` only when every item did — otherwise
 * `needs_attention`, which an administrator sees at the top of the list.
 */
async function execute(requestId) {
  const claimed = await db.execute(
    `UPDATE deletion_requests SET status = 'processing', started_at = NOW()
      WHERE id = ? AND status IN ('awaiting_review','scheduled','needs_attention')`,
    [requestId],
  );
  if (claimed.affectedRows !== 1) return { ok: false, reason: 'not_open' };

  const request = await db.one('SELECT * FROM deletion_requests WHERE id = ?', [requestId]);
  const items = await db.query(
    "SELECT * FROM deletion_request_items WHERE request_id = ? AND status IN ('pending','failed') ORDER BY id",
    [requestId],
  );

  // App data first, the Vesopa account last: the account's webhook fan-out
  // needs the memberships that erasing it removes.
  const byProvider = new Map();
  for (const item of items.filter((i) => i.kind === 'app_data')) {
    if (!byProvider.has(item.application_id)) byProvider.set(item.application_id, []);
    byProvider.get(item.application_id).push(item);
  }
  const all = await providers();
  for (const [applicationId, group] of byProvider) {
    const provider = all.find((p) => p.application_id === applicationId);
    if (!provider) {
      // eslint-disable-next-line no-await-in-loop
      await markItems(group, 'failed', 'This app is no longer connected for deletion. Remove its data by hand.');
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const answer = await callProvider(provider, 'erase', {
        email: request.email,
        references: group.map((i) => i.reference),
        request: request.public_id,
      });
      const results = new Map((answer.results || []).map((r) => [String(r.reference), r]));
      for (const item of group) {
        const r = results.get(item.reference);
        // eslint-disable-next-line no-await-in-loop
        await markItems([item], r && r.ok ? 'done' : 'failed', r ? String(r.detail || '') : 'The app did not report on this item.');
      }
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await markItems(group, 'failed', String(error.message || error).slice(0, 500));
    }
  }

  for (const item of items.filter((i) => i.kind === 'vesopa_account')) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const detail = await eraseUser(request.user_id || null, item.reference);
      // eslint-disable-next-line no-await-in-loop
      await markItems([item], 'done', detail);
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await markItems([item], 'failed', String(error.message || error).slice(0, 500));
    }
  }

  const left = await db.one(
    "SELECT COUNT(*) AS n FROM deletion_request_items WHERE request_id = ? AND status IN ('pending','failed')",
    [requestId],
  );
  const finished = Number(left.n) === 0;
  await db.execute(
    `UPDATE deletion_requests SET status = ?, completed_at = ${finished ? 'NOW()' : 'NULL'} WHERE id = ?`,
    [finished ? 'completed' : 'needs_attention', requestId],
  );
  await events.recordAudit({
    action: finished ? 'deletion.completed' : 'deletion.needs_attention',
    targetType: 'deletion_request',
    targetId: request.public_id,
  }).catch(() => {});

  const fresh = await getByPublicId(request.public_id);
  if (finished) {
    await mailPerson(fresh, {
      subject: 'Your data has been deleted',
      heading: 'Deleted',
      paragraphs: [
        `We have deleted ${summary(fresh)}.`,
        'If you use the app again you will start with a new, empty account.',
      ],
    }).catch(() => {});
    // The request itself outlives the data as the record that it was done; the
    // address on it does not.
    await db.execute('UPDATE deletion_requests SET email = ? WHERE id = ?', [maskEmail(request.email), requestId]);
  } else {
    await notifyAdmin(fresh, 'attention').catch(() => {});
  }
  return { ok: finished };
}

async function markItems(items, status, result) {
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute(
      `UPDATE deletion_request_items SET status = ?, result = ?, completed_at = ${status === 'done' ? 'NOW()' : 'NULL'} WHERE id = ?`,
      [status, String(result || '').slice(0, 500), item.id],
    );
  }
}

/**
 * Erase a Vesopa account.
 *
 * What goes: every identity (so the address and number are free at once), every
 * credential, session, token, consent, device and membership, the picture, the
 * name. What stays: the row itself as `deleted` with nothing personal on it,
 * because audit lines and orders elsewhere point at its id; and the security
 * log, kept for its published retention period.
 *
 * WHAT IT REFUSES, and leaves for an administrator: a staff account (nobody
 * should be able to delete the only administrator by filling in a form), a
 * developer who owns applications, and anybody with a live subscription —
 * erasing those strands a paid service with nobody to bill or to tell.
 */
async function eraseUser(userId, publicId) {
  const user = userId
    ? await db.one('SELECT * FROM users WHERE id = ?', [userId])
    : await db.one('SELECT * FROM users WHERE public_id = ?', [publicId]);
  if (!user) return 'There was no account left to delete.';
  if (user.status === 'deleted' && user.deleted_at) return 'The account had already been deleted.';
  if (user.is_staff) throw new Error('This is an administrator account. Remove its staff access first, then approve again.');
  const owns = await db.one('SELECT COUNT(*) AS n FROM application_developers WHERE user_id = ?', [user.id]).catch(() => ({ n: 0 }));
  if (Number(owns.n)) throw new Error('This person is a developer on an application. Hand the application over first, then approve again.');
  const paying = await db.one(
    "SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND status IN ('active','trialling','paused')",
    [user.id],
  ).catch(() => ({ n: 0 }));
  if (Number(paying.n)) throw new Error('This account has a live subscription. End it first, then approve again.');

  const webhooks = require('./webhooks');
  await webhooks.emitForUser(user.id, 'user.deleted', async (person, subject) => ({
    sub: subject,
    deleted_at: new Date().toISOString(),
  }));

  const avatars = require('./avatars');
  await avatars.clear(user.id).catch(() => {});

  await db.transaction(async (tx) => {
    const gone = [
      'user_identities', 'user_passwords', 'user_passkeys', 'user_totp', 'user_recovery_codes',
      'sso_sessions', 'oauth_refresh_tokens', 'oauth_authorization_codes', 'oauth_consents',
      'oauth_states', 'devices', 'verification_challenges', 'webauthn_challenges',
      'application_members', 'organisation_members', 'payment_methods',
    ];
    for (const table of gone) {
      // eslint-disable-next-line no-await-in-loop
      await tx.execute(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]).catch((error) => {
        if (!/doesn't exist|Unknown column/i.test(error.message)) throw error;
      });
    }
    await tx.execute(
      `UPDATE users
          SET display_name = '', given_name = '', family_name = '', date_of_birth = NULL,
              avatar_path = '', primary_email_id = NULL, primary_phone_id = NULL,
              webauthn_handle = NULL, status = 'deleted',
              deletion_requested_at = COALESCE(deletion_requested_at, NOW()), deleted_at = NOW()
        WHERE id = ?`,
      [user.id],
    );
  });
  return 'Vesopa account erased: identities, sign-in methods, sessions, connections and profile removed.';
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

function summary(request) {
  const labels = (request.items || []).map((i) => i.label);
  if (!labels.length) return 'your data';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function when(date) {
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

async function mailPerson(request, message) {
  if (!request.email || !request.email.includes('@') || request.email.includes('••••')) return;
  const mailer = require('./mailer');
  await mailer.sendNotice({ to: request.email, ...message });
}

async function notifyPersonReceived(request, token) {
  const link = `${config.issuer}/delete-account/requests/${request.public_id}?token=${encodeURIComponent(token)}`;
  const timing = request.mode === 'scheduled'
    ? `It will be deleted automatically on ${when(request.due_at)}. Until then you can cancel it.`
    : 'You asked for it to be deleted as soon as possible. Our team will review it and carry it out, normally within two working days, and email you when it is done.';
  await mailPerson(request, {
    subject: 'We have your request to delete your data',
    heading: 'Your deletion request',
    paragraphs: [
      `We have received your request to delete ${summary(request)}.`,
      timing,
      'If you did not ask for this, open the link below and cancel it.',
    ],
    action: { label: 'View or cancel the request', url: link },
  });
}

async function notifyAdmin(request, reason) {
  const to = (await settings.get('deletion_notify_email')) || 'info@vesopasoftware.com';
  const mailer = require('./mailer');
  const who = request.email || request.contact_label || 'a member';
  const headline = reason === 'attention'
    ? 'A deletion request needs attention'
    : request.mode === 'review'
      ? 'A deletion request is waiting for review'
      : 'A deletion request has been scheduled';
  await mailer.sendNotice({
    to,
    subject: `Vesopa: ${headline.toLowerCase()}`,
    heading: headline,
    paragraphs: [
      `${who} asked to delete ${summary(request)}${request.app_label ? ` (from ${request.app_label})` : ''}.`,
      reason === 'attention'
        ? 'Some of it could not be deleted automatically. The request shows why.'
        : request.mode === 'review'
          ? 'They asked for it to be done as soon as possible, so it waits for you to approve it.'
          : `It will run automatically on ${when(request.due_at)}. You can bring it forward.`,
    ],
    action: { label: 'Open the request', url: `${config.issuer}/admin/deletions/${request.public_id}` },
  });
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

let timer = null;

async function runDue() {
  const due = await db.query(
    "SELECT id FROM deletion_requests WHERE status = 'scheduled' AND due_at <= NOW() ORDER BY due_at LIMIT 10",
  );
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    await execute(row.id).catch((error) => console.error('[deletion] run failed:', error.message));
  }
  return due.length;
}

function startWorker() {
  if (timer) return;
  const tick = () => runDue().catch((error) => console.error('[deletion] worker:', error.message));
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Registering a provider (scripts/set-privacy-provider.js)
// ---------------------------------------------------------------------------

async function setProvider({ slug, endpointUrl, secret, dataLabel = '' }) {
  const application = await db.one('SELECT id FROM applications WHERE slug = ?', [slug]);
  if (!application) throw new Error(`no application ${slug}`);
  await db.execute(
    `INSERT INTO application_privacy_providers (application_id, endpoint_url, secret_cipher, data_label)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE endpoint_url = VALUES(endpoint_url), secret_cipher = VALUES(secret_cipher),
                             data_label = VALUES(data_label), is_enabled = 1`,
    [application.id, endpointUrl, encrypt(secret, config.secrets.encryptionKey), dataLabel],
  );
  return application.id;
}

module.exports = {
  DAY_CHOICES,
  OPEN,
  sign,
  verifySignature,
  providers,
  providerBySlug,
  secretOf,
  describe,
  discover,
  defaultDays,
  cleanDays,
  create,
  getByPublicId,
  tokenMatches,
  list,
  counts,
  cancel,
  reject,
  approve,
  execute,
  runDue,
  startWorker,
  setProvider,
  maskEmail,
};
