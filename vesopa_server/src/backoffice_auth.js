/**
 * Signing in to the back office with a Vesopa account — Phase 6, the second
 * migration.
 *
 * IT SHIPS DORMANT, like the menu did. Nothing here answers anything unless
 * `VESOPA_AUTH_BACKOFFICE_ENABLED` is set and the credentials are present.
 * Rollback is flipping a flag and restarting, not a deploy under pressure.
 *
 * THE PASSWORD LOGIN IS UNTOUCHED. This adds a second door, and both stay open
 * for the whole soak. Nobody is forced to move, no password is reset, and a
 * member of staff who has never heard of any of this signs in exactly as they
 * did yesterday. That is rule 3 of the migration plan and it is the difference
 * between a migration and an incident.
 *
 * WHAT HAPPENS ON A FIRST VESOPA SIGN-IN
 *
 * The person is matched to an EXISTING back-office user by their verified email
 * address, and the two are linked by `vesopa_sub`. After that the address does
 * not matter: the subject is what identifies them, because an address can
 * change on either side and a subject cannot.
 *
 * IT NEVER CREATES A BACK-OFFICE USER. That is the important refusal. The back
 * office is staff-only, scoped to an office, with roles that decide who may
 * change a price — so "somebody with a Vesopa account turned up" is not a
 * reason to make them staff anywhere. An unrecognised address is told to ask
 * their manager, and nothing is written.
 */

const express = require('express');

const { createClient } = require('./vesopa_oidc');

const ENABLED = String(process.env.VESOPA_AUTH_BACKOFFICE_ENABLED || '').toLowerCase() === 'on';

const BACKOFFICE_HOST = (process.env.VESOPA_BACKOFFICE_DOMAIN || 'backoffice.vesopaepos.com')
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\//, '');

const client = createClient({
  label: 'backoffice_auth',
  clientId: process.env.VESOPA_AUTH_BACKOFFICE_CLIENT_ID || '',
  clientSecret: process.env.VESOPA_AUTH_BACKOFFICE_CLIENT_SECRET || '',
  redirectUri: `https://${BACKOFFICE_HOST}/auth/vesopa/callback`,
  scope: 'openid profile email',
});

const LIVE = ENABLED && client.enabled;

/*
 * VESOPA AND NOTHING ELSE.
 *
 * The owner's instruction: *"In the backoffice, no need other options rather
 * then Vesopa Auth."* With this on, the local email-and-password form is not
 * rendered at all and the only way in is a round trip to auth.vesopa.com.
 *
 * IT IS A FLAG AND NOT A DELETION, and that is rule 2 of the migration plan
 * rather than timidity. The password form, its hashes and its reset flow all
 * still exist; rollback is turning this off and restarting, which is a thing
 * somebody can do at seven on a Friday with a room full of covers. Deleting the
 * code would make the rollback a deploy, and a deploy under that kind of
 * pressure is how a bad evening becomes a bad night.
 *
 * It also cannot turn itself on by accident: if Vesopa sign-in is not LIVE,
 * "Vesopa only" would leave the page with no way in at all, so it is ignored.
 */
const ONLY = LIVE && String(process.env.VESOPA_AUTH_BACKOFFICE_ONLY || '').toLowerCase() === 'on';

/**
 * @param pool    the back office's own database
 * @param secret  the JWT secret the back office already signs with
 * @param issueToken(user, secret, ttl) — reused verbatim, so that a session
 *        created this way is indistinguishable downstream from one created by
 *        the password form. Nothing after sign-in has to know which door was
 *        used, which is what keeps the blast radius of this file at zero.
 */
