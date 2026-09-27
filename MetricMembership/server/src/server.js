// .env wins over the environment: pm2 hands every app it starts its own
// daemon's environment, and on the live box that carried another app's PORT
// (20003), so Metric listened on the wrong port until restarted.
require('dotenv').config({ override: true });

/**
 * Metric Membership -- a white-label membership for Metric Group, on
 * metric.vesopa.com.
 *
 * Members register their car registrations; Metric's ANPR cameras and
 * barriers let those cars in and out. One process, behind nginx:
 *
 *   /                  the member app (Flutter web build of MetricMembership/app)
 *   /api/v1/...        the member app's API (Windows, Android, iPhone and web)
 *   /anpr/v1/...       what cameras and ANPR back offices call
 *   /admin             Metric's staff console
 *   /auth/callback     Continue with Vesopa comes back here
 *   /health            for the deploy and the monitor
 *
 * The same shape as the loyalty app and its server (vesopa_loyalty,
 * vesopa_server/src/loyalty_app.js), kept in its own process and database
 * because it is one customer's product, not a venue feature.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const activity = require('./activity');
const sync = require('./sync');
const { headers } = require('./security');
const { apiRouter } = require('./api');
const { anprRouter } = require('./anpr');
const { adminPages, adminApi, callback } = require('./admin');
const web = require('./web');
const brand = require('./brand');
const { createActivityLog } = require('./activity_log');
const session = require('./session');

// The shared Vesopa request log (shared/activity-log, synced in by
// tool/sync-activity-log.sh), the same as every other Vesopa service: every
// changing request and every 5xx, to logs/activity/*.jsonl. The Metric-specific
// log of members, cars and barrier reads is src/activity.js.
const requestLog = createActivityLog({
  service: 'vesopa_metric',
  dir: process.env.ACTIVITY_LOG_DIR || path.join(config.LOG_DIR, 'activity'),
});

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(compression());
  app.use(headers);
  app.use(cookieParser());

  app.use(requestLog.middleware({
    // Camera reads (raw bodies, many a minute) and the app's own tap batches
    // are recorded by src/activity.js already.
    skip: (req) => req.path.startsWith('/anpr/') || req.path === '/api/v1/log',
    identify: (req) => {
      const h = String(req.get('authorization') || '');
      const member = session.read(h.startsWith('Bearer ') ? h.slice(7) : '', 'member');
      const admin = session.read(req.cookies && req.cookies.mg_admin, 'admin');
      return {
        app: String(req.get('X-Metric-App') || (admin ? 'metric-console' : 'metric')).slice(0, 40),
        actor: admin ? admin.email : member ? `member ${member.mid}` : null,
        actorType: admin ? 'staff' : member ? 'customer' : 'visitor',
        customerId: member ? String(member.mid) : null,
      };
    },
  }));

  app.get('/health', async (req, res) => {
    try {
      await db.one('SELECT 1 AS ok');
      res.json({ ok: true, app: 'vesopa_metric', web: fs.existsSync(path.join(config.WEB_APP_DIR, 'index.html')) });
    } catch (e) {
      res.status(503).json({ ok: false, error: 'database' });
    }
  });

  // Cameras first: they send XML, multipart and pictures, which the JSON
  // parser below must never see.
  app.use('/anpr/v1', anprRouter());

  app.use(express.json({ limit: '100kb' }));

  app.use('/api/v1', apiRouter());
  app.use('/api/admin', adminApi());
  app.get('/auth/callback', (req, res, next) => callback(req, res).catch(next));
  app.use(adminPages());

  // Written per request from Appearance, so never the build's static copy.
  // Metric's own privacy policy is the one for this app (owner, 2026-09-27).
  app.get(['/privacy', '/privacy/'], (req, res) => res.redirect(302, brand.privacyPolicy));

  app.get(['/manifest.json', '/manifest.webmanifest'], (req, res, next) => web.manifest(req, res).catch(next));

  const PUBLIC = path.join(__dirname, '..', 'public');
  // theme.js is the one public file that must never be cached: it is what
  // carries a new deploy and new colours to an app that is already open.
  app.use(express.static(PUBLIC, {
    index: false,
    maxAge: '1d',
    setHeaders(res, file) {
      if (path.basename(file) === 'theme.js') res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // The member app. Flutter's own files are hashed by name except these,
  // which must never be cached or a deploy is invisible until a hard refresh.
  const NO_CACHE = new Set(['index.html', 'flutter_bootstrap.js', 'flutter_service_worker.js', 'main.dart.js', 'version.json', 'manifest.json']);
  app.use(express.static(config.WEB_APP_DIR, {
    index: false,
    setHeaders(res, file) {
      if (NO_CACHE.has(path.basename(file))) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.get(/^\/(?!api\/|anpr\/|admin).*/, (req, res) => {
    const index = path.join(config.WEB_APP_DIR, 'index.html');
    res.set('Cache-Control', 'no-cache');
    if (fs.existsSync(index)) return res.sendFile(index);
    // No web build on this box yet: say so plainly rather than a blank page.
    res.sendFile(path.join(PUBLIC, 'holding.html'));
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[metric] error:', err && err.stack ? err.stack : err);
    activity.record({ action: 'server.error', req, detail: { path: req.path, error: String(err && err.message) } });
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}

function start() {
  const missing = config.check();
  if (missing.length) console.warn(`[metric] running without: ${missing.join(', ')}`);
  activity.useDb(db);
  const app = createApp();
  app.listen(config.PORT, '127.0.0.1', () => {
    console.log(`[metric] listening on 127.0.0.1:${config.PORT} as ${config.BASE_URL}`);
    activity.record({ action: 'server.started', detail: { port: config.PORT } });
  });
  if (config.SCHEDULER) {
    setTimeout(() => sync.syncAll().catch(() => {}), 5000).unref();
    setInterval(() => sync.syncAll().catch((e) => console.error('[sync]', e.message)), config.SYNC_EVERY_MS).unref();
    setInterval(() => activity.prune().catch(() => {}), 6 * 3600 * 1000).unref();
    requestLog.startMaintenance();
  }
}

if (require.main === module) start();

module.exports = { createApp };
