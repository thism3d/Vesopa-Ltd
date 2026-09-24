/**
 * Check the social sign-in wiring, including against the real providers.
 *
 *     node scripts/smoke-social.js
 *
 * WHAT CAN BE TESTED WITHOUT A HUMAN, AND WHAT CANNOT
 *
 * Nobody can automate clicking "Allow" in a Google consent screen, so the
 * inbound half — the callback with a real authorisation code — needs a person.
 * Everything up to that point can be checked, and that is where the failures
 * actually are:
 *
 *   * the request we build (client id, redirect, PKCE, nonce, scopes)
 *   * the state row: created, single use, expiring
 *   * AND — the useful part — whether the PROVIDER agrees the application is
 *     registered and the redirect URI is one of ours.
 *
 * That last one is the test worth having. `redirect_uri_mismatch` and
 * "application not found" are the two ways social sign-in fails in practice,
 * they fail for every user at once, and they are invisible until somebody tries
 * it. Asking Google and Microsoft directly catches both before a customer does.
 */

const db = require('../src/db');
const providers = require('../src/providers');

const BASE = 'https://auth.vesopa.com';

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

function skip(label, why) {
  console.log(`  – ${label} — ${why}`);
  skipped += 1;
}

async function main() {
  // -----------------------------------------------------------------------
  console.log('▶ what is configured on this server');
  const on = providers.enabled().map((p) => p.key);
  console.log(`  configured: ${on.join(', ') || 'none'}`);
  check('at least Google is configured', on.includes('google'), 'Google credentials missing');

  // -----------------------------------------------------------------------
  console.log('▶ the authorization request we build');

  for (const key of ['google', 'microsoft', 'apple', 'github']) {
    const provider = providers.get(key);
    const url = new URL(
      provider.authorizeUrl({ state: 'STATE', nonce: 'NONCE', codeChallenge: 'CHALLENGE' }),
    );
    const params = url.searchParams;

    check(
      `${key}: redirect_uri points at this server`,
      params.get('redirect_uri') === `${BASE}/auth/${key}/callback`,
      params.get('redirect_uri'),
    );
    check(`${key}: state is sent`, params.get('state') === 'STATE');

    if (key === 'github') {
      // GitHub has no PKCE and no nonce. `state` is the entire CSRF defence,
      // which is why it is 256 bits and single-use.
      skip('github: PKCE', 'GitHub does not support it');
    } else {
      check(`${key}: nonce is sent`, params.get('nonce') === 'NONCE');
    }

    if (key === 'google' || key === 'microsoft') {
      check(`${key}: PKCE S256`, params.get('code_challenge_method') === 'S256');
      check(
        `${key}: only non-sensitive scopes`,
        !/drive|gmail|calendar|contacts|Mail\.|Files\./i.test(params.get('scope') || ''),
        params.get('scope'),
      );
    }
    if (key === 'apple') {
      // Apple REFUSES the request outright unless response_mode is form_post
      // whenever name or email is asked for.
      check('apple: response_mode=form_post', params.get('response_mode') === 'form_post');
    }
  }

  // -----------------------------------------------------------------------
  console.log('▶ starting a flow on this server');

  const start = await fetch(`${BASE}/auth/google`, { redirect: 'manual' });
  check('GET /auth/google redirects', start.status === 303, `status ${start.status}`);
  const target = new URL(start.headers.get('location'));
  check('to Google', target.hostname === 'accounts.google.com', target.hostname);

  const state = target.searchParams.get('state');
  const row = await db.one('SELECT * FROM oauth_states WHERE state = ?', [state]);
  check('the state was recorded', Boolean(row));
  check('with a PKCE verifier kept server-side', Boolean(row && row.code_verifier));
  check('and an expiry', Boolean(row && row.expires_at));
  check('as a login, not a link', row && row.intent === 'login', row && row.intent);

  // A state must work once. The callback claims it with a conditional UPDATE,
  // so a replay finds nothing to claim.
  const claimOnce = await db.execute(
    'UPDATE oauth_states SET consumed_at = NOW() WHERE state = ? AND consumed_at IS NULL',
    [state],
  );
  const claimTwice = await db.execute(
    'UPDATE oauth_states SET consumed_at = NOW() WHERE state = ? AND consumed_at IS NULL',
    [state],
  );
  check('state can be claimed once', claimOnce.affectedRows === 1);
  check('and not twice', claimTwice.affectedRows === 0);

  const replay = await fetch(`${BASE}/auth/google/callback?state=${state}&code=whatever`, {
    redirect: 'manual',
  });
  check('a spent state is refused at the callback', replay.status === 400, `status ${replay.status}`);

  const unknown = await fetch(`${BASE}/auth/google/callback?state=made-up&code=x`, {
    redirect: 'manual',
  });
  check('an unknown state is refused', unknown.status === 400, `status ${unknown.status}`);

  const cancelled = await fetch(`${BASE}/auth/google/callback?error=access_denied`, {
    redirect: 'manual',
  });
  check(
    'pressing cancel at the provider just returns to sign-in',
    cancelled.status === 303 && cancelled.headers.get('location') === '/login',
    `${cancelled.status} ${cancelled.headers.get('location')}`,
  );

  for (const key of ['microsoft', 'github']) {
    if (providers.get(key).configured) {
      skip(`${key}: unconfigured behaviour`, 'it IS configured');
      continue;
    }
    const response = await fetch(`${BASE}/auth/${key}`, { redirect: 'manual' });
    check(
      `${key} without a secret says so rather than failing oddly`,
      response.status === 503,
      `status ${response.status}`,
    );
  }

  // -----------------------------------------------------------------------
  console.log('▶ do the providers agree we are registered?');

  await checkGoogleRegistration();
  await checkMicrosoftRegistration();
  await checkGitHubRegistration();

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  await db.close();
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Ask Google whether our client id and redirect URI are real.
 *
 * `prompt=none` means "do not show anybody anything". Google answers with a
 * redirect carrying an error — `login_required`, because nobody is signed in —
 * when the application is fine, and with an HTML error page when it is not.
 * So a redirect back to OUR address is the pass.
 */
async function checkGoogleRegistration() {
  const provider = providers.get('google');
  if (!provider.configured) {
    skip('google: registration', 'not configured');
    return;
  }

  /*
   * A REAL PKCE challenge, not a placeholder.
   *
   * Google validates the shape of `code_challenge` before it validates anything
   * else, so a made-up value produces "Code Challenge must be base64url" and
   * the probe learns nothing about the registration — which is what it is for.
   * The first run of this test did exactly that and reported a failure that was
   * entirely the test's own.
   */
  const { challenge } = providers.pkce();
  const url = new URL(
    provider.authorizeUrl({ state: 'probe', nonce: 'probe', codeChallenge: challenge }),
  );
  url.searchParams.set('prompt', 'none');

  const { location, body, status } = await probe(url);
  const all = `${location} ${body}`;

  check(
    'google: the client id is recognised',
    !/invalid_client|deleted_client|OAuth client was not found/i.test(all),
    'Google says the client does not exist',
  );
  check(
    'google: the redirect URI is registered',
    !/redirect_uri_mismatch/i.test(all),
    'Google says redirect_uri_mismatch — add https://auth.vesopa.com/auth/google/callback in the Cloud Console',
  );
  /*
   * The positive assertion. `prompt=none` with nobody signed in should come
   * back to OUR callback carrying an error — which proves Google accepted the
   * client, the redirect and the request, and was willing to send a browser to
   * us. Anything else is reported with what Google actually said, rather than
   * being quietly counted as a pass because no known error string appeared.
   */
  check(
    'google: the request is accepted and would return to us',
    location.startsWith(`${BASE}/auth/google/callback`),
    `Google answered ${status}: ${decodeAuthError(location) || location.slice(0, 160)}`,
  );
}

async function probe(url) {
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location') || '';
  const body = response.status === 200 ? (await response.text()).slice(0, 4000) : '';
  return { location, body, status: response.status };
}

/** Google hides the reason in a base64 blob on its error page. Read it. */
function decodeAuthError(location) {
  const match = /authError=([^&]+)/.exec(location || '');
  if (!match) return '';
  try {
    return Buffer.from(decodeURIComponent(match[1]), 'base64')
      .toString('utf8')
      .replace(/[^\x20-\x7e]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * The same question to Microsoft, and it can be asked WITHOUT the client
 * secret — which is the point, because the secret is what we are missing.
 *
 * Microsoft's errors are unusually good: AADSTS700016 means the application is
 * not registered in that tenant, AADSTS50011 means the redirect URI is not on
 * its list. Both are exactly the failures that would otherwise be discovered by
 * a user.
 */
async function checkMicrosoftRegistration() {
  const provider = providers.get('microsoft');
  if (!provider.clientId) {
    skip('microsoft: registration', 'no client id');
    return;
  }

  const { challenge } = providers.pkce();
  const url = new URL(
    provider.authorizeUrl({ state: 'probe', nonce: 'probe', codeChallenge: challenge }),
  );
  url.searchParams.set('prompt', 'none');

  const { location, body, status } = await probe(url);
  const all = `${location} ${body}`;

  const aadsts = /AADSTS\d+/.exec(all);

  check(
    'microsoft: the application is registered',
    !/AADSTS700016|AADSTS900023|unauthorized_client/i.test(all),
    'Microsoft says the application was not found in the directory',
  );
  check(
    'microsoft: the redirect URI is registered',
    !/AADSTS50011/i.test(all),
    'Microsoft says AADSTS50011 — add https://auth.vesopa.com/auth/microsoft/callback as a Web redirect URI in the app registration',
  );
  /*
   * As with Google, assert what SHOULD have happened rather than only the
   * absence of two known error strings.
   *
   * Microsoft answers this one differently from Google, and the difference is
   * not a fault. On the `common` endpoint it does NOT send an HTTP redirect: it
   * returns a page titled "Redirecting" that hands the browser on to
   * login.live.com — because this application accepts personal Microsoft
   * accounts as well as work ones. So the pass condition is either shape:
   *
   *   an HTTP redirect back to our callback, OR
   *   a hand-off page carrying our client id and our redirect URI,
   *
   * with no AADSTS error code either way. Requiring only the first read as a
   * failure when the integration was in fact working.
   */
  const handedOff =
    /login\.live\.com|login\.microsoftonline\.com\/common/.test(body) &&
    body.includes(provider.clientId) &&
    /auth\.vesopa\.com(%2f|\/)auth/i.test(body);

  check(
    'microsoft: the request is accepted and would return to us',
    location.startsWith(`${BASE}/auth/microsoft/callback`) || handedOff,
    `Microsoft answered ${status}${aadsts ? ` (${aadsts[0]})` : ''}: ${location.slice(0, 160) || 'an HTML page that did not name our client'}`,
  );

  if (!provider.configured) {
    console.log('    note: MICROSOFT_CLIENT_SECRET is not set, so the token exchange');
    console.log('    cannot be completed and the button stays hidden. Everything else');
    console.log('    about the Microsoft integration is checked above.');
    return;
  }

  /*
   * PROVE THE CLIENT SECRET ITSELF, without a person.
   *
   * A user sign-in cannot be automated, but the secret can still be checked:
   * ask Microsoft for a client-credentials token. Microsoft validates the
   * client id and secret BEFORE it considers anything else, so its answer
   * separates the two failures we care about:
   *
   *   AADSTS7000215  the secret is wrong — the one thing we are testing
   *   AADSTS700016   the application does not exist
   *   anything else  the credential was accepted, and the complaint is about
   *                  permissions or the resource, which do not matter here
   *
   * Without this, a mistyped or wrong-application secret would sit undiscovered
   * until the first real person clicked "Continue with Microsoft".
   */
  const tenant = 'eef68809-c708-46fa-bf22-8eab9cd3952b';
  const response = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
    },
  );
  const result = await response.json();
  const code = (/AADSTS\d+/.exec(result.error_description || '') || [])[0] || '';

  check(
    'microsoft: the client secret is accepted',
    code !== 'AADSTS7000215',
    'Microsoft says AADSTS7000215 — the secret is wrong, or belongs to a different application',
  );
  check(
    'microsoft: the secret belongs to this application',
    code !== 'AADSTS700016' && code !== 'AADSTS900023',
    `Microsoft says ${code} — this secret is not for client ${provider.clientId}`,
  );
  if (response.ok) {
    console.log('    Microsoft issued a token: the credential is fully working.');
  } else if (code && code !== 'AADSTS7000215' && code !== 'AADSTS700016') {
    console.log(`    Microsoft accepted the credential (${code} is about permissions, not the secret).`);
  }

  /*
   * IS THE CALLBACK REGISTERED UNDER THE RIGHT PLATFORM?
   *
   * This is the check that was missing, and its absence cost a live sign-in
   * failure that looked exactly like a bad secret. Adding the redirect URI in
   * the Azure portal under **Single-page application** instead of **Web** makes
   * the whole registration public: the secret is then refused (AADSTS700025)
   * and — worse, because it cannot be worked around — an authorisation code can
   * only be redeemed from a browser (AADSTS9002327). A server-side application
   * can never do that.
   *
   * It can be detected with no user and no real code, because Microsoft
   * validates the CLIENT before it looks at the code: send a deliberately junk
   * code with the secret attached, and a public registration answers
   * AADSTS700025 whatever the code was. A correctly registered Web application
   * complains about the code instead, which is the answer we want.
   */
  /*
   * Named `platformProbe`, not `probe`.
   *
   * `probe()` is already a function in this file, and `const probe = …` inside
   * the same scope shadows it — the declaration hoists into the temporal dead
   * zone, so the CALL to probe() thirty lines earlier throws "Cannot access
   * 'probe' before initialization". The whole check crashed before it reached
   * anything it was meant to test.
   */
  const platformProbe = await fetch(
    `https://login.microsoftonline.com/${provider.tenant || 'common'}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        redirect_uri: `${BASE}/auth/microsoft/callback`,
        grant_type: 'authorization_code',
        code: 'not-a-real-code-this-is-a-platform-probe',
        code_verifier: 'x'.repeat(43),
      }).toString(),
    },
  );
  const probeBody = await platformProbe.json().catch(() => ({}));
  const probeCode = (/AADSTS\d+/.exec(probeBody.error_description || '') || [])[0] || '';

  check(
    'microsoft: the callback is registered as a Web platform, not an SPA',
    probeCode !== 'AADSTS700025',
    'Microsoft says AADSTS700025 — this registration is PUBLIC, which means the ' +
      'callback was added under "Single-page application" (or "Mobile and desktop"). ' +
      'A server-side app cannot redeem an SPA code at all. Fix it in the portal: ' +
      'Authentication → remove the URI from "Single-page application" → Add a ' +
      'platform → Web → add it there → set "Allow public client flows" to No.',
  );
  if (probeCode && probeCode !== 'AADSTS700025') {
    console.log(`    Platform looks right: Microsoft objected to the code (${probeCode}), not the client.`);
  }
}

/**
 * Ask GitHub whether it knows this application.
 *
 * GitHub's answer to a good request is a 302 to its own sign-in page carrying
 * our client id and, inside `return_to`, our redirect URI. An unknown client or
 * an unregistered callback gets an HTML error page instead, so the shape of the
 * response is the whole answer.
 *
 * Worth noting how this check was got wrong the first time: it searched the
 * response for the string "redirect_uri" and treated a hit as a mismatch — but
 * that string appears in the perfectly normal `return_to`, so a working
 * integration reported itself broken. Match on the SHAPE of the answer, not on
 * a word that appears in both.
 */
async function checkGitHubRegistration() {
  const provider = providers.get('github');
  if (!provider.clientId) {
    skip('github: registration', 'no client id');
    return;
  }

  const url = new URL(provider.authorizeUrl({ state: 'probe' }));
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location') || '';
  const body = response.status === 200 ? (await response.text()).slice(0, 4000) : '';

  check(
    'github: the client id is recognised',
    !/Application not found|The application you are trying/i.test(body),
    'GitHub does not know this application',
  );
  check(
    'github: the redirect URI is registered',
    !/redirect_uri is not associated|redirect_uri MUST match/i.test(body),
    'GitHub says the callback URL is not the one registered on the app',
  );
  /*
   * The callback is percent-encoded TWICE in that URL — once as a parameter of
   * /login/oauth/authorize, and again because that whole URL is itself the
   * `return_to` parameter of /login. One decode leaves `%3A%2F%2F` and the
   * check fails on a working integration, which is what it did first time.
   */
  let decoded = location;
  for (let i = 0; i < 3 && decoded.includes('%'); i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }

  check(
    'github: the request is accepted and would return to us',
    /^https:\/\/github\.com\/(login|session)/.test(location) &&
      location.includes(provider.clientId) &&
      decoded.includes(`${BASE}/auth/github/callback`),
    `GitHub answered ${response.status}: ${location.slice(0, 140) || 'an HTML page'}`,
  );
}

main().catch(async (error) => {
  console.error('social smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
