/**
 * Things that are wrong in a way nothing else notices until somebody cannot
 * sign in.
 *
 * WHY THIS FILE EXISTS
 *
 * Vesopa Kitchen, Vesopa Display and Vesopa Express were added as OAuth clients
 * by a migration that wrote straight into `applications`. Everything an
 * application also needs -- the GRANTS it may use, the SCOPES it may ask for --
 * is added by the developer portal when a client is made there, and a migration
 * writing raw SQL goes round the outside of all of it.
 *
 * The result was three clients that existed, had the right ids, were handed out
 * by the right endpoints, and could not be signed in to at all: a client with no
 * grant rows is refused the authorization_code flow with `unauthorized_client`.
 * Nobody found out until a build shipped and somebody opened it on a new machine
 * in a venue.
 *
 * Every check that was run at the time was on the shape of the configuration.
 * None of them asked the only question that mattered: WOULD THIS ACTUALLY WORK.
 * This asks it, at boot, on every deploy, for free.
 *
 * IT WARNS, IT NEVER REFUSES TO START. An identity provider that would not boot
 * because one application of nine is misconfigured would take every other
 * product down with it — including the back office people would use to fix it.
 * The right outcome is a loud line in the log and a server that still works for
 * everybody else.
 */
const db = require('./db');

/**
 * Applications that cannot complete a sign-in, and why.
 *
 * Only `active` ones: a suspended or pending application is not expected to
 * work, and warning about it every boot is how a log stops being read.
 */
async function unusableClients() {
  try {
    return await db.query(
      `SELECT a.id, a.name, a.slug, a.client_type,
              (SELECT COUNT(*) FROM application_grants g
                WHERE g.application_id = a.id) AS grants,
              (SELECT COUNT(*) FROM application_scopes s
                WHERE s.application_id = a.id) AS scopes,
              (SELECT COUNT(*) FROM application_redirect_uris r
                WHERE r.application_id = a.id AND r.kind = 'login') AS redirects
         FROM applications a
        WHERE a.status = 'active' AND a.deleted_at IS NULL
       HAVING grants = 0 OR scopes = 0 OR redirects = 0
        ORDER BY a.slug`,
    );
  } catch (error) {
    // A database mid-migration is not a reason to fail a boot check whose whole
    // purpose is to be advisory.
    console.warn('[selfcheck] could not check the applications:', error.message);
    return [];
  }
}

/** Say what is broken, in words that name the fix. */
async function report() {
  const broken = await unusableClients();
  if (!broken.length) {
    console.log('[boot] every active application can be signed in to');
    return broken;
  }

  console.error(
    `[boot] ${broken.length} application(s) CANNOT BE SIGNED IN TO — ` +
      'a client missing grants is refused with unauthorized_client:',
  );
  for (const app of broken) {
    const missing = [];
    if (!Number(app.grants)) missing.push('no grants');
    if (!Number(app.scopes)) missing.push('no scopes');
    if (!Number(app.redirects)) missing.push('no login redirect URI');
    console.error(`[boot]   ${app.slug} (id ${app.id}, ${app.client_type}) — ${missing.join(', ')}`);
  }
  console.error(
    '[boot]   Fix in the developer portal, or copy from a working client — ' +
      'see schema_015_new_client_grants.sql.',
  );
  return broken;
}

module.exports = { unusableClients, report };