function backofficeAuthRoutes({ pool, secret, issueToken }) {
  const router = express.Router();

  /*
   * Whether to draw the button, asked rather than baked in.
   *
   * The sign-in page is static HTML served from a constant read at start-up, so
   * a button hard-coded into it could not follow the flag — and a button that
   * leads to a 404 is worse than none: somebody picks the option that looks
   * most official and is told it went wrong.
   */
  router.get('/api/public/backoffice/sign-in-options', (req, res) => {
    res.set('Cache-Control', 'no-store');
    /*
     * `only` tells the page to stop drawing the password form. It is answered
     * by the server rather than baked into index.html because that file is read
     * into a constant at start-up — see the README — so a flag change would
     * otherwise need a deploy to be seen.
     */
    res.json({ vesopa: LIVE, only: ONLY });
  });

  if (!LIVE) {
    /*
     * Dormant, and honestly so. A 404 rather than a friendly message: the
     * feature does not exist yet as far as anybody outside is concerned, and a
     * "coming soon" page on an authentication path is an invitation to poke.
     */
    router.use('/auth/vesopa', (req, res) => res.status(404).end());
    return router;
  }

  // ------------------------------------------------------------------ start
  router.get('/auth/vesopa/start', (req, res) => {
    const { url } = client.begin({ returnTo: '/' });
    return res.redirect(303, url);
  });

  // --------------------------------------------------------------- callback
  router.get('/auth/vesopa/callback', async (req, res) => {
    let claims;
    try {
      ({ claims } = await client.complete(req.query));
    } catch (error) {
      console.warn('[backoffice_auth] sign-in did not complete:', error.message);
      return res.status(400).send(page('We could not finish signing you in. Please try again, or use your password.'));
    }

    /*
     * An unverified address proves nothing.
     *
     * Vesopa only issues `email_verified: true` for an address it has itself
     * confirmed, or one a provider it trusts has confirmed. Matching a staff
     * account on anything less would mean somebody could claim a colleague's
     * address at a provider we do not vet and be handed their back office.
     */
    if (!claims.email || claims.email_verified !== true) {
      return res.status(403).send(
        page('Your Vesopa account has no confirmed email address, so we cannot match it to a back-office user.'),
      );
    }

    try {
      const user = await linkAndFind(pool, claims);
      if (!user) {
        return res.status(403).send(
          page(
            `There is no back-office user for ${escapeHtml(claims.email)}. ` +
              'Ask whoever manages your venue to add you, then try again.',
          ),
        );
      }
      if (user.blocked) {
        return res.status(403).send(page(user.blocked));
      }

      /*
       * The back office's OWN token, minted by the back office's own function,
       * handed over exactly as /api/login does — token AND user, under the two
       * keys the app reads at start-up.
       *
       * Storing only the token would leave the app with a credential and no
       * idea who it belongs to, which presents as a sign-in that "works" and
       * then shows an empty shell. The password form writes both; so does this.
       */
      const token = issueToken(user, secret);
      return res.send(handOver(token, user));
    } catch (error) {
      console.error('[backoffice_auth] callback failed:', error);
      return res.status(500).send(page('Something went wrong. Please use your password for now.'));
    }
  });

  return router;
}

/**
 * Find the staff member this Vesopa account belongs to, and remember the link.
 *
 * By subject first, address second. Once linked, the address is irrelevant —
 * which is what lets somebody change their email at either end without losing
 * access, and what stops a recycled address at some future employer matching an
 * old staff row.
 */
async function linkAndFind(pool, claims) {
  const sub = String(claims.sub || '');
  const email = String(claims.email || '').trim().toLowerCase();

  /*
   * NAMED COLUMNS, NEVER `u.*`.
   *
   * The row carries the bcrypt password hash, and the object built from it is
   * written into the page and into localStorage. `SELECT u.*` would put a
   * password hash in both — in the HTML of a response, and in a store any
   * script on the origin can read. The password form has always returned a
   * hand-built object for exactly this reason; this returns the same one.
   */
  const columns = `u.id, u.email, u.name, u.approved, u.role, u.office_id, u.vesopa_sub,
                   o.status AS office_status, o.name AS office_name,
                   o.contact_email AS office_email`;

  const [bySub] = await pool.execute(
    `SELECT ${columns}
       FROM backoffice_users u LEFT JOIN offices o ON o.id = u.office_id
      WHERE u.vesopa_sub = ? LIMIT 1`,
    [sub],
  );

  let row = bySub[0];

  if (!row) {
    const [byEmail] = await pool.execute(
      `SELECT ${columns}
         FROM backoffice_users u LEFT JOIN offices o ON o.id = u.office_id
        WHERE LOWER(u.email) = ? LIMIT 1`,
      [email],
    );
    if (!byEmail.length) return null;
    row = byEmail[0];

    /*
     * Refuse to steal a link that belongs to somebody else.
     *
     * If this staff row is already linked to a DIFFERENT Vesopa account, two
     * people are claiming one member of staff. Overwriting would silently hand
     * the account to whoever signed in most recently, so it stops and somebody
     * looks at it.
     */
    if (row.vesopa_sub && row.vesopa_sub !== sub) {
      throw new Error(`backoffice_users ${row.id} is already linked to another Vesopa account`);
    }

    // Conditional, so two callbacks racing cannot both claim the row.
    await pool.execute(
      'UPDATE backoffice_users SET vesopa_sub = ?, vesopa_linked_at = NOW() WHERE id = ? AND vesopa_sub IS NULL',
      [sub, row.id],
    );
  }

  /*
   * The SAME rules the password form applies, in the same order.
   *
   * `approved` is the string 'Y', not a boolean — and the platform admin has no
   * office and is deliberately exempt from the office check, or a billing
   * dispute would lock out the one person who could resolve it. Reimplementing
   * these loosely would make the new door weaker than the old one, which is the
   * classic way a second sign-in route becomes the way in.
   */
  if (row.approved !== 'Y') return { blocked: 'This account has not been approved.' };

  if (row.role !== 'admin' && row.office_status && row.office_status !== 'active') {
    return { blocked: `This office is ${row.office_status}. Please contact Vesopa support.` };
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role || 'office',
    officeId: row.office_id,
    officeName: row.office_name,
    officeEmail: row.office_email,
  };
}

