/**
 * The developer portal — Phase 4.
 *
 * The question this exists to answer, in the owner's words: *how do I create
 * the OAuth apps with redirect url and generate the API?* Until now the answer
 * was "run scripts/seed.js and mint the secret by hand on the server", which is
 * not an answer anybody outside this repository can use.
 *
 * WHAT A PERSON CAN DO HERE
 *   create an application, and be given its client id
 *   register redirect URIs, exactly, with the rules explained as they type
 *   mint and revoke client secrets, several live at once so rotation is not an outage
 *   choose which scopes it may ask for, and define its roles
 *   see who uses it, and who may administer it
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * It never shows a secret twice. The plaintext exists for as long as it takes
 * to render it once, and is never written to the database, a log or a URL.
 *
 * It never lets a viewer mint one. "Let them see the configuration" and "let
 * them create a live credential" are different requests, and a portal that
 * treats them as one is how an extra secret ends up in somebody's inbox.
 *
 * DELETION IS ARCHIVING. Removing an application's row takes its members, its
 * consents and its refresh tokens with it — a developer who presses Delete on
 * the wrong line would end every session their customers hold. `deleted_at`
 * stops it working and keeps the evidence.
 */

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const db = require('../db');
const sessions = require('../sessions');
const events = require('../events');
const csrf = require('../csrf');
const portal = require('../portal');
const logos = require('../logos');
const { normaliseEmail } = require('../normalise');

const router = express.Router();

/*
 * The logo upload.
 *
 * IN MEMORY AND CAPPED BEFORE ANYTHING IS READ, the same rule as the profile
 * picture: a disk-backed upload on a public endpoint is a way to fill the
 * partition MariaDB is also using. Half a megabyte held briefly is not.
 *
 * The type is checked twice — here against what the browser claimed, and again
 * in logos.js against what the bytes actually are — because a `Content-Type`
 * header is chosen by whoever is uploading.
 */
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: logos.MAX_BYTES, files: 1 },
  fileFilter(req, file, callback) {
    if (logos.TYPES[file.mimetype]) return callback(null, true);
    return callback(null, false);
  },
});

/*
 * The rail, in one place. Three pages rendering their own copy is how one of
 * them ends up missing an entry that was added last month.
 */
const RAIL = [
  { href: '/developers', label: 'Your applications', icon: 'apps', tint: 'brand' },
  { href: '/developers/new', label: 'New application', icon: 'plus', tint: 'blue' },
  { group: 'Reference' },
  { href: '/docs', label: 'Integration guide', icon: 'book', tint: 'violet' },
  { href: '/account/profile', label: 'Your account', icon: 'person', tint: 'teal' },
];

/** The rail for one application, once you are inside it. */
function appRail(clientId) {
  const base = `/developers/a/${encodeURIComponent(clientId)}`;
  return [
    { href: '/developers', label: 'All applications', icon: 'back', tint: 'slate' },
    { group: 'This application' },
    { href: base, label: 'Overview', icon: 'home', tint: 'brand' },
    { href: `${base}/redirects`, label: 'Redirect URIs', icon: 'link', tint: 'blue' },
    { href: `${base}/credentials`, label: 'Credentials & API', icon: 'key', tint: 'amber' },
    { href: `${base}/scopes`, label: 'Data it may ask for', icon: 'shield', tint: 'teal' },
    { href: `${base}/roles`, label: 'Roles', icon: 'people', tint: 'violet' },
    { href: `${base}/people`, label: 'Who uses it', icon: 'person', tint: 'pink' },
    { href: `${base}/team`, label: 'Who may edit it', icon: 'settings', tint: 'slate' },
  ];
}

/**
 * Every page here needs a session and developer access.
 *
 * `is_developer` is the gate on the portal itself; reaching a particular
 * application is a second question, answered by `portal.access`. Somebody with
 * neither sees the same 404 as somebody who mistyped the URL — an area that
 * announces "you may not have this" is an area worth trying to get into.
 */
