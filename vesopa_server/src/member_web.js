/**
 * The members' site, drawn on the server.
 *
 * WHY (owner, 2026-10-11): "for the web app can we use node application not
 * the flutter one and zero loading". The Flutter web build is a couple of
 * megabytes that has to arrive and start before a member sees their card, so
 * every visit opened on a splash. These are plain pages: the card is in the
 * first response, there is nothing to wait for and nothing to start, and they
 * work with JavaScript switched off.
 *
 * SWITCHED ON PER VENUE, by `web: 'node'` on the venue's look
 * (src/venue_looks.js). Every other venue is served the Flutter build exactly
 * as before; a venue with this on still has that build at <its address>/app/,
 * as a fallback.
 *
 * NO SECOND COPY OF ANYTHING. Every page asks the loyalty API the very same
 * questions the Flutter app asks -- /loyalty/v1/app/<slug>, /loyalty/v1/me,
 * /me/history, /me/membership and the rest -- answered by the same handlers,
 * in this process, with no network in between (callApi below). Signing in,
 * joining, the members-only gate, rate limits, revocation: all of it is the
 * API's and stays there. This file only turns answers into HTML and forms into
 * questions.
 *
 * THE SESSION is the token the API mints for any sign-in, kept in an HttpOnly,
 * Secure, SameSite=Lax cookie, one per venue. Signing out revokes it at the
 * API exactly as the app's button does. Every form carries a token tied to a
 * second cookie (signed double submit), and a cross-site Origin is refused.
 *
 * CONTINUE WITH VESOPA (Apple, Google, a passkey or the phone at
 * auth.vesopa.com) is the same OAuth round trip as the Flutter web app's
 * (lib/platform/vesopa_sso_web.dart): the same client, the same
 * /app/vesopa/callback, the state "<slug>.<nonce>", PKCE. The verifier is kept
 * in a short-lived HttpOnly cookie instead of sessionStorage, and the code is
 * swapped by /loyalty/v1/app/<slug>/vesopa as before.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const express = require('express');

const venueLooks = require('./venue_looks');
const idtoken = require('./vesopa_idtoken');
const { appPath, NOT_FOUND } = require('./loyalty_host');
const views = require('./member_web_views');

const YEAR = 365 * 24 * 3600;
const CSRF_COOKIE = '__Host-member_csrf';
const SSO_COOKIE = '__Host-member_sso';
const sessionCookie = (slug) => `__Host-member_${slug}`;
const paymentCookie = (slug) => `__Host-member_pay_${slug}`;

const rand = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const emailOk = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || ''));

// ---------------------------------------------------------------------------
// Asking the API, in this process
// ---------------------------------------------------------------------------

/**
 * What a route answered, kept instead of sent.
 *
 * Just enough of a response for the API's handlers and the middleware in
 * front of them (cors, the activity log) to run unchanged: headers, a status,
 * json/send/end, and 'finish' when it is done.
 */
class Answer extends EventEmitter {
  constructor(resolve) {
    super();
    this.statusCode = 200;
    this.locals = {};
    this.headersSent = false;
    this.finished = false;
    this.headers = {};
    this.resolve = resolve;
  }

  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; }
  getHeader(k) { return this.headers[String(k).toLowerCase()]; }
  getHeaders() { return { ...this.headers }; }
  hasHeader(k) { return String(k).toLowerCase() in this.headers; }
  removeHeader(k) { delete this.headers[String(k).toLowerCase()]; }

  set(k, v) {
    if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) this.setHeader(a, b);
    else this.setHeader(k, v);
    return this;
  }

  header(k, v) { return this.set(k, v); }
  get(k) { return this.getHeader(k); }
  append(k, v) { return this.setHeader(k, [].concat(this.getHeader(k) || [], v)); }
  vary() { return this; }
  type(t) { return this.setHeader('content-type', t); }
  status(code) { this.statusCode = Number(code); return this; }
  sendStatus(code) { return this.status(code).end(); }
  writeHead(code, headers) { this.statusCode = Number(code); if (headers && typeof headers === 'object') this.set(headers); return this; }
  write() { return true; }
  cookie() { return this; }
  clearCookie() { return this; }

  // A round trip through JSON, so a page reads exactly what the app is sent:
  // dates as strings, not Date objects.
  json(body) { return this.finish(body === undefined ? null : JSON.parse(JSON.stringify(body))); }

  send(body) {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return this.json(body);
    return this.finish(body ?? null);
  }

  end(body) { return this.finish(body ?? null); }

  redirect(a, b) {
    const [code, to] = typeof a === 'number' ? [a, b] : [302, a];
    this.status(code).setHeader('location', to);
    return this.finish(null);
  }

  finish(body) {
    if (this.finished) return this;
    this.finished = true;
    this.headersSent = true;
    this.body = body;
    this.resolve({ status: this.statusCode, body: body && typeof body === 'object' ? body : { text: body }, headers: this.headers });
    this.emit('finish');
    return this;
  }
}