/**
 * Hand the token to the single-page app the way it expects to receive one.
 *
 * Written into sessionStorage by a tiny inline script and then replaced in
 * history, so the token never sits in a URL — a URL is written to the access
 * log, kept in browser history and passed on as a Referer, and the thing being
 * passed here is a working session.
 */
function handOver(token, user) {
  /*
   * `</script>` inside a JSON string would end the script tag early, so the
   * `<` is escaped. It cannot occur in a JWT, but `user` carries a name typed
   * by a person — and "the field nobody would put a tag in" is where they end
   * up.
   */
  const encode = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  const safeToken = encode(String(token));
  const safeUser = encode(JSON.stringify(user));

  return `<!doctype html><meta charset="utf-8"><title>Signing you in…</title>
<body style="font:16px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:40px;text-align:center">
<p>Signing you in…</p>
<script>
try {
  // localStorage, matching "keep me signed in": somebody who has just come
  // back from another site does not expect to be asked again on the next tab.
  localStorage.setItem('vesopa_token', ${safeToken});
  localStorage.setItem('vesopa_user', ${safeUser});
  sessionStorage.removeItem('vesopa_token');
  sessionStorage.removeItem('vesopa_user');
} catch (e) {}
location.replace('/');
</script>
</body>`;
}

function page(message) {
  return `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<body style="font:16px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:40px;max-width:36em;margin:auto">
<h1 style="font-size:20px">Sign in</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to the back office</a></p>
</body>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*
 * `linkAndFind` is exported because the TILL needs exactly the same decision.
 * A till commissioned with a Vesopa account must be matched, linked and
 * access-checked identically to a browser sign-in — and a second copy of these
 * rules in another file is a copy that drifts, quietly leaving one door with
 * the older, weaker version of the office check.
 */
/**
 * Invite a member of staff to the back office THROUGH their Vesopa account.
 *
 * THE OWNER'S RULE, and the reason this is not just "add a row and hope":
 * *"Backoffice admin decides and create user and invite that user through
 * Vesopa account"*. A back-office user row is a person this venue has decided
 * may see its prices and its takings; a Vesopa account is a person. The two are
 * joined by the manager saying so, and this is that sentence, made into a
 * request.
 *
 * WHAT ACTUALLY HAPPENS. Vesopa emails them a link. The link does not sign
 * anybody in — it opens the ordinary Vesopa sign-in, and the membership is
 * granted only once they have proved they own that address. So an invitation
 * read by somebody else in the office is worth nothing to them, and a manager
 * who mistypes an address has not given the back office away.
 *
 * IT NEVER THROWS AT THE CALLER. A staff row that exists with no invitation
 * sent is a manager pressing the button again; a failed request that took the
 * whole "add a user" operation down with it is a manager who cannot add
 * anybody because an unrelated service is having an afternoon.
 */
async function inviteToVesopa({ email, role = '', message = '' }) {
  if (!LIVE) return { ok: false, error: 'Vesopa sign-in is not switched on here.' };
  if (!email) return { ok: false, error: 'An email address is needed.' };

  const url = `${client.issuer.replace(/\/$/, '')}/api/app/invitations`;
  const credentials = Buffer.from(
    `${encodeURIComponent(process.env.VESOPA_AUTH_BACKOFFICE_CLIENT_ID || '')}:` +
      `${encodeURIComponent(process.env.VESOPA_AUTH_BACKOFFICE_CLIENT_SECRET || '')}`,
  ).toString('base64');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ email, role: role || undefined, message: message || undefined }),
      signal: AbortSignal.timeout(8000),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: body.error_description || body.error || `Vesopa said ${response.status}.` };
    }
    return { ok: true, url: body.url, expiresInDays: body.expires_in_days };
  } catch (error) {
    console.warn('[backoffice_auth] invitation not sent:', error.message);
    return { ok: false, error: 'Vesopa could not be reached. Try again in a moment.' };
  }
}

module.exports = { backofficeAuthRoutes, LIVE, ENABLED, ONLY, client, linkAndFind, inviteToVesopa };
