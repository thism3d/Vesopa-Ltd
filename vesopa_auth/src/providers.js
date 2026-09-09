/**
 * Google, Microsoft, Apple and GitHub — the four ways in that are somebody
 * else's problem.
 *
 * WHAT EVERY PROVIDER MUST TELL US, and the only things we ever use:
 *
 *   subject        their permanent id for this person. THE ONLY THING WE MATCH
 *                  ON. Opaque, case-sensitive, never parsed, never normalised.
 *   email          what they claim the person's address is
 *   emailVerified  whether they say they checked it
 *
 * The email is a claim, not a proof, and the difference is the whole of the
 * account-takeover story. Google with `email_verified` and Apple can be
 * believed; GitHub hands over addresses it has not verified, so its claim is
 * treated as unverified unless its own /user/emails endpoint says otherwise.
 *
 * Even a believable claim never silently links to an existing account — see
 * identity.findLinkCandidate. It offers a link; the person proves the other
 * account first.
 *
 * THREE OIDC PROVIDERS AND ONE THAT IS NOT.
 * Google, Microsoft and Apple return an ID token, and it is verified properly:
 * signature against their published keys, issuer, audience, and the nonce we
 * sent. GitHub is plain OAuth 2 with no ID token at all, so its identity comes
 * from two authenticated API calls instead.
 */

const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } = require('jose');
const fs = require('fs');

const config = require('./config');

const TIMEOUT = 12000;

/* Remote key sets are cached by `jose` itself, so one per provider, made once. */
const remoteKeys = {};
function keysFor(name, url) {
  if (!remoteKeys[name]) remoteKeys[name] = createRemoteJWKSet(new URL(url));
  return remoteKeys[name];
}

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function redirectUri(provider) {
  return `${config.issuer}/auth/${provider}/callback`;
}

