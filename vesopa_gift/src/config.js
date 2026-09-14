/**
 * Everything this server is told from outside, read once.
 *
 * Secrets come from the environment only -- see .env.example. A missing one is
 * named at boot rather than discovered on the first order.
 */

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

const config = {
  PORT: Number(process.env.PORT) || 5070,
  // Where this server is reached from outside. Every link in every email, and
  // the address Dojo sends a buyer back to, is built from it.
  BASE_URL: trimSlash(process.env.BASE_URL || 'https://gift.vesopaepos.com'),

  // The EPOS it sells for. Loopback on the live box: the back office runs beside
  // this on the same machine, and nothing about the call needs to leave it.
  EPOS_API: trimSlash(process.env.EPOS_API || 'http://127.0.0.1:5060'),
  GIFT_SERVICE_KEY: process.env.GIFT_SERVICE_KEY || '',

  DB: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_giftdb',
  },

  // The staff console's sign-in, with Vesopa Auth.
  AUTH_ISSUER: trimSlash(process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com'),
  AUTH_CLIENT_ID: process.env.VESOPA_AUTH_CLIENT_ID || '',
  AUTH_CLIENT_SECRET: process.env.VESOPA_AUTH_CLIENT_SECRET || '',

  // Signs nothing a browser could forge: sessions are random tokens held in the
  // database. This keys the few HMACs that are carried in URLs.
  SESSION_SECRET: process.env.SESSION_SECRET || '',

  MAIL: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  },

  UPLOADS_DIR: process.env.UPLOADS_DIR || require('path').join(__dirname, '..', 'uploads'),

  NODE_ENV: process.env.NODE_ENV || 'development',
};

config.production = config.NODE_ENV === 'production';
config.required = required;

module.exports = config;
