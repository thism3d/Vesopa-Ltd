/**
 * The member app's web build as served at /: which build is live, and the
 * manifest, written for each request from the colours staff chose.
 */
const fs = require('fs');
const path = require('path');

const config = require('./config');
const settings = require('./settings');
const themes = require('./themes');

/** Changes with every deploy of the web build (index.html is rewritten each time). */
function webBuild() {
  try {
    return String(Math.floor(fs.statSync(path.join(config.WEB_APP_DIR, 'index.html')).mtimeMs));
  } catch {
    return 'none';
  }
}

const FALLBACK = {
  name: 'Metric Membership',
  short_name: 'Metric',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  icons: [],
};

/**
 * GET /manifest.json. The build's own manifest (app/web/manifest.json) with
 * theme_color and background_color from Appearance, and never cached, so an
 * installed app picks a change up the next time it opens.
 */
async function manifest(req, res) {
  let base = FALLBACK;
  try {
    base = JSON.parse(fs.readFileSync(path.join(config.WEB_APP_DIR, 'manifest.json'), 'utf8'));
  } catch { /* no web build yet */ }
  const t = themes.resolve(await settings.all());
  res.set('Cache-Control', 'no-store');
  res.type('application/manifest+json');
  res.send(JSON.stringify({ ...base, id: '/', theme_color: t.top, background_color: t.bottom, display_override: ['standalone', 'minimal-ui'] }, null, 2));
}

module.exports = { webBuild, manifest };
