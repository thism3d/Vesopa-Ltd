/**
 * Configuration, validated at boot and never read from `process.env` again.
 *
 * WHY IT FAILS FAST
 *
 * The failure this prevents is specific and has happened to other applications
 * on this box: a deploy loses `.env`, the process starts anyway, and something
 * downstream quietly does the insecure version of its job — a cookie without
 * `secure`, a code table with no pepper, a signing key nobody can decrypt. All
 * of those look fine in a log. A missing secret must stop the process at boot,
 * loudly, while somebody is still watching the deploy.
 *
 * The one thing that is NOT validated here is the database being reachable.
 * That is checked separately at startup, because "the database is asleep" and
 * "you forgot a setting" deserve different messages.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

/** A required setting. Absent in production is fatal. */
function required(name, { minLength = 1 } = {}) {
  const value = (process.env[name] || '').trim();
  if (value.length >= minLength) return value;

  if (isProduction) {
    throw new Error(
      `${name} is missing from .env (needs at least ${minLength} characters). ` +
        'Refusing to start: running without it would be less safe than not running.',
    );
  }
  // In development, generate something usable and say so loudly. This must
  // never happen in production, which is why the branch above exists.
  const stand_in = require('crypto').randomBytes(32).toString('hex');
  console.warn(`⚠ ${name} not set — using a throwaway value for development only`);
  return stand_in;
}

function optional(name, fallback = '') {
  const value = (process.env[name] || '').trim();
  return value || fallback;
}