/**
 * One question to the API, through the server's own routing, as the app would
 * have asked it over the network: the member's host (a passkey belongs to it),
 * their address (rate limits count it), their browser, their token.
 */
function callApi(req, method, url, { token, body } = {}) {
  return new Promise((resolve) => {
    const inner = Object.create(req.app.request);
    const headers = { host: req.headers.host || '', accept: 'application/json' };
    for (const h of ['user-agent', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip']) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    if (token) headers.authorization = `Bearer ${token}`;
    Object.assign(inner, {
      method, url, originalUrl: url, headers, body: body || {},
      socket: req.socket, connection: req.socket,
    });
    const res = new Answer(resolve);
    res.req = inner;
    inner.res = res;
    const done = (err) => {
      if (res.finished) return;
      if (err) {
        console.warn('[member_web] %s %s failed: %s', method, url.split('?')[0], err.message);
        res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Something went wrong. Please try again.' });
      } else {
        res.status(404).json({ error: 'Not found.' });
      }
    };
    try {
      req.app.router.handle(inner, res, done);
    } catch (e) {
      done(e);
    }
  });
}

/**
 * The one upload: the member's photograph is multipart, read off the
 * request's own stream by the API's handler, so it is the real request that
 * goes, readdressed, and is put back afterwards.
 */
function forwardUpload(req, url, token) {
  return new Promise((resolve) => {
    const saved = {
      url: req.url, baseUrl: req.baseUrl, params: req.params, next: req.next, route: req.route,
      authorization: req.headers.authorization,
    };
    const res = new Answer((answer) => {
      Object.assign(req, { url: saved.url, baseUrl: saved.baseUrl, params: saved.params, next: saved.next, route: saved.route });
      if (saved.authorization === undefined) delete req.headers.authorization;
      else req.headers.authorization = saved.authorization;
      resolve(answer);
    });
    req.url = url;
    req.headers.authorization = `Bearer ${token}`;
    req.app.router.handle(req, res, (err) => {
      if (res.finished) return;
      res.status(err ? err.status || 500 : 404).json({ error: err ? 'That photograph could not be used.' : 'Not found.' });
    });
  });
}

const ok = (answer) => answer.status >= 200 && answer.status < 300;
const said = (answer, fallback = 'That did not work. Please try again.') =>
  (answer && answer.body && typeof answer.body.error === 'string' && answer.body.error) || fallback;

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // A cookie that will not decode is not one of ours.
    }
  }
  return out;
}

/*
 * __Host- names: Secure, Path=/ and no Domain, so nothing on another
 * subdomain can plant one. Browsers allow Secure cookies on http://localhost,
 * which is where this is ever run without TLS.
 */
function setCookie(res, name, value, maxAge) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];
  res.append('Set-Cookie', parts.join('; '));
}

const clearCookie = (res, name) => setCookie(res, name, '', 0);

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/**
 * Mounted at the front of the loyalty router (loyalty_app.js), on the
 * internal /app/<slug>/ addresses the hosts are rewritten to. Anything that
 * is not a venue with `web: 'node'`, or that is a file (the manifest, icons,
 * the push worker), passes on to the routes behind as before.
 *
 * `flutterPage` is loyalty_app.js's own page, for the fallback at /app/.
 */
