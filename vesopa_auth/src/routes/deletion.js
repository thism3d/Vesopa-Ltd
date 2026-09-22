/**
 * /delete-account — the page an app's store listing links to.
 *
 * WHAT GOOGLE ASKS OF THIS PAGE (Play Console, Data safety > Delete account URL)
 *
 *   * it names the app, or the developer, as the store listing does
 *   * it says plainly how to ask, step by step
 *   * it says what is deleted, what is kept, and for how long
 *   * it works without the app installed
 *
 * THE STEPS
 *
 *   1  the address, proved by an emailed code — or skipped for somebody
 *      already signed in whose account holds that address, verified
 *   2  what to delete: the Vesopa account, and each app's data found for the
 *      address (asked of the apps only after step 1, never for a typed one)
 *   3  when: automatically after 7, 15 or 30 days, or as soon as possible,
 *      which an administrator reviews
 *
 * The proved address is carried between steps in an encrypted cookie that
 * lasts half an hour, rather than a row: nothing is stored about somebody who
 * looks at the choices and leaves.
 *
 * POST /privacy/v1/requests is the same thing filed by an app's own server for
 * a member who asked inside the app. It is signed with the app's privacy
 * provider secret, and sent as `application/vesopa+json` so the global JSON
 * parser leaves the raw bytes for the signature check.
 */

const express = require('express');

const config = require('../config');
const csrf = require('../csrf');
const challenges = require('../challenges');
const deletion = require('../deletion');
const sessions = require('../sessions');
const db = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { normaliseEmail } = require('../normalise');

const router = express.Router();

const PROVED_COOKIE = config.isProduction ? '__Host-vesopa_del' : 'vesopa_del';
const PENDING_COOKIE = config.isProduction ? '__Host-vesopa_delcode' : 'vesopa_delcode';
const HALF_HOUR = 30 * 60 * 1000;

function cookieOptions(maxAge) {
  return { httpOnly: true, secure: config.isProduction, sameSite: 'lax', path: '/', maxAge };
}

function seal(res, name, value, maxAge) {
  const payload = encrypt(JSON.stringify({ ...value, exp: Date.now() + maxAge }), config.secrets.encryptionKey);
  res.cookie(name, Buffer.from(payload).toString('base64url'), cookieOptions(maxAge));
}

function unseal(req, name) {
  try {
    const raw = req.cookies && req.cookies[name];
    if (!raw) return null;
    const value = JSON.parse(decrypt(Buffer.from(raw, 'base64url'), config.secrets.encryptionKey));
    return value.exp > Date.now() ? value : null;
  } catch {
    return null;
  }
}

function origin(req) {
  const app = String(req.query.app || req.body?.app || '').slice(0, 80).replace(/[^a-z0-9-]/gi, '');
  const venue = String(req.query.venue || req.body?.venue || '').slice(0, 80).replace(/[^a-z0-9-]/gi, '');
  return { app, venue };
}

/** The page a person started on: /delete-account/<venue> for an app's own link. */
function startPath({ venue } = {}) {
  return venue ? `/delete-account/${encodeURIComponent(venue)}` : '/delete-account';
}

async function render(res, state, extra = {}) {
  return res.render('delete-account', {
    title: extra.heading || 'Delete your account and data',
    description: 'Ask Vesopa Software Limited to delete your account and the data an app holds about you.',
    nonce: res.locals.nonce,
    config,
    path: '/delete-account',
    noindex: false,
    state,
    error: '',
    dayChoices: deletion.DAY_CHOICES,
    ...extra,
    startPath: startPath(extra.from || {}),
  });
}

async function describeFor(from) {
  const found = from.app ? await deletion.describe(from).catch(() => null) : null;
  return found ? found.label : '';
}

/** A signed-in person's verified addresses, so they need not be sent a code. */
async function verifiedEmailsOf(req) {
  const session = await sessions.load(req);
  if (!session) return { session: null, emails: [] };
  const rows = await db.query(
    `SELECT identifier, identifier_norm FROM user_identities
      WHERE user_id = ? AND type = 'email' AND revoked_at IS NULL AND verified_at IS NOT NULL
      ORDER BY is_recovery, created_at`,
    [session.user_id],
  );
  return { session, emails: rows };
}

// ---------------------------------------------------------------------------
// Step 1: the address
// ---------------------------------------------------------------------------

async function startPage(req, res, next, from) {
  try {
    const described = from.venue || from.app ? await deletion.describe(from).catch(() => null) : null;
    const appLabel = described ? described.label : '';
    const { emails } = await verifiedEmailsOf(req);
    return render(res, 'start', {
      from: described ? { app: described.slug, venue: described.venue } : { app: '', venue: '' },
      appLabel,
      heading: appLabel ? `${appLabel}: delete your account and data` : 'Delete your account and data',
      signedInEmail: emails.length ? emails[0].identifier : '',
      error: String(req.query.error || '').slice(0, 200),
      noindex: Boolean(from.venue && !described),
    });
  } catch (error) {
    return next(error);
  }
}

