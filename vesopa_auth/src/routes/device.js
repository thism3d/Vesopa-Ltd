/**
 * The page a desktop application's sign-in comes back to.
 *
 * THE FLOW THE OWNER DESCRIBED, and it is the one everybody already knows from
 * signing in to VS Code with Google:
 *
 *   1. the app shows "Continue with Vesopa" and opens the system browser
 *   2. the browser shows the account chooser and the consent screen
 *   3. it lands HERE — a page on auth.vesopa.com saying it worked
 *   4. the operating system asks "Open Vesopa EPOS?" and the app takes over
 *   5. revoke the link under /account/apps and the app asks again next time
 *
 * WHY A PAGE HERE AND NOT STRAIGHT TO THE APP. Redirecting the browser directly
 * from /oauth/authorize to `vesopa-epos://…` would work on a machine where the
 * app is installed and do nothing visible on one where it is not — no page, no
 * message, no way to tell whether anything happened. It also means the last
 * thing in the address bar is a scheme nobody recognises. A real page on the
 * domain they just signed in to is where somebody's attention already is.
 *
 * THE HONEST WEAKNESS, written down rather than discovered: ANY APPLICATION ON
 * THE MACHINE CAN CLAIM A CUSTOM SCHEME. Whoever registers `vesopa-epos://`
 * receives whatever this page hands over. That is survivable only because PKCE
 * is mandatory on this server — the code is worthless without the verifier,
 * which never leaves the process that started the sign-in. An imposter receives
 * a code it cannot spend. Loopback (RFC 8252) remains the stronger option and
 * is still supported; this is the one that looks like the product people expect.
 *
 * NOTHING IS EXCHANGED HERE. This page never sees a token, never holds a
 * session, and never calls /oauth/token. It passes an authorisation code from
 * one place to another and says what happened. Keeping it that dumb is what
 * makes it safe to render for anybody who arrives with a code in a URL.
 */

const express = require('express');

const config = require('../config');
const db = require('../db');

const router = express.Router();

/**
 * A scheme we are willing to send somebody to.
 *
 * Letters, digits, `+`, `-` and `.` — RFC 3986's own rule, starting with a
 * letter. It matters because the value ends up in an href: a scheme of
 * `javascript` would turn this page into a script-injection point, and one
 * containing a `:` or a `/` could rewrite the whole target. The column is only
 * writable by an application's own administrators, so this is defence in depth
 * rather than the main control — but the main control being elsewhere is not a
 * reason to build the href out of an unchecked string.
 */
function safeScheme(value) {
  const scheme = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]{1,63}$/.test(scheme)) return '';
  // Never a scheme the browser itself acts on.
  if (['javascript', 'data', 'vbscript', 'file', 'about', 'blob'].includes(scheme)) return '';
  return scheme;
}

/**
 * GET /device/callback
 *
 * Registered as an ordinary redirect URI on the application, so
 * `clients.matchRedirect` has already accepted it by exact string before
 * anything reaches this page — there is no special case in the matching code
 * for it, which is how it should be.
 */
router.get('/device/callback', async (req, res, next) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const failure = String(req.query.error || '');

    /*
     * WHICH application is this? The authorisation code does not say, and this
     * page is reached before any token exchange — so the app tells us with
     * `client_id`, which /oauth/authorize passes through in the state it built.
     *
     * A client id is public and unauthenticated here, and that is fine: the
     * worst a forged one can do is send this page's handoff to a different
     * scheme, carrying a code that was minted for a different client and is
     * therefore unspendable. Nothing is granted by looking one up.
     */
    const clientId = String(req.query.client_id || '');
    let application = null;
    if (/^[a-f0-9]{32}$/.test(clientId)) {
      application = await db.one(
        `SELECT name, client_id, app_scheme, app_display_name, logo_path
           FROM applications
          WHERE client_id = ? AND status = 'active' AND deleted_at IS NULL`,
        [clientId],
      );
    }

    const scheme = safeScheme(application && application.app_scheme);
    const appName =
      (application && (application.app_display_name || application.name)) || 'the application';

    /*
     * The hand-off URL. Everything is re-encoded rather than passed through,
     * because what arrives is a query string and what is being built is a
     * different one — copying the raw text across is how a `&` in a state value
     * becomes an extra parameter.
     */
    let handoff = '';
    if (scheme && code) {
      const params = new URLSearchParams({ code, ...(state ? { state } : {}) });
      handoff = `${scheme}://auth/callback?${params.toString()}`;
    }

    return res.render('device-callback', {
      title: failure ? 'Sign-in cancelled' : 'Signed in',
      nonce: res.locals.nonce,
      config,
      application,
      appName,
      handoff,
      failure,
      // A code with no scheme to send it to is a configuration mistake, and the
      // page has to say which — "nothing happened" is the least useful thing a
      // sign-in page can say.
      misconfigured: Boolean(code) && !scheme,
      noindex: true,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