function memberWebRoutes({ secret, flutterPage }) {
  const outer = express.Router();
  const pages = express.Router({ mergeParams: true });

  const hmac = (value) => crypto.createHmac('sha256', String(secret)).update(`member-web:${value}`).digest('base64url');

  outer.use((req, res, next) => {
    const m = /^\/app\/([^/]+)(\/.*)?$/.exec(req.path);
    if (!m || !venueLooks.nodeWeb(m[1])) return next('router');
    const slug = m[1].toLowerCase();
    const rest = m[2];
    // /app/<slug> without its slash keeps the loyalty router's redirect.
    if (!rest) return next('router');
    // The Flutter build, kept at <address>/app/ for as long as anybody needs it.
    const fallback = /^\/app(\/.*)?$/.exec(rest);
    if (fallback) {
      const inner = fallback[1] || '/';
      if (/\.[a-z0-9]+$/i.test(inner)) {
        req.url = `/app/${slug}${inner}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
        return next('router');
      }
      if (!fallback[1]) return res.redirect(301, `${appPath(req, slug)}app/`);
      req.params = { ...req.params, slug };
      req.flutterFallback = true;
      return flutterPage(req, res, next);
    }
    if (/\.[a-z0-9]+$/i.test(rest)) return next('router');
    next();
  });
  outer.use('/app/:slug', pages);

  pages.use(express.urlencoded({ extended: false, limit: '32kb' }));
  pages.use(express.json({ limit: '32kb' }));

  // Who is asking, where the pages live, and the form token.
  pages.use((req, res, next) => {
    const slug = String(req.params.slug).toLowerCase();
    const jar = readCookies(req);
    let raw = jar[CSRF_COOKIE];
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(raw || '')) {
      raw = rand(18);
      setCookie(res, CSRF_COOKIE, raw, YEAR);
      jar[CSRF_COOKIE] = '';
    }
    req.member = {
      slug,
      base: appPath(req, slug),
      api: `/loyalty/v1/app/${encodeURIComponent(slug)}`,
      token: jar[sessionCookie(slug)] || null,
      cookies: jar,
      csrf: hmac(raw),
      csrfSent: jar[CSRF_COOKIE] ? hmac(jar[CSRF_COOKIE]) : null,
      nonce: rand(12),
      ua: String(req.headers['user-agent'] || ''),
    };
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': [
        "default-src 'self'", "img-src 'self' https: data:", "style-src 'self' 'unsafe-inline'",
        // 'strict-dynamic' lets the nonce'd page script load Firebase and
        // Google's invisible check for phone codes (owner, 2026-10-25).
        `script-src 'nonce-${req.member.nonce}' 'strict-dynamic'`,
        "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google.com https://www.gstatic.com",
        "frame-src 'self' https://www.google.com https://recaptcha.google.com https://vesopa.firebaseapp.com",
        "font-src 'self' https:",
        // The notifications worker (push-sw.js). Without this a service
        // worker falls under script-src, which only allows the nonce, and
        // Chrome refused it: "violates the Content Security Policy".
        "worker-src 'self'", "manifest-src 'self'",
        "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
      ].join('; '),
    });
    next();
  });

  /*
   * EVERY POST CARRIES THE FORM TOKEN, and none may come from another site.
   * The session cookie is SameSite=Lax already; this is the second lock.
   * The token rides in the form, in a header for the few calls made from
   * script, or in the address for the photo upload, which is multipart.
   */
  pages.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.headers.origin;
    let sameSite = true;
    if (origin) {
      try {
        sameSite = new URL(origin).host === String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      } catch {
        sameSite = false;
      }
    }
    const given = String((req.body && req.body._csrf) || req.headers['x-csrf-token'] || req.query._csrf || '');
    const expected = req.member.csrfSent;
    const match = !!expected && given.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (sameSite && match) return next();
    res.status(403);
    if (req.headers['x-csrf-token'] !== undefined || req.is('json')) return res.json({ error: 'Please reload the page and try again.' });
    return res.type('html').send(views.expired(req.member));
  });

  // ---- Small helpers that need the request -----------------------------------

  const api = (req, method, url, body) => callApi(req, method, url, { token: req.member.token, body });

  /** The venue: what it looks like and how it signs people in. Null after a 404 has been sent. */
  async function venue(req, res) {
    const answer = await callApi(req, 'GET', req.member.api);
    if (answer.status === 404) {
      res.status(404).type('html').send(NOT_FOUND);
      return null;
    }
    if (!ok(answer)) throw Object.assign(new Error(said(answer)), { status: answer.status });
    return answer.body;
  }

  function send(req, res, html, status = 200) {
    res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
  }

  function signedInAs(req, res, token) {
    setCookie(res, sessionCookie(req.member.slug), token, YEAR);
    res.redirect(303, req.member.base);
  }

  function forget(req, res) {
    clearCookie(res, sessionCookie(req.member.slug));
    req.member.token = null;
  }

  /**
   * The frame every signed-in page sits in: the venue, the unread count for
   * the bell, and whether there is a Classes tab -- the same three things the
   * app's home asks for -- plus whatever the page itself needs, all at once.
   * Null when the answer has already been sent (signed out, members only).
   */
  async function frame(req, res, calls = []) {
    if (!req.member.token) {
      res.redirect(303, req.member.base);
      return null;
    }
    const [brand, inbox, membership, ...answers] = await Promise.all([
      venue(req, res),
      api(req, 'GET', '/loyalty/v1/me/messages'),
      api(req, 'GET', '/loyalty/v1/me/membership'),
      ...calls.map(([method, url, body]) => api(req, method, url, body)),
    ]);
    if (!brand) return null;
    const all = [inbox, membership, ...answers];
    if (all.some((a) => a.status === 401)) {
      forget(req, res);
      res.redirect(303, `${req.member.base}?signed_out=1`);
      return null;
    }
    const stopped = all.find((a) => a.status === 403 && a.body && (a.body.members_only || a.body.paused));
    if (stopped) {
      send(req, res, views.notice({ m: req.member, brand, text: said(stopped), signOut: true }), 403);
      return null;
    }
    const member = membership.status === 200 ? membership.body : null;
    return {
      brand,
      member,
      unread: ok(inbox) ? Number(inbox.body.unread) || 0 : 0,
      classes: views.offersClasses(member),
      answers,
    };
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- Signed out: the sign-in page --------------------------------------------

  async function signInPage(req, res, state = {}, status = 200) {
    const brand = await venue(req, res);
    if (!brand) return;
    send(req, res, views.signIn({ m: req.member, brand, ua: req.headers['user-agent'] || '', state }), status);
  }

  pages.get('/', wrap(async (req, res) => {
    const q = req.query;
    if (q.vesopa_code || q.vesopa_error) return finishVesopa(req, res);
    if (!req.member.token) {
      return signInPage(req, res, {
        method: typeof q.with === 'string' ? q.with : null,
        note: q.signed_out ? 'You have been signed out. Please sign in again.' : null,
      });
    }
    const f = await frame(req, res, [['GET', '/loyalty/v1/me']]);
    if (!f) return;
    const [me] = f.answers;
    if (!ok(me)) return send(req, res, views.notice({ m: req.member, brand: f.brand, text: said(me), signOut: true }), me.status);
    send(req, res, views.card({ m: req.member, ...f, me: me.body, ua: req.headers['user-agent'] || '' }));
  }));

  /** The six ways in that are a form. Each answers a page or a signed-in redirect. */
  const SIGN_IN = {
    async code(req, res, b) {
      const email = String(b.email || '').trim();
      if (!emailOk(email)) return signInPage(req, res, { method: 'code_email', email, error: 'Please enter your email address.' }, 400);
      const answer = await callApi(req, 'POST', `${req.member.api}/code`, { body: { email } });
      if (!ok(answer)) return signInPage(req, res, { method: 'code_email', email, error: said(answer) }, answer.status);
      return signInPage(req, res, { method: 'code_email', stage: 'code', email, note: `We have emailed a six-digit code to ${email}.` });
    },
    async verify(req, res, b) {
      const email = String(b.email || '').trim();
      const code = String(b.code || '').trim();
      const naming = b.stage === 'name';
      const name = naming ? String(b.name || '').trim() : null;
      const again = (error, status = 400) => signInPage(req, res, { method: 'code_email', stage: naming ? 'name' : 'code', email, code, name, error }, status);
      if (!/^\d{6}$/.test(code)) return again('Enter the six-digit code from the email.');
      if (naming && !name) return again('Please tell us your name.');
      const answer = await callApi(req, 'POST', `${req.member.api}/verify`, { body: { email, code, platform: 'web', ...(name ? { name } : {}) } });
      if (answer.status === 409 && answer.body.needs_name) {
        return signInPage(req, res, { method: 'code_email', stage: 'name', email, code, note: 'Welcome! You are new here, so tell us your name to join.' });
      }
      if (!ok(answer)) return again(said(answer), answer.status);
      return signedInAs(req, res, answer.body.token);
    },
    async password(req, res, b) {
      const email = String(b.email || '').trim();
      const again = (error, status = 400) => signInPage(req, res, { method: 'password', email, error }, status);
      if (!emailOk(email)) return again('Please enter your email address.');
      if (!b.password) return again('Please enter your password.');
      const answer = await callApi(req, 'POST', `${req.member.api}/password`, { body: { email, password: String(b.password), platform: 'web' } });
      if (!ok(answer)) return again(said(answer), answer.status);
      return signedInAs(req, res, answer.body.token);
    },
    async sms(req, res, b) {
      if (b.country && b.phone) b = { ...b, phone: views.toInternational(String(b.country), String(b.phone)) || String(b.phone) };
      const phone = String(b.phone || '').trim();
      if (phone.length < 7) return signInPage(req, res, { method: 'code_sms', phone, error: 'Please enter your mobile number.' }, 400);
      const answer = await callApi(req, 'POST', `${req.member.api}/sms`, { body: { phone } });
      if (!ok(answer)) return signInPage(req, res, { method: 'code_sms', phone, error: said(answer) }, answer.status);
      // Deliberately not "we texted you": the server only texts a number it
      // already holds, and saying so would tell a stranger who is a member.
      return signInPage(req, res, { method: 'code_sms', stage: 'code', phone, note: 'If that number is on your membership, a code is on its way.' });
    },
    // A number Firebase proved in this browser (member_web_views.js
    // firebasePhone): the API checks Firebase's token itself.
    async 'sms-firebase'(req, res, b) {
      const answer = await callApi(req, 'POST', `${req.member.api}/phone/firebase`, { body: { id_token: String(b.id_token || ''), platform: 'web' } });
      if (!ok(answer)) return signInPage(req, res, { method: 'code_sms', error: said(answer) }, answer.status);
      return signedInAs(req, res, answer.body.token);
    },
    async 'sms-verify'(req, res, b) {
      const phone = String(b.phone || '').trim();
      const code = String(b.code || '').trim();
      const answer = await callApi(req, 'POST', `${req.member.api}/sms/verify`, { body: { phone, code, platform: 'web' } });
      if (!ok(answer)) return signInPage(req, res, { method: 'code_sms', stage: 'code', phone, error: said(answer) }, answer.status);
      return signedInAs(req, res, answer.body.token);
    },
    async passkey(req, res, b) {
      let proof = null;
      try {
        proof = JSON.parse(String(b.proof || ''));
      } catch {
        proof = null;
      }
      if (!proof || !proof.challenge || !proof.credential) {
        return signInPage(req, res, { error: 'That passkey could not be checked. Please try again.' }, 400);
      }
      const answer = await callApi(req, 'POST', `${req.member.api}/passkey/verify`, {
        body: { challenge: proof.challenge, credential: proof.credential, platform: 'web' },
      });
      if (!ok(answer)) return signInPage(req, res, { error: said(answer) }, answer.status);
      return signedInAs(req, res, answer.body.token);
    },
  };

  pages.post('/signin/:step', wrap(async (req, res, next) => {
    const step = SIGN_IN[req.params.step];
    if (!step) return next();
    return step(req, res, req.body || {});
  }));

  // ---- Continue with Vesopa ------------------------------------------------------

  /** Leave for auth.vesopa.com: Apple, Google, a passkey, the phone, or Vesopa's own page. */
  pages.get('/vesopa', wrap(async (req, res) => {
    const issuer = idtoken.issuer();
    const clientId = idtoken.clientId();
    if (!issuer || !clientId) return signInPage(req, res, { error: 'Continue with Vesopa is not available here yet.' }, 503);
    const idp = ['apple', 'google', 'phone', 'passkey'].includes(req.query.idp) ? req.query.idp : null;
    const nonce = rand(12);
    const verifier = rand(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    setCookie(res, SSO_COOKIE, `${req.member.slug}.${nonce}.${verifier}`, 600);
    const url = new URL(`${issuer}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: `${req.protocol}://${req.get('host')}/app/vesopa/callback`,
      scope: 'openid email profile',
      state: `${req.member.slug}.${nonce}`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(idp ? { idp } : {}),
    }).toString();
    res.set('Cache-Control', 'no-store').redirect(303, url.toString());
  }));

  /** Back from Vesopa with a code (or a refusal) in the address. */
  async function finishVesopa(req, res) {
    const q = req.query;
    const [slug, nonce, verifier] = String(req.member.cookies[SSO_COOKIE] || '').split('.');
    clearCookie(res, SSO_COOKIE);
    if (q.vesopa_error) {
      return signInPage(req, res, {
        method: 'vesopa',
        error: q.vesopa_error === 'access_denied' ? 'That sign-in was cancelled.' : 'Vesopa could not sign you in. Please try again.',
      });
    }
    /*
     * The state has to be the one this browser set off with. Without the
     * check, a link carrying somebody else's code would sign this browser
     * into their membership.
     */
    if (!verifier || slug !== req.member.slug || q.vesopa_state !== `${slug}.${nonce}`) {
      return signInPage(req, res, { method: 'vesopa', error: 'That sign-in could not be matched to this device. Please try again.' }, 400);
    }
    const answer = await callApi(req, 'POST', `${req.member.api}/vesopa`, {
      body: {
        code: String(q.vesopa_code),
        code_verifier: verifier,
        redirect_uri: `${req.protocol}://${req.get('host')}/app/vesopa/callback`,
        platform: 'web',
      },
    });
    if (!ok(answer)) return signInPage(req, res, { method: 'vesopa', error: said(answer) }, answer.status);
    return signedInAs(req, res, answer.body.token);
  }

  // ---- Signing out and leaving -----------------------------------------------------

  pages.post('/signout', wrap(async (req, res) => {
    if (req.member.token) await api(req, 'POST', '/loyalty/v1/me/signout').catch(() => null);
    forget(req, res);
    res.redirect(303, req.member.base);
  }));

  pages.post('/leave', wrap(async (req, res) => {
    if (req.member.token) await api(req, 'DELETE', '/loyalty/v1/me').catch(() => null);
    forget(req, res);
    res.redirect(303, req.member.base);
  }));

  // ---- The signed-in pages -------------------------------------------------------------

  pages.get('/activity', wrap(async (req, res) => {
    const before = typeof req.query.before === 'string' ? `?before=${encodeURIComponent(req.query.before)}` : '';
    const f = await frame(req, res, [['GET', `/loyalty/v1/me/history${before}`]]);
    if (!f) return;
    const [history] = f.answers;
    send(req, res, views.activity({ m: req.member, ...f, history: ok(history) ? history.body : null, error: ok(history) ? null : said(history), paged: !!before }));
  }));

  pages.get('/news', wrap(async (req, res) => {
    const before = typeof req.query.before === 'string' ? req.query.before : '';
    const f = await frame(req, res, before ? [['GET', `/loyalty/v1/me/messages?before=${encodeURIComponent(before)}`]] : []);
    if (!f) return;
    // The first page is the frame's own answer for the bell; an older page is asked for.
    const page = before ? f.answers[0] : await api(req, 'GET', '/loyalty/v1/me/messages');
    send(req, res, views.news({ m: req.member, ...f, inbox: ok(page) ? page.body : null, before, error: ok(page) ? null : said(page) }));
  }));

  pages.get('/news/:id', wrap(async (req, res) => {
    const before = typeof req.query.b === 'string' ? `?before=${encodeURIComponent(req.query.b)}` : '';
    const f = await frame(req, res, [['GET', `/loyalty/v1/me/messages${before}`]]);
    if (!f) return;
    const list = ok(f.answers[0]) ? f.answers[0].body.items || [] : [];
    const message = list.find((x) => String(x.id) === String(req.params.id));
    if (!message) return res.redirect(303, `${req.member.base}news`);
    if (!message.read_at) {
      await api(req, 'POST', `/loyalty/v1/me/messages/${encodeURIComponent(message.id)}/read`);
      f.unread = Math.max(0, f.unread - 1);
    }
    send(req, res, views.message({ m: req.member, ...f, message }));
  }));

  pages.get('/venue', wrap(async (req, res) => {
    const f = await frame(req, res);
    if (!f) return;
    send(req, res, views.venue({ m: req.member, ...f }));
  }));

  pages.get('/classes', wrap(async (req, res) => {
    const f = await frame(req, res, [['GET', '/loyalty/v1/me/classes?days=14']]);
    if (!f) return;
    const [list] = f.answers;
    send(req, res, views.classes({
      m: req.member, ...f, list: ok(list) ? list.body : [], error: ok(list) ? null : said(list), done: req.query.said,
    }));
  }));

  pages.post('/classes/:id/:act', wrap(async (req, res, next) => {
    const act = { book: 'book', cancel: 'cancel' }[req.params.act];
    if (!act || !/^\d+$/.test(req.params.id) || !req.member.token) return next();
    const answer = await api(req, 'POST', `/loyalty/v1/me/classes/${req.params.id}/${act}`);
    if (answer.status === 401) {
      forget(req, res);
      return res.redirect(303, req.member.base);
    }
    if (!ok(answer)) {
      const f = await frame(req, res, [['GET', '/loyalty/v1/me/classes?days=14']]);
      if (!f) return;
      return send(req, res, views.classes({ m: req.member, ...f, list: ok(f.answers[0]) ? f.answers[0].body : [], error: said(answer) }), answer.status);
    }
    const outcome = act === 'book'
      ? (answer.body && answer.body.status === 'waitlist' ? 'waitlist' : 'booked')
      : (req.body.was === 'waitlist' ? 'left' : 'cancelled');
    res.redirect(303, `${req.member.base}classes?said=${outcome}`);
  }));

  pages.get('/wallet/:kind', wrap(async (req, res, next) => {
    if (!['apple', 'google'].includes(req.params.kind) || !req.member.token) return next();
    const answer = await api(req, 'GET', '/loyalty/v1/me/wallet');
    if (!ok(answer) || !answer.body[req.params.kind]) return res.redirect(303, req.member.base);
    res.set('Cache-Control', 'no-store').redirect(303, answer.body[req.params.kind]);
  }));

  // ---- The account page --------------------------------------------------------------

  const DONE = {
    name: 'Name changed.',
    phone: 'Number confirmed.',
    'phone-removed': 'Number removed.',
    password: 'Password saved.',
    passkey: 'Passkey added.',
    'passkey-removed': 'Passkey removed.',
    others: 'Other devices signed out.',
    photo: 'Your photo is on your card.',
    'photo-removed': 'Photo removed.',
    deletion: 'Request sent. We have emailed you a copy.',
    paid: 'Payment received. Your membership is up to date.',
  };

  /** The account page, with whatever a form left to say. */
  async function accountPage(req, res, state = {}, status = 200) {
    const pending = req.member.cookies[paymentCookie(req.member.slug)] || null;
    const f = await frame(req, res, [
      ['GET', '/loyalty/v1/me/account'],
      ['GET', '/loyalty/v1/me'],
      ['GET', '/loyalty/v1/me/deletion'],
      ...(pending && !state.checked ? [['POST', `/loyalty/v1/me/membership/checkout/${encodeURIComponent(pending)}/check`]] : []),
    ]);
    if (!f) return;
    const [account, me, deletion, check] = f.answers;
    if (!ok(account)) return send(req, res, views.notice({ m: req.member, brand: f.brand, text: said(account), signOut: true }), account.status);
    let payment = pending;
    let note = state.note || DONE[req.query.said] || null;
    // Back from paying: asked quietly, as the app does on coming back to it.
    if (check && (check.status === 404 || (ok(check) && check.body.paid))) {
      clearCookie(res, paymentCookie(req.member.slug));
      payment = null;
      if (ok(check)) {
        note = DONE.paid;
        // The membership has just changed; draw the new one.
        const fresh = await api(req, 'GET', '/loyalty/v1/me/membership');
        f.member = fresh.status === 200 ? fresh.body : f.member;
      }
    }
    send(req, res, views.account({
      m: req.member, ...f,
      account: account.body,
      me: ok(me) ? me.body : {},
      deletion: ok(deletion) ? deletion.body : null,
      payment,
      state: { ...state, note },
    }), status);
  }

  pages.get('/account', wrap(async (req, res) => accountPage(req, res)));

  /** What each form on the account page asks the API. */
  const ACCOUNT = {
    name: (b) => ['PUT', '/loyalty/v1/me/account', { name: String(b.name || '').trim() }],
    phone: (b) => ['POST', '/loyalty/v1/me/phone', { phone: (b.country && views.toInternational(String(b.country), String(b.phone || ''))) || String(b.phone || '').trim() }],
    'phone-verify': (b) => ['POST', '/loyalty/v1/me/phone/verify', { phone: String(b.phone || '').trim(), code: String(b.code || '').trim() }],
    'phone-firebase': (b) => ['POST', '/loyalty/v1/me/phone/firebase', { id_token: String(b.id_token || '') }],
    'phone-remove': () => ['DELETE', '/loyalty/v1/me/phone'],
    password: (b) => ['POST', '/loyalty/v1/me/password', { ...(b.current ? { current: String(b.current) } : {}), password: String(b.password || '') }],
    'passkey-remove': (b) => ['DELETE', `/loyalty/v1/me/passkeys/${encodeURIComponent(String(b.id || ''))}`],
    others: () => ['POST', '/loyalty/v1/me/signout-others'],
    'photo-remove': () => ['DELETE', '/loyalty/v1/me/photo'],
    deletion: (b) => ['POST', '/loyalty/v1/me/deletion', {
      mode: b.mode === 'review' ? 'review' : 'scheduled',
      ...(b.mode === 'review' ? {} : { delay_days: Number(b.days) || 30 }),
    }],
  };

  /** Where each one lands, said. */
  const ACCOUNT_DONE = {
    name: 'name', 'phone-verify': 'phone', 'phone-firebase': 'phone', 'phone-remove': 'phone-removed', password: 'password',
    'passkey-remove': 'passkey-removed', others: 'others', 'photo-remove': 'photo-removed', deletion: 'deletion',
  };

  pages.post('/account/:action', wrap(async (req, res, next) => {
    const action = req.params.action;
    if (!req.member.token) return res.redirect(303, req.member.base);
    const b = req.body || {};

    if (action === 'photo') {
      const answer = await forwardUpload(req, '/loyalty/v1/me/photo', req.member.token);
      if (!ok(answer)) return accountPage(req, res, { error: said(answer, 'That photograph could not be used.') }, answer.status === 401 ? 401 : 400);
      return res.redirect(303, `${req.member.base}account?said=photo`);
    }

    // Passkeys need the browser, so these two are asked from script.
    if (action === 'passkey-options') {
      const answer = await api(req, 'POST', '/loyalty/v1/me/passkeys/options');
      return res.status(answer.status).set('Cache-Control', 'no-store').json(answer.body);
    }
    if (action === 'passkey') {
      let proof = null;
      try {
        proof = JSON.parse(String(b.proof || ''));
      } catch {
        proof = null;
      }
      const answer = proof ? await api(req, 'POST', '/loyalty/v1/me/passkeys', proof) : { status: 400, body: {} };
      if (!ok(answer)) return accountPage(req, res, { error: said(answer, 'That passkey could not be checked. Please try again.') }, 400);
      return res.redirect(303, `${req.member.base}account?said=passkey`);
    }

    // Paying for a membership is Dojo's page, not ours.
    if (action === 'pay') {
      const answer = await api(req, 'POST', '/loyalty/v1/me/membership/checkout', {
        kind: b.kind === 'join' ? 'join' : 'renew',
        ...(b.scheme_id ? { scheme_id: Number(b.scheme_id) } : {}),
      });
      if (!ok(answer) || !answer.body.url || !answer.body.payment_id) {
        return accountPage(req, res, { error: said(answer, 'The payment could not be started. Please try again.') }, 400);
      }
      setCookie(res, paymentCookie(req.member.slug), String(answer.body.payment_id), 30 * 24 * 3600);
      return res.redirect(303, answer.body.url);
    }
    if (action === 'pay-check') {
      const pending = req.member.cookies[paymentCookie(req.member.slug)];
      if (!pending) return res.redirect(303, `${req.member.base}account`);
      const answer = await api(req, 'POST', `/loyalty/v1/me/membership/checkout/${encodeURIComponent(pending)}/check`);
      if (answer.status === 404 || (ok(answer) && answer.body.paid)) {
        clearCookie(res, paymentCookie(req.member.slug));
        req.member.cookies[paymentCookie(req.member.slug)] = '';
      }
      if (ok(answer) && answer.body.paid) return res.redirect(303, `${req.member.base}account?said=paid`);
      return accountPage(req, res, { checked: true, error: ok(answer) ? 'That payment has not gone through yet.' : said(answer) });
    }
    if (action === 'pay-forget') {
      clearCookie(res, paymentCookie(req.member.slug));
      return res.redirect(303, `${req.member.base}account`);
    }

    const ask = ACCOUNT[action];
    if (!ask) return next();
    if (action === 'name' && !String(b.name || '').trim()) return accountPage(req, res, { error: 'Please give a name for the card.' }, 400);
    const [method, url, body] = ask(b);
    const answer = await api(req, method, url, body);
    if (answer.status === 401) {
      forget(req, res);
      return res.redirect(303, req.member.base);
    }
    if (!ok(answer)) {
      return accountPage(req, res, {
        error: said(answer),
        ...(action === 'phone-verify' ? { phone: String(b.phone || '').trim() } : {}),
      }, answer.status);
    }
    // A code is on its way: the same page, now asking for it.
    if (action === 'phone') return accountPage(req, res, { phone: String(b.phone || '').trim(), note: 'Code sent.' });
    return res.redirect(303, `${req.member.base}account?said=${ACCOUNT_DONE[action]}`);
  }));

  // ---- The venue page's switches, from script --------------------------------------------

  pages.post('/venue/:what', wrap(async (req, res, next) => {
    if (!req.member.token) return res.status(401).json({ error: 'Please sign in again.' });
    const b = req.body || {};
    const ask = {
      push: () => ['POST', '/loyalty/v1/me/push', { kind: 'webpush', subscription: b.subscription }],
      'push-off': () => ['DELETE', '/loyalty/v1/me/push', { endpoint: String(b.endpoint || '') }],
    }[req.params.what];
    if (!ask) return next();
    const [method, url, body] = ask();
    const answer = await api(req, method, url, body);
    res.status(answer.status).set('Cache-Control', 'no-store').json(answer.body);
  }));

  // An address inside the old app (a deep link, a bookmark): the card.
  pages.get('/*rest', (req, res) => res.redirect(302, req.member.base));

  return outer;
}

module.exports = { memberWebRoutes, callApi, Answer };
