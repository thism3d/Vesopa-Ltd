/**
 * Which ways in an application offers, and in what order.
 *
 * THE OWNER'S REQUIREMENT WAS "keep the scope open" — Google, Microsoft,
 * GitHub, Email, Phone, "or anything that comes later". So the database holds
 * ROWS in `application_auth_methods`, not a boolean column each, and this file
 * holds the only list of methods the application layer knows how to draw.
 *
 * The two lists are deliberately allowed to disagree, in one direction only:
 *
 *   a row naming a method this file does not know  → ignored, silently
 *   a method here with no row for an application   → not offered
 *
 * That asymmetry is what makes adding a provider a two-step deploy instead of a
 * flag day. The rows can go in first and mean nothing; the code lands and they
 * start working. The reverse — code that renders a button for a method with no
 * row — would show a button that leads nowhere, which is the failure this whole
 * arrangement exists to avoid.
 *
 * A METHOD IS ALSO GATED ON THE SERVER BEING ABLE TO DO IT. A row saying
 * `github` on an application means nothing if this server has no GitHub
 * credentials, and the button is not drawn. That check lives here rather than
 * in the template, because "can we actually complete this?" is not a question a
 * template should be asking.
 */

const db = require('./db');
const config = require('./config');
const providers = require('./providers');

/**
 * Everything the sign-in page knows how to render.
 *
 * `kind` decides where it appears on the page:
 *   `credential` — the thing the person types (a password)
 *   `code`       — send something to an address or a number
 *   `device`     — a passkey, held by the machine
 *   `provider`   — hand off to somebody else
 */
const KNOWN = {
  password: {
    kind: 'credential',
    label: 'Password',
    // Always possible: it needs nothing but the database.
    available: () => true,
  },
  code_email: {
    kind: 'code',
    label: 'Email a code',
    channel: 'email',
    available: () => true,
  },
  code_sms: {
    kind: 'code',
    label: 'Text a code',
    channel: 'phone',
    /*
     * `FEATURE_PHONE`, not "is a gateway configured". Texting costs real money
     * and reaches UK numbers only, so whether it is offered is a decision
     * somebody makes rather than a consequence of an environment variable
     * happening to be set.
     */
    available: () => Boolean(config.features && config.features.phone),
  },
  passkey: {
    kind: 'device',
    label: 'Passkey',
    available: () => Boolean(config.features && config.features.passkeys),
  },
  google: { kind: 'provider', label: 'Google', available: () => hasProvider('google') },
  microsoft: { kind: 'provider', label: 'Microsoft', available: () => hasProvider('microsoft') },
  apple: { kind: 'provider', label: 'Apple', available: () => hasProvider('apple') },
  github: { kind: 'provider', label: 'GitHub', available: () => hasProvider('github') },
};

function hasProvider(key) {
  return providers.enabled().some((provider) => provider.key === key);
}

/*
 * What an application gets when it has no rows at all — which includes the
 * bare `/login` page, reached directly rather than through /oauth/authorize.
 *
 * THE PROVIDERS ARE DERIVED, NOT LISTED, AND THAT IS THE WHOLE POINT.
 *
 * This was a hand-written list ending `{ method: 'google', sort: 50 }`, and it
 * quietly removed Apple, Microsoft and GitHub from the front page of the
 * identity provider. Their credentials were configured, their code worked and
 * their callbacks were registered — they simply were not named in an array,
 * and nothing anywhere reports a provider that was never asked for.
 *
 * It was the second copy of the same mistake: schema_008's backfill enumerated
 * the same five methods and dropped the same three providers, so repairing the
 * table alone changed nothing here. A hand-written list of what exists, kept
 * in two places, goes stale in two places.
 *
 * So the fallback asks the server what it can actually do. Add credentials for
 * a fifth provider tomorrow and it appears; take Apple's away and it goes.
 * There is no third place to remember.
 */
function fallbackMethods() {
  const base = [
    { method: 'password', sort: 10 },
    { method: 'code_email', sort: 20 },
    { method: 'code_sms', sort: 30 },
    { method: 'passkey', sort: 40 },
  ];

  /*
   * Ordered as the provider module orders them, so the buttons do not shuffle
   * between one deployment and the next. `available()` still has the final say
   * below — this decides what is OFFERED, never what works.
   */
  providers.enabled().forEach((provider, index) => {
    base.push({ method: provider.key, sort: 50 + index * 10 });
  });

  return base;
}

