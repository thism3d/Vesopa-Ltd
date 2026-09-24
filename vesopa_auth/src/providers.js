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

/**
 * Which shape of token request Microsoft accepted last time.
 *
 * Module state rather than a setting, because it is a fact discovered at run
 * time about somebody else's configuration, and it must follow that
 * configuration when it changes rather than outlive it. A restart forgets it,
 * which is correct: a restart is also when the portal was probably edited.
 */
let microsoftTokenMode = '';

function redirectUri(provider) {
  return `${config.issuer}/auth/${provider}/callback`;
}

async function postForm(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...extraHeaders,
    },
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
   * Exchange the code, whatever the registration turns out to be.
   *
   * Microsoft decides whether an app registration is public or confidential
   * from WHERE its redirect URI sits in the portal, and the three places look
   * identical on the screen:
   *
   *   **Web**                          confidential — send the client secret
   *   **Mobile and desktop**           public — the secret is REFUSED
   *   **Single-page application**      public, and cross-origin only
   *
   * Picking the wrong heading breaks sign-in for everybody, with an error
   * (`AADSTS700025`, then `AADSTS9002327`) that names neither the platform nor
   * the fix. So this walks the three, remembers which one answered, and says
   * what to change if none of them do.
   *
   * WHY RETRYING IS SAFE HERE, and only here. An error response does not
   * redeem the authorisation code — Microsoft refuses the request before it
   * looks at the code — so the code is still live and the next attempt is the
   * first real redemption. That is true for the four `AADSTS` codes listed
   * below and is not assumed of anything else: any other failure is thrown
   * immediately rather than retried.
   *
   * PKCE is sent in all three and is what actually protects a public client.
   * `MICROSOFT_TOKEN_MODE=confidential|public|spa` pins one, and
   * `MICROSOFT_PUBLIC_CLIENT=true` skips the secret, for an install that would
   * rather not spend a request discovering it.
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

    /*
     * THREE WAYS TO REDEEM A MICROSOFT CODE, and which one works is decided by
     * a radio button in the Azure portal that nobody here can see.
     *
     *   confidential  the secret is sent. What a "Web" platform wants.
     *   public        no secret; PKCE alone. What a public registration wants.
     *   spa           no secret, plus an `Origin` header.
     *
     * The third is the one this file used to say was impossible, and the note
     * saying so was wrong. A callback added under **Single-page application**
     * makes Microsoft answer the token endpoint only for a CROSS-ORIGIN
     * request — and the way it decides a request is cross-origin is the
     * `Origin` header. `Origin` is a header. A server can send one, and this
     * one sends its own issuer, which is the origin that Microsoft has
     * registered against the SPA platform. Microsoft answers, and returns the
     * CORS headers a browser would have needed and nothing here reads.
     *
     * It is not a trick played on the security model: PKCE is what protects a
     * public client, PKCE is sent in every one of the three, and the verifier
     * never left this server. What the SPA registration removes is the client
     * secret, and dropping the secret is exactly what the second attempt
     * already did.
     *
     * The right answer is still to move the URI to **Web** in the portal, and
     * the error below still says how. This is so that a person signing in
     * today does not have to wait for somebody to do it.
     */
    const attempts = [];
    const forced = String(env('MICROSOFT_TOKEN_MODE') || '').toLowerCase();
    const publicOnly = String(env('MICROSOFT_PUBLIC_CLIENT') || '').toLowerCase() === 'true';

    const ladder = {
      confidential: () => postForm(url, { ...base, client_secret: this.clientSecret }),
      public: () => postForm(url, base),
      spa: () => postForm(url, base, { origin: config.issuer }),
    };

    /*
     * What worked last time is tried first.
     *
     * Without this every single Microsoft sign-in on a misconfigured
     * registration pays for two refused round trips to Microsoft before the
     * one that works — about a second of somebody staring at a blank tab, on
     * every sign-in, for ever. The value is only ever set from a SUCCESSFUL
     * exchange, so a wrong guess costs one request and corrects itself.
     */
    const order = forced && ladder[forced]
      ? [forced]
      : microsoftTokenMode
        ? [microsoftTokenMode, 'confidential', 'public', 'spa']
        : publicOnly
          ? ['public', 'spa']
          : ['confidential', 'public', 'spa'];

    const tried = new Set();
    let last = null;

    for (const mode of order) {
      if (tried.has(mode)) continue;
      tried.add(mode);
      try {
        // eslint-disable-next-line no-await-in-loop -- a ladder, by definition
        const tokens = await ladder[mode]();
        if (microsoftTokenMode !== mode) {
          console.log(`[social] microsoft token endpoint answers in "${mode}" mode; remembering that.`);
          microsoftTokenMode = mode;
        }
        return tokens;
      } catch (error) {
        last = error;
        attempts.push(`${mode}: ${String(error.message || '').slice(0, 120)}`);
        /*
         * Only the two errors that mean "wrong shape of request" are worth
         * another attempt. A wrong code, an expired code or a network failure
         * is the same answer in all three modes, and retrying it twice turns
         * one failure into three requests and three log lines.
         *
         * A retry is safe for exactly these: Microsoft refused the request
         * before looking at the code, so the code has NOT been redeemed and
         * the next attempt is the first real redemption.
         */
        if (!/AADSTS700025|AADSTS9002327|AADSTS7000215|AADSTS700009/.test(String(error.message || ''))) {
          throw error;
        }
      }
    }

    /*
     * All three refused. Say what was tried and what to change, because the
     * fix is in a portal on somebody else's screen and the error Microsoft
     * gives names neither the platform nor the field.
     */
    throw new Error(
      `microsoft: the token endpoint refused every form of this exchange (${attempts.join(' | ')}). ` +
        'This is almost always the platform the callback is registered under. In the Azure portal: ' +
        `App registrations → your app → Authentication → put ${redirectUri('microsoft')} under ` +
        '"Web" (not "Single-page application" and not "Mobile and desktop applications"), and set ' +
        `"Allow public client flows" to No. Original error: ${String(last && last.message).slice(0, 200)}`,
    );
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
  /*
   * TRUSTED, because `profile()` below only ever reports `emailVerified: true`
   * for an address GitHub itself has confirmed.
   *
   * This said `false` and it cost somebody an account. `trustsEmail` is ANDed
   * with the per-sign-in `emailVerified` at both call sites, so `false` here
   * meant a GitHub address was thrown away even when /user/emails had said
   * `"verified": true` about it — which is the same evidence Google and
   * Microsoft give, and better evidence than Microsoft's, where it is inferred
   * from the presence of a `preferred_username`.
   *
   * The consequence was two accounts for one person: signing in with GitHub
   * made an account, and typing the very same address on the sign-in page made
   * a second one, because the first had no email identity to match against.
   *
   * The caution the `false` was expressing is real and is kept — it just
   * belongs in `profile()`, where the public profile address (which GitHub does
   * not check, and which can be anything) is reported with
   * `emailVerified: false` and is therefore still worth nothing here.
   */
  trustsEmail: true,

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