function number(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function flag(name, fallback = false) {
  const value = (process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

const issuer = optional('ISSUER', 'https://auth.vesopa.com').replace(/\/$/, '');

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction,
  port: number('PORT', 20003),

  /** The `iss` claim, and the base of every URL this service publishes. */
  issuer,
  /** Where cookies live. */
  cookieDomain: optional('COOKIE_DOMAIN', ''),

  /**
   * The WebAuthn relying party.
   *
   * The APEX domain, not auth.vesopa.com, and this is the single hardest
   * setting in the file to change later. A credential is bound to the RP ID it
   * was created under: passkeys enrolled against `auth.vesopa.com` cannot ever
   * be used from `menu.vesopa.com` or `cloud.vesopa.com`, and the only remedy
   * is asking every user to enrol again. Bound to the apex, they work on every
   * Vesopa subdomain that will ever exist.
   *
   * Only this origin runs the ceremonies, which is why `rpOrigins` is narrow
   * while `rpId` is broad.
   */
  webauthn: {
    rpId: optional('WEBAUTHN_RP_ID', 'vesopa.com'),
    rpName: optional('WEBAUTHN_RP_NAME', 'Vesopa'),
    rpOrigins: optional('WEBAUTHN_ORIGINS', issuer)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  db: {
    host: optional('DB_HOST', '127.0.0.1'),
    port: number('DB_PORT', 3306),
    user: optional('DB_USER', 'vesopasoftware_authuser'),
    password: optional('DB_PASSWORD', ''),
    database: optional('DB_NAME', 'vesopasoftware_authdb'),
    connectionLimit: number('DB_POOL', 10),
  },

  secrets: {
    /**
     * Peppers the six-digit codes we email. A plain hash of a six-digit code is
     * reversible by trying all million, so the pepper — which is not in the
     * database — is what makes a stolen table useless.
     */
    codePepper: required('CODE_PEPPER', { minLength: 32 }),
    /** Peppers password hashes, on top of argon2's own salt. */
    passwordPepper: required('PASSWORD_PEPPER', { minLength: 32 }),
    /** AES-256-GCM key for TOTP seeds and signing keys. 64 hex characters. */
    encryptionKey: required('ENCRYPTION_KEY', { minLength: 64 }),
    /** Salts the derivation of pairwise subject identifiers. */
    subjectPepper: required('SUBJECT_PEPPER', { minLength: 32 }),
  },

  session: {
    /**
     * Two clocks, because one is either annoying or dangerous. `idleHours` ends
     * a session somebody walked away from; `absoluteDays` ends one that has
     * been kept warm for a month by a script.
     */
    idleHours: number('SESSION_IDLE_HOURS', 12),
    absoluteDays: number('SESSION_ABSOLUTE_DAYS', 30),
    /** With the tickbox: how long the browser keeps the cookie at all. */
    rememberedDays: number('SESSION_REMEMBERED_DAYS', 30),
    /** How long a remembered device may skip the second factor. */
    deviceTrustDays: number('DEVICE_TRUST_DAYS', 30),
  },

  codes: {
    length: number('CODE_LENGTH', 6),
    ttlMinutes: number('CODE_TTL_MINUTES', 10),
    maxAttempts: number('CODE_MAX_ATTEMPTS', 5),
    /** Per destination, per hour. Also the anti-harassment limit. */
    maxSendsPerDestination: number('CODE_MAX_SENDS_DESTINATION', 5),
    /** Per IP, per hour. Stops one machine walking through addresses. */
    maxSendsPerIp: number('CODE_MAX_SENDS_IP', 30),
  },

  tokens: {
    accessTtlSeconds: number('ACCESS_TTL', 600),
    idTtlSeconds: number('ID_TOKEN_TTL', 600),
    refreshTtlSeconds: number('REFRESH_TTL', 2592000),
    authorizationCodeTtlSeconds: number('CODE_GRANT_TTL', 60),
    /**
     * How long after a refresh token is spent a repeat presentation from the
     * same device is treated as a retry rather than a theft. A till on bad wifi
     * sends /token twice; without this, that revokes the family and the pub
     * loses its till mid-service.
     */
    refreshReplayGraceSeconds: number('REFRESH_GRACE', 10),
  },

  mail: {
    host: optional('SMTP_HOST', 'localhost'),
    port: number('SMTP_PORT', 587),
    secure: flag('SMTP_SECURE', false),
    user: optional('SMTP_USER', ''),
    password: optional('SMTP_PASSWORD', ''),
    /**
     * no-reply@vesopa.com, and not an address at auth.vesopa.com, because this
     * one is already SPF-verified with Apple as a registered sender for the
     * private email relay. Changing it means re-registering with Apple, and
     * until that is done Apple silently stops forwarding to relay users.
     */
    from: optional('MAIL_FROM', 'Vesopa <no-reply@vesopa.com>'),
    replyTo: optional('MAIL_REPLY_TO', 'info@vesopasoftware.com'),
  },

  sms: {
    /** Which gateway. Postcoder today; the interface exists so it can change. */
    provider: optional('SMS_PROVIDER', 'postcoder'),
    postcoderKey: optional('POSTCODER_API_KEY', ''),
    /**
     * Postcoder's OTP service texts UK mobiles only. The country picker is
     * real and its dial codes are real, but a non-UK number must be refused
     * with a sentence telling the person to use email — which is better than an
     * SMS that silently never arrives.
     */
    countries: optional('SMS_COUNTRIES', 'GB').split(',').map((s) => s.trim()),
  },

  admin: {
    /** Seeded on first boot, and the only account that starts with access. */
    email: optional('ADMIN_EMAIL', 'info@vesopasoftware.com'),
    password: optional('ADMIN_PASSWORD', ''),
  },

  /** Retention, in days. Matches what the published policy pages promise. */
  retention: {
    loginEventDays: number('RETENTION_LOGIN_EVENTS', 396), // 13 months
    auditDays: number('RETENTION_AUDIT', 396),
    challengeHours: number('RETENTION_CHALLENGES', 24),
    deletedAccountDays: number('RETENTION_DELETED_ACCOUNTS', 30),
  },

  /**
   * What is actually finished.
   *
   * The login page is live before every sign-in method behind it is, so each
   * one is advertised only once its endpoints exist. A social button or a
   * passkey prompt that leads to a 404 is worse than its absence: somebody
   * picks the route that looks most secure and is told it went wrong, which
   * teaches them the whole service is unreliable.
   *
   * These flip to `true` as each phase lands, and the switches are here rather
   * than in the template so the page and the script agree.
   */
  /*
   * reCAPTCHA v3.
   *
   * Off unless both keys are present. The threshold is Google's own suggested
   * default; below it the sign-in page does not refuse anybody, it stops
   * offering the fast paths and asks for an emailed code — see src/captcha.js
   * for why a score must never be a gate on a page like this.
   */
  captcha: {
    siteKey: process.env.RECAPTCHA_SITE_KEY || '',
    secretKey: process.env.RECAPTCHA_SECRET_KEY || '',
    threshold: Number(process.env.RECAPTCHA_THRESHOLD || 0.5),
  },

  features: {
    passkeys: flag('FEATURE_PASSKEYS', false),
    social: flag('FEATURE_SOCIAL', false),
    phone: flag('FEATURE_PHONE', false),
  },

  /** Written by the deploy so the footer and /health can name the build. */
  version: readVersion(),
};

function readVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

module.exports = config;