/**
 * The methods this application offers, ordered, filtered to what works.
 *
 * `applicationId` may be null — that is the sign-in page reached directly
 * rather than through /oauth/authorize, and it gets the global default.
 */
async function forApplication(applicationId) {
  let rows = [];
  if (applicationId) {
    rows = await db.query(
      `SELECT method, sort FROM application_auth_methods
        WHERE application_id = ? AND enabled = 1
        ORDER BY sort, method`,
      [applicationId],
    );
  }
  const chosen = rows.length ? rows : fallbackMethods();

  return chosen
    .filter((row) => KNOWN[row.method] && KNOWN[row.method].available())
    .map((row) => ({ method: row.method, ...KNOWN[row.method], inherited: !rows.length }));
}

/** Split into the shapes a template actually lays out. */
function group(methods) {
  return {
    password: methods.some((m) => m.method === 'password'),
    codeEmail: methods.some((m) => m.method === 'code_email'),
    codeSms: methods.some((m) => m.method === 'code_sms'),
    passkey: methods.some((m) => m.method === 'passkey'),
    providers: methods
      .filter((m) => m.kind === 'provider')
      .map((m) => ({ key: m.method, name: m.label })),
  };
}

/**
 * What the page should put in front of somebody first.
 *
 * The policy is the application's, falling back to the administrator's global
 * default. It decides what leads — never what is possible: `password_first`
 * still offers a code underneath, because an account whose owner has forgotten
 * their password must not be a dead end.
 *
 * And a policy of `password_first` is ignored for a person who has no password,
 * which is most people here. Showing an empty password box to somebody who
 * never set one is asking a question with no answer.
 */
function firstStep({ policy, methods, hasPassword }) {
  const shape = group(methods);
  if (policy === 'provider_only') return 'provider';
  if (policy === 'password_first' && shape.password && hasPassword) return 'password';
  if (shape.codeEmail || shape.codeSms) return 'code';
  if (shape.password && hasPassword) return 'password';
  return 'provider';
}

/** Replace an application's methods wholesale, from a form. */
async function set(applicationId, wanted) {
  const clean = [...new Set((wanted || []).filter((m) => KNOWN[m]))];

  await db.execute('DELETE FROM application_auth_methods WHERE application_id = ?', [
    applicationId,
  ]);

  const order = Object.keys(KNOWN);
  for (const method of clean) {
    // eslint-disable-next-line no-await-in-loop -- a handful of rows
    await db.execute(
      `INSERT INTO application_auth_methods (application_id, method, enabled, sort)
       VALUES (?, ?, 1, ?)`,
      [applicationId, method, (order.indexOf(method) + 1) * 10],
    );
  }
  return clean;
}

/**
 * Which application this sign-in is FOR, worked out from `return_to`.
 *
 * `/oauth/authorize` sends an unauthenticated person to
 * `/login?return_to=/oauth/authorize?...client_id=…`, so the application is
 * already in front of us — it just has to be read out. Somebody arriving at
 * `/login` directly is signing in to Vesopa itself and gets the defaults.
 *
 * NOTHING HERE IS TRUSTED FOR AUTHORISATION. `return_to` is attacker-controlled
 * in the sense that anybody can put any client id in it. What it decides is
 * cosmetic and permissive-downward: which buttons are drawn and which step
 * leads. A forged client id can make the page offer FEWER ways in, never more —
 * every method is still checked against what the server can actually do, and
 * the authorisation itself is re-validated at /oauth/authorize with the real
 * request. Reading it is safe; acting on it as though it were proof would not
 * be.
 */
async function contextFor(returnTo, defaultPolicy = 'password_first') {
  let application = null;

  const raw = String(returnTo || '');
  if (raw.startsWith('/oauth/authorize')) {
    const query = raw.slice(raw.indexOf('?') + 1);
    const clientId = new URLSearchParams(query).get('client_id') || '';
    if (/^[a-f0-9]{32}$/.test(clientId)) {
      application = await db.one(
        `SELECT id, name, slug, logo_path, auth_policy, guest_allowed
           FROM applications
          WHERE client_id = ? AND status = 'active' AND deleted_at IS NULL`,
        [clientId],
      );
    }
  }

  const methods = await forApplication(application ? application.id : null);
  return {
    application,
    policy: (application && application.auth_policy) || defaultPolicy,
    methods,
    shape: group(methods),
  };
}

module.exports = { KNOWN, forApplication, group, firstStep, set, contextFor, fallbackMethods };