async function guard(req, res, { needDeveloper = true } = {}) {
  const session = await sessions.load(req);
  if (!session) {
    res.redirect(303, `/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  await sessions.touch(session);

  if (needDeveloper && !session.is_developer && !session.is_staff) {
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
  return session;
}

function page(res, view, session, extra = {}) {
  return res.render(view, {
    nonce: res.locals.nonce,
    config,
    session,
    noindex: true,
    railTitle: 'Developers',
    railHome: '/developers',
    rail: RAIL,
    styles: ['console'],
    ...extra,
  });
}

function notFound(res, session) {
  return res.status(404).render('error', {
    title: 'Page not found',
    heading: 'That application is not here',
    message: 'It may have been archived, or it may belong to somebody else.',
    config,
    nonce: res.locals.nonce,
    session,
    noindex: true,
  });
}

/** Resolve the application in the URL, or answer 404 and return null. */
async function open(req, res, session, action = 'read') {
  const found = await portal.access(session, req.params.clientId);
  if (!found) {
    notFound(res, session);
    return null;
  }
  if (!portal.can(found.role, action)) {
    /*
     * A viewer who reaches a POST is refused with a message rather than a 404:
     * they can see the page, so pretending it does not exist would just be
     * confusing. What they may not do is change anything.
     */
    res.redirect(
      303,
      `/developers/a/${encodeURIComponent(req.params.clientId)}?error=${encodeURIComponent(
        'You have read-only access to this application.',
      )}`,
    );
    return null;
  }
  return found;
}

function back(res, clientId, section, query = '') {
  const base = `/developers/a/${encodeURIComponent(clientId)}${section ? `/${section}` : ''}`;
  return res.redirect(303, query ? `${base}?${query}` : `${base}?saved=1`);
}

// ===========================================================================
// The list
// ===========================================================================

router.get('/developers', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const applications = await portal.reach(session);
    return page(res, 'developers/index', session, {
      title: 'Your applications',
      path: '/developers',
      applications,
    });
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// Creating one
// ===========================================================================

router.get('/developers/new', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    /*
     * Which organisation the application will belong to. Somebody who belongs
     * to exactly one never sees the question — a form that asks something with
     * only one possible answer is a form with an extra step in it.
     */
    const organisations = await db.query(
      `SELECT o.id, o.name FROM organisations o
         JOIN organisation_members m ON m.organisation_id = o.id
        WHERE m.user_id = ? AND m.role IN ('owner','admin','developer')
          AND o.status = 'active'
        ORDER BY o.name`,
      [session.user_id],
    );

    return page(res, 'developers/new', session, {
      title: 'New application',
      path: '/developers/new',
      organisations,
      values: {},
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/new', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;

    const name = String(req.body.name || '').trim().slice(0, 120);
    const clientType = ['web', 'spa', 'native', 'service'].includes(req.body.client_type)
      ? req.body.client_type
      : 'web';
    const description = String(req.body.description || '').trim().slice(0, 500);
    const redirect = String(req.body.redirect_uri || '').trim();

    const organisations = await db.query(
      `SELECT o.id, o.name FROM organisations o
         JOIN organisation_members m ON m.organisation_id = o.id
        WHERE m.user_id = ? AND m.role IN ('owner','admin','developer')
          AND o.status = 'active'
        ORDER BY o.name`,
      [session.user_id],
    );

    const fail = (message) =>
      page(res, 'developers/new', session, {
        title: 'New application',
        path: '/developers/new',
        organisations,
        values: { name, description, client_type: clientType, redirect_uri: redirect },
        error: message,
      });

    if (!name) return fail('Give the application a name. It is what people see on the consent screen.');

    let organisationId = Number(req.body.organisation_id) || 0;
    if (organisations.length === 1) organisationId = organisations[0].id;
    if (!organisations.some((row) => row.id === organisationId)) {
      if (session.is_staff && organisationId) {
        // Staff may place an application anywhere; everybody else may not.
      } else {
        return fail('Choose the organisation this application belongs to.');
      }
    }

    /*
     * A `service` client has no redirect URI at all — it never sends a person
     * anywhere, it exchanges its own credentials for a token. Asking for one
     * would be asking for a field that must stay empty.
     */
    let checked = null;
    if (clientType !== 'service') {
      if (!redirect) {
        return fail(
          'A redirect URI is required. It is the one address this application may receive a sign-in at.',
        );
      }
      checked = portal.checkRedirect(redirect, clientType);
      if (!checked.ok) return fail(checked.error);
    }

    // A slug that is unique. Two applications called "Menu" are ordinary; two
    // rows with the same slug are a 1062 in the middle of a form post.
    let slug = portal.slugify(name) || 'app';
    // eslint-disable-next-line no-await-in-loop -- at most a handful of tries
    while (await db.one('SELECT id FROM applications WHERE slug = ?', [slug])) {
      slug = `${portal.slugify(name) || 'app'}-${crypto.randomBytes(2).toString('hex')}`;
    }

    /*
     * `pairwise` for anything not first-party, which is the default in the
     * schema and worth not overriding here. A third-party developer gets a
     * subject that is stable for them and useless to anybody else, so two
     * unrelated applications cannot compare user lists.
     */
    const result = await db.execute(
      `INSERT INTO applications
         (organisation_id, client_id, name, slug, description, client_type,
          allow_self_enroll, subject_type, sector_salt, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'pairwise', ?, ?)`,
      [
        organisationId,
        crypto.randomBytes(16).toString('hex'),
        name,
        slug,
        description,
        clientType,
        crypto.randomBytes(16).toString('hex'),
        session.user_id,
      ],
    );
    const applicationId = result.insertId;

    /*
     * What a new application starts with. Authorisation code and refresh, PKCE
     * implied — there is no other interactive grant here. `client_credentials`
     * only for a service client, because handing a browser-based application a
     * machine grant it did not ask for is how one ends up used.
     */
    const grants =
      clientType === 'service'
        ? ['client_credentials']
        : ['authorization_code', 'refresh_token'];
    for (const grant of grants) {
      // eslint-disable-next-line no-await-in-loop -- two rows
      await db.execute(
        'INSERT IGNORE INTO application_grants (application_id, grant_type) VALUES (?, ?)',
        [applicationId, grant],
      );
    }

    // The three scopes every sign-in needs, and nothing else. Anything more is
    // a decision the developer makes on the scopes page, having read what each
    // one tells the person on the consent screen.
    for (const scope of ['openid', 'profile', 'email']) {
      // eslint-disable-next-line no-await-in-loop -- three rows
      await db.execute(
        `INSERT IGNORE INTO application_scopes (application_id, scope_id)
         SELECT ?, id FROM scopes WHERE name = ?`,
        [applicationId, scope],
      );
    }

    if (checked) {
      await db.execute(
        `INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
         VALUES (?, ?, 'login')`,
        [applicationId, checked.value],
      );
    }

    // Whoever created it administers it, whatever their organisation role.
    await db.execute(
      `INSERT INTO application_developers (application_id, user_id, role, granted_by)
       VALUES (?, ?, 'admin', ?)
       ON DUPLICATE KEY UPDATE role = 'admin'`,
      [applicationId, session.user_id, session.user_id],
    );

    const application = await db.one('SELECT * FROM applications WHERE id = ?', [applicationId]);

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.created',
      targetType: 'application',
      targetId: application.client_id,
      applicationId,
      detail: { name, client_type: clientType },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.redirect(303, `/developers/a/${application.client_id}?created=1`);
  } catch (error) {
    return next(error);
  }
});

// ===========================================================================
// One application
// ===========================================================================

router.get('/developers/a/:clientId', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await portal.access(session, req.params.clientId);
    if (!found) return notFound(res, session);

    const detail = await portal.detail(found.application.id);
    const people = await db.one(
      `SELECT COUNT(*) AS total FROM application_members
        WHERE application_id = ? AND status = 'active'`,
      [found.application.id],
    );

    return page(res, 'developers/overview', session, {
      title: found.application.name,
      path: `/developers/a/${req.params.clientId}`,
      rail: appRail(req.params.clientId),
      application: found.application,
      role: found.role,
      detail,
      people: people.total,
      created: req.query.created === '1',
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/settings', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) return back(res, req.params.clientId, '', 'error=' + encodeURIComponent('A name is required.'));

    /*
     * The client TYPE is changeable, and it has to be checked against what is
     * already registered. Turning a native client into a web one while it holds
     * a `http://127.0.0.1` redirect would leave a URI registered that the rules
     * would no longer accept — and the mismatch would only appear at sign-in.
     */
    const clientType = ['web', 'spa', 'native', 'service'].includes(req.body.client_type)
      ? req.body.client_type
      : found.application.client_type;

    if (clientType !== found.application.client_type) {
      const registered = await db.query(
        `SELECT uri FROM application_redirect_uris WHERE application_id = ?`,
        [found.application.id],
      );
      for (const row of registered) {
        const check = portal.checkRedirect(row.uri, clientType);
        if (!check.ok) {
          return back(
            res,
            req.params.clientId,
            '',
            'error=' +
              encodeURIComponent(
                `${row.uri} is not allowed for that application type. Remove it first, then change the type.`,
              ),
          );
        }
      }
    }

    await db.execute(
      `UPDATE applications
          SET name = ?, description = ?, client_type = ?, homepage_url = ?,
              privacy_url = ?, terms_url = ?, support_email = ?, allow_self_enroll = ?,
              guest_allowed = ?
        WHERE id = ?`,
      [
        name,
        String(req.body.description || '').slice(0, 500),
        clientType,
        String(req.body.homepage_url || '').slice(0, 255),
        String(req.body.privacy_url || '').slice(0, 255),
        String(req.body.terms_url || '').slice(0, 255),
        String(req.body.support_email || '').slice(0, 190),
        req.body.allow_self_enroll === '1' ? 1 : 0,
        req.body.guest_allowed === '1' ? 1 : 0,
        found.application.id,
      ],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.updated',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, '');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

router.get('/developers/a/:clientId/redirects', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await portal.access(session, req.params.clientId);
    if (!found) return notFound(res, session);

    const detail = await portal.detail(found.application.id);
    return page(res, 'developers/redirects', session, {
      title: 'Redirect URIs',
      path: `/developers/a/${req.params.clientId}/redirects`,
      rail: appRail(req.params.clientId),
      application: found.application,
      role: found.role,
      detail,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/redirects', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const kind = req.body.kind === 'logout' ? 'logout' : 'login';
    const check = portal.checkRedirect(req.body.uri, found.application.client_type);
    if (!check.ok) {
      return back(res, req.params.clientId, 'redirects', `error=${encodeURIComponent(check.error)}`);
    }

    await db.execute(
      `INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
       VALUES (?, ?, ?)`,
      [found.application.id, check.value, kind],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.redirect_added',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { uri: check.value, kind },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'redirects');
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/redirects/:id/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const row = await db.one(
      'SELECT * FROM application_redirect_uris WHERE id = ? AND application_id = ?',
      [Number(req.params.id) || 0, found.application.id],
    );
    if (!row) return back(res, req.params.clientId, 'redirects');

    /*
     * Removing the last login redirect is refused. An application with none can
     * never complete a sign-in again, and the failure appears as
     * `invalid_request` to every one of its users at once — long after whoever
     * pressed the button has moved on.
     */
    if (row.kind === 'login') {
      const remaining = await db.one(
        `SELECT COUNT(*) AS total FROM application_redirect_uris
          WHERE application_id = ? AND kind = 'login'`,
        [found.application.id],
      );
      if (remaining.total <= 1) {
        return back(
          res,
          req.params.clientId,
          'redirects',
          'error=' +
            encodeURIComponent(
              'That is the only sign-in address this application has. Add the new one first, then remove this.',
            ),
        );
      }
    }

    await db.execute('DELETE FROM application_redirect_uris WHERE id = ?', [row.id]);
    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.redirect_removed',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { uri: row.uri, kind: row.kind },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'redirects');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Credentials, and machine-to-machine access
// ---------------------------------------------------------------------------

router.get('/developers/a/:clientId/credentials', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await portal.access(session, req.params.clientId);
    if (!found) return notFound(res, session);

    const detail = await portal.detail(found.application.id);

    /*
     * The plaintext, if this render is the one immediately after minting it.
     * `claim` deletes it as it reads, so a refresh of this page shows the list
     * without it — which is the behaviour the warning on screen promises.
     */
    const shown = portal.claim(req.query.shown);

    return page(res, 'developers/credentials', session, {
      title: 'Credentials & API',
      path: `/developers/a/${req.params.clientId}/credentials`,
      rail: appRail(req.params.clientId),
      application: found.application,
      role: found.role,
      detail,
      shown,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/secrets', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    /*
     * A public client gets no secret, and the refusal is the product.
     *
     * A single-page app and a desktop app both ship everything they contain to
     * whoever runs them, so a secret inside either is not a secret. Issuing one
     * anyway is the classic hole: the developer believes the application is
     * confidential, and a token endpoint that trusts the secret will hand a
     * token to anybody who read it out of the bundle. PKCE is what protects
     * these, and it is required of every client here regardless.
     */
    if (found.application.client_type === 'spa' || found.application.client_type === 'native') {
      return back(
        res,
        req.params.clientId,
        'credentials',
        'error=' +
          encodeURIComponent(
            'A browser or desktop app cannot keep a secret — anything shipped inside it can be read. This type uses PKCE instead, which needs no secret.',
          ),
      );
    }

    const live = await db.one(
      `SELECT COUNT(*) AS total FROM application_secrets
        WHERE application_id = ? AND revoked_at IS NULL`,
      [found.application.id],
    );
    /*
     * Five is not a security limit, it is a tidiness one. Rotation needs two
     * live at a time; a list of fifteen means nobody knows which of them is in
     * use, and revoking the wrong one is an outage.
     */
    if (live.total >= 5) {
      return back(
        res,
        req.params.clientId,
        'credentials',
        'error=' + encodeURIComponent('Revoke one of the existing secrets first — five is the limit.'),
      );
    }

    const minted = await portal.mintSecret(
      found.application.id,
      req.body.label,
      session.user_id,
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.secret_minted',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      // The hint, never the secret. An audit log is read by more people than a
      // credential store, and quoting a secret into one is how it escapes.
      detail: { secret_id: minted.id, hint: minted.secret.slice(-4) },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.redirect(
      303,
      `/developers/a/${encodeURIComponent(req.params.clientId)}/credentials?shown=${minted.handle}`,
    );
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/secrets/:id/revoke', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const row = await db.one(
      'SELECT * FROM application_secrets WHERE id = ? AND application_id = ? AND revoked_at IS NULL',
      [Number(req.params.id) || 0, found.application.id],
    );
    if (!row) return back(res, req.params.clientId, 'credentials');

    await db.execute('UPDATE application_secrets SET revoked_at = NOW() WHERE id = ?', [row.id]);

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.secret_revoked',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { secret_id: row.id, hint: row.hint },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'credentials');
  } catch (error) {
    return next(error);
  }
});

/** Turn machine-to-machine access on or off. */
router.post('/developers/a/:clientId/grants', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const wanted = new Set(
      []
        .concat(req.body.grant_type || [])
        .filter((value) =>
          ['authorization_code', 'refresh_token', 'client_credentials'].includes(value),
        ),
    );

    /*
     * A public client may not hold client_credentials. The grant IS the secret
     * — there is no user in it, only the credential — so allowing it on a
     * client that cannot keep one would hand a machine token to whoever unzips
     * the app.
     */
    if (
      wanted.has('client_credentials') &&
      (found.application.client_type === 'spa' || found.application.client_type === 'native')
    ) {
      return back(
        res,
        req.params.clientId,
        'credentials',
        'error=' +
          encodeURIComponent(
            'Machine-to-machine access needs a client secret, and a browser or desktop app cannot keep one.',
          ),
      );
    }
    if (!wanted.size) {
      return back(
        res,
        req.params.clientId,
        'credentials',
        'error=' + encodeURIComponent('An application with no grant types cannot issue a token at all.'),
      );
    }

    await db.execute('DELETE FROM application_grants WHERE application_id = ?', [
      found.application.id,
    ]);
    for (const grant of wanted) {
      // eslint-disable-next-line no-await-in-loop -- three rows at most
      await db.execute(
        'INSERT IGNORE INTO application_grants (application_id, grant_type) VALUES (?, ?)',
        [found.application.id, grant],
      );
    }

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.grants_changed',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { grants: [...wanted] },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'credentials');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

router.get('/developers/a/:clientId/scopes', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await portal.access(session, req.params.clientId);
    if (!found) return notFound(res, session);

    const detail = await portal.detail(found.application.id);
    return page(res, 'developers/scopes', session, {
      title: 'Data it may ask for',
      path: `/developers/a/${req.params.clientId}/scopes`,
      rail: appRail(req.params.clientId),
      application: found.application,
      role: found.role,
      detail,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/scopes', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const wanted = []
      .concat(req.body.scope || [])
      .map((value) => Number(value))
      .filter(Boolean);

    /*
     * A sensitive scope cannot be self-granted. `phone` is one: an application
     * that can read a mobile number can also try to use it, and the person
     * granting the consent has no way to know whether the developer was
     * reviewed. Staff can add it, and the review is the point.
     */
    const sensitive = await db.query('SELECT id, name FROM scopes WHERE is_sensitive = 1');
    const blocked = sensitive.filter((row) => wanted.includes(row.id));
    if (blocked.length && !session.is_staff) {
      const already = await db.query(
        'SELECT scope_id FROM application_scopes WHERE application_id = ?',
        [found.application.id],
      );
      const held = new Set(already.map((row) => row.scope_id));
      const newlyAsked = blocked.filter((row) => !held.has(row.id));
      if (newlyAsked.length) {
        return back(
          res,
          req.params.clientId,
          'scopes',
          'error=' +
            encodeURIComponent(
              `${newlyAsked.map((row) => row.name).join(', ')} needs review before an application may ask for it. Write to developers@vesopa.com.`,
            ),
        );
      }
    }

    await db.execute('DELETE FROM application_scopes WHERE application_id = ?', [
      found.application.id,
    ]);
    for (const scopeId of wanted) {
      // eslint-disable-next-line no-await-in-loop -- a short list
      await db.execute(
        'INSERT IGNORE INTO application_scopes (application_id, scope_id) VALUES (?, ?)',
        [found.application.id, scopeId],
      );
    }
    // `openid` is what makes this OpenID Connect rather than plain OAuth and is
    // always available; putting it back rather than trusting the form keeps the
    // list honest about what the application can actually ask for.
    await db.execute(
      `INSERT IGNORE INTO application_scopes (application_id, scope_id)
       SELECT ?, id FROM scopes WHERE name = 'openid'`,
      [found.application.id],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.scopes_changed',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'scopes');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

router.get('/developers/a/:clientId/roles', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await portal.access(session, req.params.clientId);
    if (!found) return notFound(res, session);

    const detail = await portal.detail(found.application.id);
    return page(res, 'developers/roles', session, {
      title: 'Roles',
      path: `/developers/a/${req.params.clientId}/roles`,
      rail: appRail(req.params.clientId),
      application: found.application,
      role: found.role,
      detail,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/roles', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const key = String(req.body.role_key || '')
      .trim()
      .toLowerCase()
      .slice(0, 64);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
      return back(
        res,
        req.params.clientId,
        'roles',
        'error=' +
          encodeURIComponent(
            'A role key is lowercase letters, numbers, dots, dashes and underscores — "till.manager".',
          ),
      );
    }

    await db.execute(
      `INSERT INTO application_roles (application_id, role_key, name, description, is_default)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
                               is_default = VALUES(is_default)`,
      [
        found.application.id,
        key,
        String(req.body.name || key).slice(0, 120),
        String(req.body.description || '').slice(0, 255),
        req.body.is_default === '1' ? 1 : 0,
      ],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.role_saved',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { role_key: key },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'roles');
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/roles/:id/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    const row = await db.one(
      'SELECT * FROM application_roles WHERE id = ? AND application_id = ?',
      [Number(req.params.id) || 0, found.application.id],
    );
    if (!row) return back(res, req.params.clientId, 'roles');

    /*
     * Deleting a role deletes it from everybody who holds it, and the token
     * they are issued tomorrow will be missing a claim their application checks
     * for. Said out loud rather than done quietly.
     */
    const held = await db.one(
      'SELECT COUNT(*) AS total FROM application_member_roles WHERE role_id = ?',
      [row.id],
    );
    if (held.total > 0 && req.body.confirm !== 'yes') {
      return back(
        res,
        req.params.clientId,
        'roles',
        'error=' +
          encodeURIComponent(
            `${held.total} ${held.total === 1 ? 'person holds' : 'people hold'} that role. Removing it takes it from all of them.`,
          ),
      );
    }

    await db.execute('DELETE FROM application_roles WHERE id = ?', [row.id]);
    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.role_removed',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { role_key: row.role_key, held: held.total },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'roles');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Who uses it
// ---------------------------------------------------------------------------

router.get('/developers/a/:clientId/people', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await portal.access(session, req.params.clientId);
    if (!found) return notFound(res, session);

    const search = String(req.query.q || '').trim().slice(0, 120);
    const like = `%${search}%`;

    /*
     * Bounded, always. A developer looking at an application with fifty
     * thousand users must not be able to ask for all of them by opening a page
     * — and the LIMIT is on the query, not on what is rendered, because the
     * damage is done by the time rows reach the template.
     */
    const members = await db.query(
      `SELECT m.id, m.status, m.external_ref, m.first_seen_at, m.last_seen_at,
              u.public_id, u.display_name,
              (SELECT i.identifier FROM user_identities i WHERE i.id = u.primary_email_id) AS email,
              (SELECT GROUP_CONCAT(r.role_key ORDER BY r.role_key SEPARATOR ', ')
                 FROM application_member_roles mr
                 JOIN application_roles r ON r.id = mr.role_id
                WHERE mr.member_id = m.id) AS roles
         FROM application_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.application_id = ?
          ${search ? 'AND (u.display_name LIKE ? OR u.public_id = ?)' : ''}
        ORDER BY m.last_seen_at IS NULL, m.last_seen_at DESC, m.id DESC
        LIMIT 100`,
      search ? [found.application.id, like, search] : [found.application.id],
    );

    const totals = await db.one(
      `SELECT COUNT(*) AS total,
              SUM(status = 'active') AS active,
              SUM(last_seen_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS recent
         FROM application_members WHERE application_id = ?`,
      [found.application.id],
    );

    return page(res, 'developers/people', session, {
      title: 'Who uses it',
      path: `/developers/a/${req.params.clientId}/people`,
      rail: appRail(req.params.clientId),
      application: found.application,
      role: found.role,
      members,
      totals,
      search,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Who may edit it
// ---------------------------------------------------------------------------

router.get('/developers/a/:clientId/team', async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await portal.access(session, req.params.clientId);
    if (!found) return notFound(res, session);

    const detail = await portal.detail(found.application.id);
    const organisation = await db.query(
      `SELECT m.role, u.public_id, u.display_name,
              (SELECT i.identifier FROM user_identities i WHERE i.id = u.primary_email_id) AS email
         FROM organisation_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = ?
        ORDER BY FIELD(m.role,'owner','admin','developer','viewer'), u.display_name`,
      [found.application.organisation_id],
    );

    return page(res, 'developers/team', session, {
      title: 'Who may edit it',
      path: `/developers/a/${req.params.clientId}/team`,
      rail: appRail(req.params.clientId),
      application: found.application,
      role: found.role,
      detail,
      organisation,
      saved: req.query.saved === '1',
      error: req.query.error || '',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/team', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'grant');
    if (!found) return undefined;

    const email = String(req.body.email || '').trim().toLowerCase();
    const role = ['admin', 'developer', 'viewer'].includes(req.body.role)
      ? req.body.role
      : 'developer';

    const target = await db.one(
      `SELECT u.id, u.display_name FROM users u
         JOIN user_identities i ON i.user_id = u.id
        WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL
          AND u.status = 'active'`,
      [normaliseEmail(email)],
    );

    /*
     * The person must already have a Vesopa account, and saying so plainly is
     * better than the alternative. Creating an account here would mean this
     * form can mint identities from an address nobody has proved they own —
     * and the first that person hears of it is a credential they did not ask
     * for. Invitations are the right shape for that, and are Phase 5.
     */
    if (!target) {
      return back(
        res,
        req.params.clientId,
        'team',
        'error=' +
          encodeURIComponent(
            `Nobody signs in with ${email} yet. Ask them to create a Vesopa account first, then add them here.`,
          ),
      );
    }

    await db.execute(
      `INSERT INTO application_developers (application_id, user_id, role, granted_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
      [found.application.id, target.id, role, session.user_id],
    );
    // Reaching the portal at all is a separate gate from reaching one
    // application inside it, and granting the second without the first is a
    // grant that does nothing.
    await db.execute('UPDATE users SET is_developer = 1 WHERE id = ?', [target.id]);

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.developer_granted',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { user: target.id, role },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'team');
  } catch (error) {
    return next(error);
  }
});

router.post('/developers/a/:clientId/team/:id/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'grant');
    if (!found) return undefined;

    const row = await db.one(
      'SELECT * FROM application_developers WHERE id = ? AND application_id = ?',
      [Number(req.params.id) || 0, found.application.id],
    );
    if (!row) return back(res, req.params.clientId, 'team');

    /*
     * Removing the last administrator is refused — an application nobody can
     * administer needs a database session to rescue, which is exactly the
     * situation this portal exists to remove.
     */
    if (row.role === 'admin') {
      const admins = await db.one(
        `SELECT COUNT(*) AS total FROM application_developers
          WHERE application_id = ? AND role = 'admin'`,
        [found.application.id],
      );
      if (admins.total <= 1) {
        return back(
          res,
          req.params.clientId,
          'team',
          'error=' +
            encodeURIComponent('That is the only administrator. Add another one before removing this.'),
        );
      }
    }

    await db.execute('DELETE FROM application_developers WHERE id = ?', [row.id]);
    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.developer_revoked',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      detail: { user: row.user_id },
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return back(res, req.params.clientId, 'team');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------
//
// WHY THIS IS NOT DECORATION. The consent screen is where somebody decides
// whether to hand an application their email address, and the only things on it
// that identify the application are its name, its links and its mark. With no
// mark every application looks the same — so none of them looks UNFAMILIAR,
// which is exactly the recognition that ought to make a person stop and read.

router.post(
  '/developers/a/:clientId/logo',
  uploadLogo.single('logo'),
  csrf.verify,
  async (req, res, next) => {
    try {
      const session = await guard(req, res);
      if (!session) return undefined;
      const found = await open(req, res, session, 'write');
      if (!found) return undefined;

      if (!req.file) {
        return back(
          res,
          req.params.clientId,
          '',
          'error=' +
            encodeURIComponent('Choose a PNG, JPEG or WebP image under 512 KB. A square one looks best.'),
        );
      }

      await logos.store(
        found.application.id,
        found.application.client_id,
        req.file.buffer,
        req.file.mimetype,
      );

      await events.recordAudit({
        actorUserId: session.user_id,
        actorType: 'developer',
        action: 'application.logo_changed',
        targetType: 'application',
        targetId: found.application.client_id,
        applicationId: found.application.id,
        ip: req.clientIp,
        userAgent: req.userAgent,
      });

      return back(res, req.params.clientId, '');
    } catch (error) {
      if (String(error.message || '').includes('unsupported image type')) {
        return back(
          res,
          req.params.clientId,
          '',
          'error=' +
            encodeURIComponent(
              'That file is not a PNG, JPEG or WebP. SVG is deliberately not accepted — it can carry script, and it would be served from this domain.',
            ),
        );
      }
      if (String(error.message || '').includes('too large')) {
        return back(
          res,
          req.params.clientId,
          '',
          'error=' + encodeURIComponent('That image is over 512 KB. It is drawn at 48 pixels.'),
        );
      }
      return next(error);
    }
  },
);

router.post('/developers/a/:clientId/logo/remove', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'write');
    if (!found) return undefined;

    await logos.clear(found.application.id);
    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.logo_removed',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });
    return back(res, req.params.clientId, '');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

router.post('/developers/a/:clientId/archive', csrf.verify, async (req, res, next) => {
  try {
    const session = await guard(req, res);
    if (!session) return undefined;
    const found = await open(req, res, session, 'grant');
    if (!found) return undefined;

    if (String(req.body.confirm || '').trim() !== found.application.name) {
      return back(
        res,
        req.params.clientId,
        '',
        'error=' + encodeURIComponent('Type the application name exactly to archive it.'),
      );
    }

    /*
     * Archived, not deleted, and stopped in two ways: `deleted_at` hides it
     * from the portal, `status` is what `clients.find` checks, so an
     * authorisation request stops working immediately. Every live token is
     * revoked with it — an application nobody may sign into should not still
     * be able to read anybody's profile for the next thirty days.
     */
    await db.execute(
      "UPDATE applications SET deleted_at = NOW(), archived_by = ?, status = 'suspended' WHERE id = ?",
      [session.user_id, found.application.id],
    );
    await db.execute(
      'UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE application_id = ? AND revoked_at IS NULL',
      [found.application.id],
    );

    await events.recordAudit({
      actorUserId: session.user_id,
      actorType: 'developer',
      action: 'application.archived',
      targetType: 'application',
      targetId: found.application.client_id,
      applicationId: found.application.id,
      ip: req.clientIp,
      userAgent: req.userAgent,
    });

    return res.redirect(303, '/developers?archived=1');
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
