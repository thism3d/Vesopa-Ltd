/**
 * admin.vesopa.com (2026-10-05): one place to run every Vesopa app, venue,
 * licence and admin. See /mnt/project-files/plans/admin-vesopa-plan.md and
 * README.md.
 */
// override: this app's .env wins over whatever pm2's daemon carries (PORT=20003
// and other apps' settings have leaked in that way before on the box).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true, quiet: true });

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { router } = require('./routes');
const scheduler = require('./scheduler');

function build() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self' https://auth.vesopa.com; frame-ancestors 'none'",
      ...(config.production ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(cookieParser());
  app.use(router);
  app.use((req, res) => res.status(404).render('noaccess', { me: null, flash: null, title: 'Not found', body: 'There is nothing at this address.', path: req.path }));
  app.use((err, req, res, _next) => {
    console.error('[error]', err);
    res.status(500).render('noaccess', { me: null, flash: null, title: 'Something went wrong', body: 'That did not work. Try again, and if it keeps happening, tell Vesopa.', path: req.path });
  });
  return app;
}

if (require.main === module) {
  const app = build();
  app.listen(config.PORT, '127.0.0.1', () => console.log(`admin.vesopa.com listening on ${config.PORT}`));
  scheduler.start();
}

module.exports = { build };