async function postForm(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!response.ok) {
    const detail = data.error_description || data.error || data.raw || response.status;
    throw new Error(`${url}: ${String(detail).slice(0, 200)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

const google = {
  key: 'google',
  name: 'Google',
  kind: 'oidc',
  trustsEmail: true,

  get clientId() {
    return env('GOOGLE_CLIENT_ID');
  },
  get clientSecret() {
    return env('GOOGLE_CLIENT_SECRET');
  },
  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  },

  authorizeUrl({ state, nonce, codeChallenge }) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri('google'),
      response_type: 'code',
      // Only the three non-sensitive scopes. Anything more puts the application
      // into Google's restricted-scope review, which needs a video and a
      // security assessment — for data this system does not want.
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      // Ask for an account chooser rather than silently reusing whichever
      // Google account the browser last used; on a shared machine the silent
      // version signs the wrong person in.
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async exchange({ code, codeVerifier }) {
    return postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri('google'),
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
  },

  async profile(tokens, { nonce }) {
    const { payload } = await jwtVerify(
      tokens.id_token,
      keysFor('google', 'https://www.googleapis.com/oauth2/v3/certs'),
      { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: this.clientId },
    );
    if (nonce && payload.nonce !== nonce) throw new Error('google: nonce mismatch');

    return {
      subject: String(payload.sub),
      email: payload.email || '',
      emailVerified: payload.email_verified === true,
      name: payload.name || '',
      givenName: payload.given_name || '',
      familyName: payload.family_name || '',
      picture: payload.picture || '',
      raw: payload,
    };
  },
};

// ---------------------------------------------------------------------------
// Microsoft
// ---------------------------------------------------------------------------

const microsoft = {
  key: 'microsoft',
  name: 'Microsoft',
  kind: 'oidc',
  trustsEmail: true,

  get clientId() {
    return env('MICROSOFT_CLIENT_ID');
  },
  get clientSecret() {
    return env('MICROSOFT_CLIENT_SECRET');
  },
  get tenant() {
    return env('MICROSOFT_TENANT', 'common');
  },
  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  },

  authorizeUrl({ state, nonce, codeChallenge }) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri('microsoft'),
      response_type: 'code',
      /*
       * `User.Read` is here only so the profile photograph can be fetched:
       * Microsoft, alone among the four, does not put a picture in the ID
       * token, and keeps it behind Graph instead.
       *
       * It is the least Graph permission there is — the signed-in user's own
       * basic profile — and it is not sensitive, so the application stays out
       * of Microsoft's review track. Nothing else is requested.
       */
      /*
       * NO `offline_access`, DELIBERATELY.
       *
       * It is what puts *"Maintain access to data you have given Vesopa access
       * to"* on Microsoft's consent screen, and it buys a refresh token for
       * Microsoft Graph — a thing this server has no use for. We read the
       * profile once, at sign-in, copy the picture, and never call Graph again;
       * the session that follows is ours and has nothing to do with Microsoft.
       *
       * Asking for it anyway would be asking somebody to grant standing access
       * so that we can not use it, which is the sort of over-asking that makes
       * people abandon a consent screen — and the sort a Microsoft publisher
       * review asks you to justify.
       *
       * `User.Read` stays: it is *"Read your profile"*, and it is what lets the
       * profile picture be copied at sign-in. Microsoft does not put the photo
       * in the ID token, so without it everybody who signs in with Microsoft
       * has no avatar.
       */
      scope: 'openid email profile User.Read',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      response_mode: 'query',
    });
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/authorize?${params}`;
  },

  /**
   * Exchange the code — and cope with the registration being a PUBLIC client.
   *
   * AADSTS700025: *"Client is public so neither 'client_assertion' nor
   * 'client_secret' should be presented."* Microsoft decides whether an app
   * registration is public or confidential from where its redirect URI is
   * registered in the portal: a URI added under **Web** is confidential and
   * wants the secret, while one added under **Single-page application** or
   * **Mobile and desktop applications** makes the whole registration public and
   * REFUSES the secret. Adding the callback under the wrong heading is an easy
   * mistake — the field looks identical — and it breaks sign-in for everybody
   * with an error that names neither the platform nor the fix.
   *
   * This is the one place in the codebase that retries a failed exchange, so it
   * is worth saying why that is safe: an error response does NOT redeem the
   * authorisation code. Microsoft rejected the request before looking at the
   * code, so the code is still live and the second attempt is the first real
   * redemption. A retry after a SUCCESSFUL exchange would be a different matter
   * entirely, and nothing here does that.
   *
   * `MICROSOFT_PUBLIC_CLIENT=true` skips straight to the public form and saves
   * the wasted round trip. Without it this works either way, which is what
   * stops the same afternoon being spent on it again after somebody edits the
   * registration back.
   *
   * PKCE is sent regardless, and is what actually protects a public client —
   * it is already required by the authorize call above.
   */
  async exchange({ code, codeVerifier }) {
    const url = `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`;
    const base = {
      code,
      client_id: this.clientId,
      redirect_uri: redirectUri('microsoft'),
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    };

    if (String(env('MICROSOFT_PUBLIC_CLIENT') || '').toLowerCase() === 'true') {
      return postForm(url, base);
    }

    try {
      return await postForm(url, { ...base, client_secret: this.clientSecret });
    } catch (error) {
      if (!/AADSTS700025/.test(String(error.message || ''))) throw error;
      console.warn(
        '[social] microsoft says this registration is a PUBLIC client, so the ' +
          'secret is being dropped and PKCE is doing the work.',
      );
      try {
        return await postForm(url, base);
      } catch (second) {
        /*
         * AADSTS9002327 — THE ONE THIS CODE CANNOT FIX, so it says so loudly.
         *
         * "Tokens issued for the 'Single-Page Application' client-type may only
         * be redeemed via cross-origin requests." The callback has been added
         * in the Azure portal under **Single-page application** instead of
         * **Web**. Those two fields look identical and sit on the same screen,
         * and picking the wrong one has three consequences at once: the
         * registration becomes public (so the secret is refused — that is the
         * 700025 above), PKCE becomes mandatory, and the token endpoint will
         * ONLY answer a request carrying a browser `Origin` header.
         *
         * A server-side web application cannot send one. There is no
         * combination of secret, no-secret or PKCE that redeems an SPA-issued
         * code from a server — which is why this throws with instructions
         * instead of trying a third time.
         */
        if (/AADSTS9002327/.test(String(second.message || ''))) {
          throw new Error(
            'microsoft: the callback is registered as a Single-Page Application in ' +
              'Azure, and an SPA code can only be redeemed from a browser. Fix it in ' +
              'the portal: App registrations → your app → Authentication → remove ' +
              `${redirectUri('microsoft')} from "Single-page application", then ` +
              'Add a platform → Web → add the same URI there, and set "Allow public ' +
              'client flows" to No. Nothing in this codebase can work around it.',
          );
        }
        throw second;
      }
    }
  },

  async profile(tokens, { nonce }) {
    /*
     * The issuer is per-tenant, so with `common` it cannot be pinned to one
     * string. It is checked to be a Microsoft issuer of the expected shape
     * instead, and the audience — our own client id — is what actually binds
     * the token to us.
     */
    const { payload } = await jwtVerify(
      tokens.id_token,
      keysFor('microsoft', `https://login.microsoftonline.com/${this.tenant}/discovery/v2.0/keys`),
      { audience: this.clientId },
    );

    if (!/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]+\/v2\.0$/i.test(payload.iss || '')) {
      throw new Error('microsoft: unexpected issuer');
    }
    if (nonce && payload.nonce !== nonce) throw new Error('microsoft: nonce mismatch');

    /*
     * `sub` is PAIRWISE per application at Microsoft — the same person gets a
     * different `sub` in a different app of ours. `oid` is the stable object id
     * for the account, and combined with the tenant id it is unique across all
     * of Microsoft. Matching on `sub` alone would mean the same person could
     * never be recognised if this app id ever changed.
     */
    const subject = payload.oid && payload.tid ? `${payload.tid}:${payload.oid}` : String(payload.sub);

    return {
      subject,
      email: payload.email || payload.preferred_username || '',
      // Microsoft does not send email_verified. A work or school account's
      // address is administered and can be believed; a personal account's
      // preferred_username is the address they sign in with, which Microsoft
      // has necessarily verified.
      emailVerified: Boolean(payload.email || payload.preferred_username),
      name: payload.name || '',
      givenName: payload.given_name || '',
      familyName: payload.family_name || '',
      picture: '',
      raw: payload,
    };
  },
};

