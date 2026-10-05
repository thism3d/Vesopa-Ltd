/**
 * Everything admin.vesopa.com is told from outside, read once. Secrets come
 * from the environment only -- see .env.example.
 */
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

const config = {
  // ADMIN_PORT, not PORT: pm2's daemon on the box carries PORT=20003 (Auth's),
  // and dotenv never overrides a variable that is already set.
  PORT: Number(process.env.ADMIN_PORT) || 5095,
  BASE_URL: trimSlash(process.env.BASE_URL || 'https://admin.vesopa.com'),
  NODE_ENV: process.env.NODE_ENV || 'development',

  DB: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_admindb',
  },

  AUTH_ISSUER: trimSlash(process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com'),
  AUTH_CLIENT_ID: process.env.VESOPA_AUTH_CLIENT_ID || '',
  AUTH_CLIENT_SECRET: process.env.VESOPA_AUTH_CLIENT_SECRET || '',

  // "info@vesopasoftware.com Auth account is the admin for everything." (owner)
  OWNER_EMAIL: String(process.env.OWNER_EMAIL || 'info@vesopasoftware.com').trim().toLowerCase(),

  APPS: {
    epos: { base: trimSlash(process.env.EPOS_API || 'http://127.0.0.1:5060'), key: process.env.EPOS_SERVICE_KEY || '' },
    gift: { base: trimSlash(process.env.GIFT_API || 'http://127.0.0.1:5070'), key: process.env.GIFT_SERVICE_KEY || '' },
    hosting: { base: trimSlash(process.env.HOSTING_API || 'http://127.0.0.1:5075'), key: process.env.HOSTING_SERVICE_KEY || '' },
  },

  MAIL: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 25,
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'Vesopa <no-reply@vesopa.com>',
  },
};

config.production = config.NODE_ENV === 'production';

module.exports = config;
