/**
 * menu.vesopa.com — where every venue's QR menu lives now.
 *
 *   https://menu.vesopa.com/                the public page: what it is, the demo, prices
 *   https://menu.vesopa.com/<venue>         a venue's menu (e.g. /vesopakitchen)
 *   https://menu.vesopa.com/t/<code>        a table
 *   https://menu.vesopa.com/app/<venue>/    the old loyalty address, sent on to loyalty.vesopa.com
 *
 * THE OLD ADDRESS IS PERMANENTLY MOVED. menu.vesopaepos.com is printed on
 * table cards, laminated, stuck to windows and baked into QR codes, so it
 * never stops answering — but it answers with a 301 to the same path on the
 * new host, for every path, query string included. A table code scanned off
 * a two-year-old card lands on the table it always did.
 *
 * This is the same process as the back office; the gate goes first, before
 * any route, so nothing old can answer on the old name by accident. The
 * loyalty gate runs before it and takes /app/<venue>/ to loyalty.vesopa.com
 * itself, which is where those went already.
 *
 * MENU_HOST names the new host; OLD_MENU_HOSTS the ones being retired
 * (comma-separated). With no OLD_MENU_HOSTS set, nothing is redirected and
 * the behaviour is exactly as before the move.
 */

const MENU_HOST = String(process.env.MENU_HOST || 'menu.vesopaepos.com').trim().toLowerCase();
const OLD_MENU_HOSTS = String(process.env.OLD_MENU_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  .filter((h) => h !== MENU_HOST);

function hostOf(req) {
  const raw = req.headers['x-forwarded-host'] || req.headers.host || '';
  return String(raw).split(',')[0].trim().toLowerCase().split(':')[0];
}

function menuHostGate() {
  return (req, res, next) => {
    if (!OLD_MENU_HOSTS.length) return next();
    const host = hostOf(req);
    const old = OLD_MENU_HOSTS.includes(host) || OLD_MENU_HOSTS.includes(host.replace(/^www\./, ''));
    if (!old) return next();
    // Health stays answerable on any name, for the monitor that has the old one.
    if (req.path === '/health') return next();
    res.set('Cache-Control', 'public, max-age=3600');
    return res.redirect(301, `https://${MENU_HOST}${req.url}`);
  };
}

module.exports = { menuHostGate, MENU_HOST, OLD_MENU_HOSTS, hostOf };