router.get('/delete-account', (req, res, next) => {
  const from = origin(req);
  // /delete-account?app=…&venue=… was the first form of the link; the venue's
  // own address is the one to keep.
  if (from.venue) return res.redirect(301, startPath(from));
  return startPage(req, res, next, from);
});

router.post('/delete-account/start', csrf.verify, async (req, res, next) => {
  try {
    const from = origin(req);
    const typed = String(req.body.email || '').trim();
    const norm = normaliseEmail(typed);
    const back = (message) => res.redirect(303, `${startPath(from)}?error=${encodeURIComponent(message)}`);
    if (!norm || !norm.includes('@')) return back('Enter the email address you use with the app.');

    const { emails } = await verifiedEmailsOf(req);
    if (emails.some((e) => e.identifier_norm === norm)) {
      seal(res, PROVED_COOKIE, { email: norm, ...from }, HALF_HOUR);
      return res.redirect(303, '/delete-account/choose');
    }

    const sent = await challenges.create({
      channel: 'email',
      purpose: 'delete_account',
      destination: typed,
      destinationNorm: norm,
      ip: req.clientIp,
      userAgent: req.userAgent,
      force: req.body.resend === '1',
    });
    if (!sent.ok && /rate_limited/.test(sent.reason || '')) {
      return back('Too many codes have been asked for. Please try again in an hour.');
    }
    if (!sent.ok) return back('We could not send a code just now. Please try again in a few minutes.');
    seal(res, PENDING_COOKIE, { challengeId: sent.challengeId, email: norm, ...from }, HALF_HOUR);
    return res.redirect(303, '/delete-account/code');
  } catch (error) {
    return next(error);
  }
});

