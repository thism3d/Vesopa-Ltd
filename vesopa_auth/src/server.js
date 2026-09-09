/**
 * auth.vesopa.com — Vesopa OAuth.
 *
 * One account for every Vesopa product: the EPOS till, the QR dine-in menu, the
 * back office, the hosting panel, and whatever a developer registers later.
 *
 * BOOT ORDER MATTERS HERE. Configuration is validated first and throws if a
 * secret is missing; then the database is checked; only then does anything
 * listen. A process that accepts requests before it can hash a password will
 * answer them badly rather than not at all, and "badly" on a login page means
 * somebody gets in or somebody real does not.
 */

const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const csrf = require('./csrf');
const captcha = require('./captcha');
const webhooks = require('./webhooks');
const { securityHeaders, requestContext } = require('./middleware');
const pages = require('./routes/pages');
const auth = require('./routes/auth');
const stepup = require('./routes/stepup');
const oidc = require('./routes/oidc');
const social = require('./routes/social');
const mfa = require('./routes/mfa');
const account = require('./routes/account');
const policies = require('./routes/policies');
const admin = require('./routes/admin');
const developers = require('./routes/developers');
const device = require('./routes/device');

const app = express();

/*
 * nginx sits in front on 127.0.0.1:20003, so req.ip and req.protocol are the
 * proxy's unless this is set. Getting it wrong is not cosmetic: every rate
 * limit would count the proxy as the one client in the world, and every
 * `secure` cookie decision would be made about an http hop that is really
 * https. `1` and not `true` — trusting an unbounded chain lets a client
 * spoof X-Forwarded-For and pick its own identity for the rate limiter.
 */
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(compression());
app.use(securityHeaders);
app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));
app.use(requestContext);
/*
 * The CSRF token is issued on every request, not only on the ones that render a
 * form. A page fetched from the browser cache would otherwise render with a
 * token whose cookie has since expired, and the person's next submission is
 * refused for no reason they can see.
 */
app.use(csrf.issue);

/*
 * Static assets. `immutable` is safe here only because these files are
 * fingerprint-free brand assets that change with a deploy and a version query
 * string; anything user-specific must never reach this middleware.
 */
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    etag: true,
    index: false,
  }),
);

// ---------------------------------------------------------------------------
// Operational endpoints
// ---------------------------------------------------------------------------

/**
 * Health. Deliberately says almost nothing.
 *
 * An unauthenticated health endpoint on an identity provider is read by
 * everybody, so it reports that the process is up and that the database
 * answered, and not the version of anything, the hostname, or the error text
 * when it fails. "Which database driver, at which version, is failing how" is a
 * reconnaissance gift.
 */
app.get('/health', async (req, res) => {
  try {
    await db.check();
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    [
      'User-agent: *',
      // The account, admin and developer areas must not be crawled.
      'Disallow: /account',
      'Disallow: /admin',
      'Disallow: /developers',
      'Disallow: /oauth',
      'Disallow: /api',
      //
      // /login is NOT disallowed, and that is on purpose. A page blocked in
      // robots.txt cannot be fetched, so a crawler never sees the `noindex`
      // that is on it — and a URL blocked here can still be listed by a search
      // engine that found it linked elsewhere. Letting the crawler read the
      // page and obey its noindex is what actually keeps it out of results.
      '',
      `Sitemap: ${config.issuer}/sitemap.xml`,
    ].join('\n'),
  );
});

/** RFC 9116 — where to report a security problem. */
app.get('/.well-known/security.txt', (req, res) => {
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  res.type('text/plain').send(
    [
      'Contact: mailto:security@vesopa.com',
      `Expires: ${expires}`,
      'Preferred-Languages: en',
      `Canonical: ${config.issuer}/.well-known/security.txt`,
      `Policy: ${config.issuer}/security`,
    ].join('\n'),
  );
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/*
 * Protocol endpoints first. They are the ones other software talks to, so a
 * page route must never be able to shadow one — and /.well-known/ in
 * particular has to answer before anything else claims it.
 */
app.use('/', oidc);
app.use('/', social);
app.use('/', mfa);
app.use('/', account);
app.use('/', policies);
app.use('/', admin);
app.use('/', developers);
app.use('/', device);
app.use('/', stepup);
app.use('/', auth);
app.use('/', pages);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404);
  if (req.accepts('html')) {
    return res.render('error', {
      title: 'Page not found',
      heading: 'That page is not here',
      message: 'The link may be old, or it may have been mistyped.',
      config,
      nonce: res.locals.nonce,
    });
  }
  return res.json({ error: 'not_found' });
});

// eslint-disable-next-line no-unused-vars -- Express identifies the error
// handler by its four arguments; dropping `next` silently turns it into
// ordinary middleware and every error becomes an unhandled 500.
app.use((error, req, res, next) => {
  /*
   * Log everything, show nothing. The stack trace of an identity provider names
   * its internals and sometimes quotes the input that broke it — which on this
   * server can be somebody's password.
   */
  console.error('[error]', req.method, req.originalUrl, error);

  res.status(500);
  if (req.accepts('html')) {
    return res.render('error', {
      title: 'Something went wrong',
      heading: 'Something went wrong',
      message: 'This has been logged. Please try again in a moment.',
      config,
      nonce: res.locals.nonce,
    });
  }
  return res.json({ error: 'server_error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function start() {
  const info = await db.check();
  console.log(`[boot] database ${info.db} on MariaDB ${info.version}`);

  /*
   * SAY WHETHER THE CAPTCHA IS ON.
   *
   * With no keys set, `captcha.assess()` answers "fine" and every page renders
   * exactly as it did — which is the right behaviour and an awful thing to be
   * unable to see. A protection that is off looks identical to one that is on
   * and working, so the only way to know is to be told. One line at boot, and
   * the health page shows the same thing.
   *
   * The site key is printed and the secret is not: the site key is in the page
   * source of every sign-in anyway, and the secret must never reach a log.
   */
  if (captcha.enabled()) {
    console.log(
      `[boot] reCAPTCHA v3 ON — site key ${config.captcha.siteKey.slice(0, 10)}…, ` +
        `threshold ${config.captcha.threshold} ` +
        '(a low score asks for an emailed code; it never refuses)',
    );
  } else {
    console.log(
      '[boot] reCAPTCHA v3 OFF — no site key and secret configured. ' +
        'Set RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY (or the ' +
        'VESOPA_AUTH_CAPTCHA_* names) to turn it on.',
    );
  }

  /*
   * The webhook worker. A timer in this process rather than a cron entry,
   * because the owner asked that nothing be added to the shared server outside
   * this application's own domain — and pm2 runs this in fork mode with one
   * instance, so there is exactly one worker.
   */
  webhooks.startWorker();
  console.log('[boot] webhook worker running');

  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(
      `[boot] vesopa_auth ${config.version} listening on 127.0.0.1:${config.port} (${config.env})`,
    );
    console.log(`[boot] issuer ${config.issuer}`);
  });

  /*
   * Let in-flight requests finish. A restart during a sign-in should not strand
   * somebody halfway through a code exchange with a token they cannot use.
   */
  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal}`);
    webhooks.stopWorker();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[boot] failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = { app, start };
