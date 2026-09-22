/**
 * Answer the consent screen, the way a person's browser would.
 *
 * WHY THIS IS SHARED. `applications.show_consent` defaults to on now — the
 * owner asked for consent on every authorisation, Vesopa's own products
 * included — so `/oauth/authorize` answers 200 with a form the first time
 * instead of redirecting. Four smoke tests drive that endpoint, and when the
 * change landed all four broke in the same way and were fixed one at a time,
 * each rediscovering the same two details. This is those two details, once.
 *
 * THE TWO DETAILS.
 *
 * The CSRF cookie arrives with the consent PAGE and the hidden field has to
 * match it. Sending the field without the cookie is refused with a 403 that
 * says nothing about consent — which is the protection working, and is why this
 * carries both.
 *
 * And the field is found with `indexOf` and a regex LITERAL, not a pattern
 * built from a string. `\s` inside a template literal is not an escape
 * JavaScript recognises and silently collapses to a bare `s`, so a pattern
 * assembled that way matches nothing, the field comes back empty, and the POST
 * is refused — a failure that looks like a cookie problem and is a quoting one.
 * That was got wrong three times in a row before it was written down here.
 */

/**
 * Start an authorisation and consent to it if asked.
 *
 * `authorizeUrl` is the full URL; `cookie` is the session cookie header. The
 * response returned is whatever should carry the redirect — either the original
 * one, when no consent was needed, or the answer to the consent POST.
 */
async function authorizeAnsweringConsent(authorizeUrl, cookie, { base } = {}) {
  const origin = base || new URL(authorizeUrl).origin;

  let response = await fetch(authorizeUrl, { redirect: 'manual', headers: { cookie } });
  if (response.status !== 200) return { response, consented: false };

  const html = await response.text();
  const field = (name) => {
    const marker = `name="${name}"`;
    const at = html.indexOf(marker);
    if (at < 0) return '';
    const found = html
      .slice(at + marker.length, at + marker.length + 400)
      .match(/value="([^"]*)"/);
    return found ? found[1] : '';
  };

  const issued = (response.headers.getSetCookie ? response.headers.getSetCookie() : [])
    .map((line) => line.split(';')[0])
    .join('; ');

  response = await fetch(`${origin}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: issued ? `${cookie}; ${issued}` : cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: field('_csrf'),
      client_id: field('client_id'),
      redirect_uri: field('redirect_uri'),
      scope: field('scope'),
      state: field('state'),
      nonce: field('nonce'),
      code_challenge: field('code_challenge'),
      decision: 'allow',
    }).toString(),
  });

  return { response, consented: true };
}

/**
 * Forget a previous consent, so a test behaves the same on every run.
 *
 * Consent is asked once and then remembered. A test that asserts the screen
 * appears passes the first time and fails the second, which is worse than not
 * asserting it — it teaches everybody to ignore a red suite.
 */
async function clearConsent(db, userId, applicationId) {
  await db.execute(
    `UPDATE oauth_consents SET revoked_at = NOW()
      WHERE user_id = ? AND application_id = ? AND revoked_at IS NULL`,
    [userId, applicationId],
  );
}

module.exports = { authorizeAnsweringConsent, clearConsent };