router.get('/delete-account/code', async (req, res, next) => {
  try {
    const pending = unseal(req, PENDING_COOKIE);
    const from = pending ? { app: pending.app, venue: pending.venue } : origin(req);
    if (!pending) return res.redirect(303, startPath(from));
    return render(res, 'code', {
      from,
      appLabel: await describeFor(from),
      email: pending.email,
      error: String(req.query.error || '').slice(0, 200),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/delete-account/code', csrf.verify, async (req, res, next) => {
  try {
    const pending = unseal(req, PENDING_COOKIE);
    if (!pending) return res.redirect(303, '/delete-account?error=That+took+too+long.+Please+start+again.');
    const from = { app: pending.app, venue: pending.venue };
    const code = String(req.body.code || '').replace(/\D/g, '');
    const checked = await challenges.verify({ challengeId: pending.challengeId, code, ip: req.clientIp });
    if (!checked.ok) {
      const message = {
        wrong_code: 'That code is not right. Check the email and try again.',
        expired: 'That code has expired. Send another one.',
        too_many_attempts: 'Too many tries. Send another code.',
      }[checked.reason] || 'That code cannot be used. Send another one.';
      return res.redirect(303, `/delete-account/code?error=${encodeURIComponent(message)}`);
    }
    res.clearCookie(PENDING_COOKIE, cookieOptions(0));
    seal(res, PROVED_COOKIE, { email: pending.email, ...from }, HALF_HOUR);
    return res.redirect(303, '/delete-account/choose');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Steps 2 and 3: what, and when
// ---------------------------------------------------------------------------

router.get('/delete-account/choose', async (req, res, next) => {
  try {
    const proved = unseal(req, PROVED_COOKIE);
    if (!proved) return res.redirect(303, startPath(origin(req)));
    const from = { app: proved.app, venue: proved.venue };
    const [found, described] = await Promise.all([
      deletion.discover(proved.email),
      from.app ? deletion.describe(from).catch(() => null) : null,
    ]);
    const open = await db.query(
      `SELECT r.public_id, r.status, r.due_at, i.label FROM deletion_requests r
         JOIN deletion_request_items i ON i.request_id = r.id
        WHERE r.email_hash = SHA2(CONCAT('deletion:', ?), 256)
          AND r.status IN ('awaiting_review','scheduled','needs_attention','processing')`,
      [normaliseEmail(proved.email)],
    );
    // Preselect what the person came for; with nothing to go on, everything.
    const preselect = new Set(
      found.items
        .filter((i) => (described && i.applicationId === described.applicationId && (!from.venue || i.venue === from.venue)))
        .map((i) => i.key),
    );
    return render(res, 'choose', {
      from,
      appLabel: described ? described.label : '',
      email: proved.email,
      items: found.items,
      problems: found.problems,
      open,
      preselect: preselect.size ? preselect : new Set(found.items.map((i) => i.key)),
      defaultDays: await deletion.defaultDays(),
      error: String(req.query.error || '').slice(0, 200),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/delete-account/:venue', (req, res, next) => {
  const venue = String(req.params.venue || '').toLowerCase();
  return startPage(req, res, next, { app: '', venue });
});

router.post('/delete-account/confirm', csrf.verify, async (req, res, next) => {
  try {
    const proved = unseal(req, PROVED_COOKIE);
    if (!proved) return res.redirect(303, '/delete-account?error=That+took+too+long.+Please+start+again.');
    const from = { app: proved.app, venue: proved.venue };
    const again = (message) => res.redirect(303, `/delete-account/choose?error=${encodeURIComponent(message)}`);

    // What can be chosen is worked out again here, never taken from the form:
    // the form only says which of the found things were ticked.
    const chosen = new Set([].concat(req.body.items || []).map(String));
    const found = await deletion.discover(proved.email);
    const items = found.items.filter((i) => chosen.has(i.key));
    if (!items.length) return again('Tick at least one thing to delete.');
    if (req.body.understand !== 'yes') return again('Tick the box to confirm you understand this cannot be undone once it is done.');

    const described = from.app ? await deletion.describe(from).catch(() => null) : null;
    const { request, token, existing } = await deletion.create({
      email: proved.email,
      source: 'web',
      sourceApplicationId: described ? described.applicationId : null,
      appLabel: described ? described.label : '',
      mode: req.body.mode === 'review' ? 'review' : 'scheduled',
      delayDays: req.body.days,
      items,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    res.clearCookie(PROVED_COOKIE, cookieOptions(0));
    return render(res, 'done', {
      from,
      appLabel: described ? described.label : '',
      request,
      manageUrl: token ? `/delete-account/requests/${request.public_id}?token=${encodeURIComponent(token)}` : '',
      existing,
      noindex: true,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// The emailed link: see it, cancel it
// ---------------------------------------------------------------------------

router.get('/delete-account/requests/:publicId', async (req, res, next) => {
  try {
    const request = await deletion.getByPublicId(req.params.publicId);
    const token = String(req.query.token || '');
    if (!deletion.tokenMatches(request, token)) {
      return render(res, 'missing', { noindex: true, from: {}, appLabel: '' });
    }
    return render(res, 'manage', {
      noindex: true,
      from: {},
      appLabel: request.app_label,
      request,
      token,
      cancelled: req.query.cancelled === '1',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/delete-account/requests/:publicId/cancel', csrf.verify, async (req, res, next) => {
  try {
    const request = await deletion.getByPublicId(req.params.publicId);
    const token = String(req.body.token || '');
    if (!deletion.tokenMatches(request, token)) {
      return render(res, 'missing', { noindex: true, from: {}, appLabel: '' });
    }
    await deletion.cancel(request);
    return res.redirect(303, `/delete-account/requests/${request.public_id}?token=${encodeURIComponent(token)}&cancelled=1`);
  } catch (error) {
    return next(error);
  }
});

// The old address, still linked from the account pages and the policies.
router.get('/account/delete', (req, res) => res.redirect(303, '/delete-account'));

// ---------------------------------------------------------------------------
// Filed by an app, for its signed-in member
// ---------------------------------------------------------------------------

router.post(
  '/privacy/v1/requests',
  express.text({ type: 'application/vesopa+json', limit: '32kb' }),
  async (req, res, next) => {
    try {
      const slug = String(req.get('vesopa-application') || '');
      const provider = slug ? await deletion.providerBySlug(slug) : null;
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!provider || !raw || !deletion.verifySignature(deletion.secretOf(provider), req.get('vesopa-signature'), raw)) {
        return res.status(401).json({ error: 'invalid_signature' });
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return res.status(400).json({ error: 'invalid_json' });
      }
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 20).map((item) => ({
        kind: 'app_data',
        applicationId: provider.application_id,
        reference: String(item.reference || '').slice(0, 190),
        label: String(item.label || provider.data_label || provider.name).slice(0, 190),
        detail: String(item.detail || '').slice(0, 255),
      })).filter((item) => item.reference);
      if (!items.length) return res.status(400).json({ error: 'no_items' });

      const { request, token, existing } = await deletion.create({
        email: String(body.email || ''),
        contactLabel: String(body.contact_label || ''),
        source: 'app',
        sourceApplicationId: provider.application_id,
        appLabel: String(body.app_label || '').slice(0, 120),
        mode: body.mode === 'review' ? 'review' : 'scheduled',
        delayDays: body.delay_days,
        items,
        ip: String(body.ip || req.clientIp || ''),
        userAgent: String(body.user_agent || '').slice(0, 255),
      });
      return res.status(existing ? 200 : 201).json({
        id: request.public_id,
        status: request.status,
        mode: request.mode,
        due_at: request.due_at,
        existing,
        manage_url: token ? `${config.issuer}/delete-account/requests/${request.public_id}?token=${encodeURIComponent(token)}` : null,
      });
    } catch (error) {
      return next(error);
    }
  },
);

module.exports = router;
