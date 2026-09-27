/**
 * Everything this server is told from outside, read once.
 *
 * Secrets come from the environment only -- see .env.example. Nothing here has
 * a secret default: a missing SESSION_SECRET stops the process at boot rather
 * than signing members in with a key anybody could read in git.
 */

const path = require('path');

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const list = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 5085,
  BASE_URL: trimSlash(process.env.BASE_URL || 'https://metric.vesopa.com'),

  DB: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vesopa_metricdb',
  },

  // Continue with Vesopa. One public client (PKCE, no secret) serves the
  // member app on every platform and the staff console, the way the loyalty
  // app's client does -- vesopa_auth/schema/schema_025_metric_client.sql.
  AUTH_ISSUER: trimSlash(process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com'),
  AUTH_CLIENT_ID: process.env.VESOPA_METRIC_CLIENT_ID || '',
  AUTH_CLIENT_SECRET: process.env.VESOPA_METRIC_CLIENT_SECRET || '',

  // Signs member and staff sessions.
  SESSION_SECRET: process.env.SESSION_SECRET || '',

  // Who may open the staff console. Everyone else who signs in is a member.
  ADMIN_EMAILS: list(process.env.METRIC_ADMIN_EMAILS),

  // A new member's cars open nothing until Metric approves them, unless this
  // is on. A car park is not a thing to let anybody with an account into.
  AUTO_APPROVE: String(process.env.METRIC_AUTO_APPROVE || 'false') === 'true',
  // How many cars one membership may carry, unless a plan says otherwise.
  DEFAULT_MAX_VEHICLES: Number(process.env.METRIC_MAX_VEHICLES) || 3,

  // Allow-list sync to the cameras: how often the full list is reconciled.
  SYNC_EVERY_MS: Number(process.env.METRIC_SYNC_EVERY_MS) || 5 * 60 * 1000,
  SCHEDULER: String(process.env.METRIC_SCHEDULER || 'on') !== 'off',

  // The activity log (every press and change, for fault finding).
  LOG_DIR: process.env.LOG_DIR || path.join(__dirname, '..', 'logs'),
  LOG_KEEP_DAYS: Number(process.env.LOG_KEEP_DAYS) || 90,

  // Where the Flutter web build is served from (MetricMembership/app, flutter build web).
  WEB_APP_DIR: process.env.WEB_APP_DIR || path.join(__dirname, '..', 'web_app'),
};

config.isProd = config.NODE_ENV === 'production';

function check() {
  const missing = [];
  if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (32+ characters)');
  if (!config.AUTH_CLIENT_ID) missing.push('VESOPA_METRIC_CLIENT_ID');
  if (config.isProd && missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  return missing;
}

module.exports = config;
module.exports.check = check;