// ---------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------

const apple = {
  key: 'apple',
  name: 'Apple',
  kind: 'oidc',
  trustsEmail: true,
  /*
   * Apple posts the result back as a cross-site form POST, which is why the
   * flow's state is kept in the database and not in a cookie: a SameSite=Lax
   * cookie is NOT sent on a cross-site POST, so a cookie-based implementation
   * works everywhere else and fails only here.
   */
  callbackMethod: 'post',

  get clientId() {
    return env('APPLE_SERVICE_ID', 'com.vesopa.auth');
  },
  get teamId() {
    return env('APPLE_TEAM_ID');
  },
  get keyId() {
    return env('APPLE_KEY_ID');
  },
  get privateKeyPath() {
    return env('APPLE_PRIVATE_KEY_PATH');
  },
  get configured() {
    return Boolean(
      this.clientId && this.teamId && this.keyId &&
      this.privateKeyPath && fs.existsSync(this.privateKeyPath),
    );
  },

  authorizeUrl({ state, nonce }) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri('apple'),
      response_type: 'code id_token',
      scope: 'name email',
      state,
      nonce,
      // Apple REQUIRES form_post whenever the scope asks for name or email.
      // With response_mode=query it refuses the request outright.
      response_mode: 'form_post',
    });
    return `https://appleid.apple.com/auth/authorize?${params}`;
  },

  /**
   * Apple's "client secret" is a JWT we sign ourselves with the .p8 key, and it
   * expires — six months at most. Minting it per request rather than storing it
   * means it can never be the stale credential that breaks sign-in one morning
   * for no reason anybody can find.
   */
  async clientAssertion() {
    const pem = fs.readFileSync(this.privateKeyPath, 'utf8');
    const key = await importPKCS8(pem, 'ES256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .setIssuer(this.teamId)
      .setIssuedAt()
      .setExpirationTime('10m')
      .setAudience('https://appleid.apple.com')
      .setSubject(this.clientId)
      .sign(key);
  },

  async exchange({ code }) {
    return postForm('https://appleid.apple.com/auth/token', {
      code,
      client_id: this.clientId,
      client_secret: await this.clientAssertion(),
      redirect_uri: redirectUri('apple'),
      grant_type: 'authorization_code',
    });
  },

  async profile(tokens, { nonce, callbackBody }) {
    const { payload } = await jwtVerify(
      tokens.id_token,
      keysFor('apple', 'https://appleid.apple.com/auth/keys'),
      { issuer: 'https://appleid.apple.com', audience: this.clientId },
    );
    if (nonce && payload.nonce !== nonce) throw new Error('apple: nonce mismatch');

    /*
     * Apple sends the person's NAME EXACTLY ONCE, in the first callback body,
     * and never again. Miss it and the only way to get it is for the person to
     * revoke the app in their Apple settings and start over. So it is read from
     * the callback rather than from the token, where it does not appear.
     */
    let name = '';
    let givenName = '';
    let familyName = '';
    if (callbackBody && callbackBody.user) {
      try {
        const parsed = JSON.parse(callbackBody.user);
        givenName = (parsed.name && parsed.name.firstName) || '';
        familyName = (parsed.name && parsed.name.lastName) || '';
        name = [givenName, familyName].filter(Boolean).join(' ');
      } catch {
        /* Apple sent something unexpected; a missing name is not fatal. */
      }
    }

    return {
      subject: String(payload.sub),
      email: payload.email || '',
      // Apple verifies every address it hands over, relay addresses included.
      emailVerified: payload.email_verified === true || payload.email_verified === 'true' || Boolean(payload.email),
      isPrivateRelay: payload.is_private_email === true || payload.is_private_email === 'true',
      name,
      givenName,
      familyName,
      picture: '',
      raw: payload,
    };
  },
};

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const github = {
  key: 'github',
  name: 'GitHub',
  kind: 'oauth2',
  // NOT trusted by default. GitHub will hand over an address the person has
  // never confirmed, so the /user/emails call below is what earns the trust.
  trustsEmail: false,

  get clientId() {
    return env('GITHUB_CLIENT_ID');
  },
  get clientSecret() {
    return env('GITHUB_CLIENT_SECRET');
  },
  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  },

  authorizeUrl({ state }) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri('github'),
      scope: 'read:user user:email',
      state,
      allow_signup: 'true',
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },

  async exchange({ code }) {
    // GitHub has no PKCE. `state` is the whole CSRF defence here, which is why
    // it is 256 bits, single-use and stored server-side.
    return postForm('https://github.com/login/oauth/access_token', {
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri('github'),
    });
  },

  async profile(tokens) {
    const headers = {
      authorization: `Bearer ${tokens.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'Vesopa-OAuth',
    };

    const user = await (
      await fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(TIMEOUT) })
    ).json();

    /*
     * The second call is the point. `user.email` is whatever the person put on
     * their public profile — it can be anything, and GitHub does not check it.
     * /user/emails returns the addresses they have actually confirmed, and only
     * one marked both primary and verified is worth anything.
     */
    let email = '';
    let emailVerified = false;
    try {
      const addresses = await (
        await fetch('https://api.github.com/user/emails', {
          headers,
          signal: AbortSignal.timeout(TIMEOUT),
        })
      ).json();
      if (Array.isArray(addresses)) {
        const best =
          addresses.find((row) => row.primary && row.verified) ||
          addresses.find((row) => row.verified);
        if (best) {
          email = best.email;
          emailVerified = true;
        }
      }
    } catch {
      /* Without the address list, the profile email stays unverified. */
    }

    if (!email && user.email) email = user.email;

    return {
      subject: String(user.id),
      email,
      emailVerified,
      name: user.name || user.login || '',
      givenName: '',
      familyName: '',
      picture: user.avatar_url || '',
      raw: { login: user.login, id: user.id },
    };
  },
};

const providers = { google, microsoft, apple, github };

/** Only the ones that have their credentials, in the order they are shown. */
function enabled() {
  return ['google', 'apple', 'microsoft', 'github']
    .map((key) => providers[key])
    .filter((provider) => provider.configured);
}

function get(key) {
  return providers[key] || null;
}

/** A PKCE pair for the trip out to the provider. */
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

module.exports = { providers, enabled, get, pkce, redirectUri };
