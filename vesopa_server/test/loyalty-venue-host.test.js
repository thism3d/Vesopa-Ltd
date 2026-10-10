/**
 * A venue's own loyalty app host (loyalty_host.js, 2026-10-10):
 * member.pontardawerfc.com is Pontardawe RFC's app at the root, and the shared
 * addresses send members there.
 *
 *   node test/loyalty-venue-host.test.js
 */
process.env.LOYALTY_HOST = 'loyalty.vesopa.com';
process.env.LOYALTY_VENUE_HOSTS = 'member.pontardawerfc.com=pontardawe-rfc, bad host=x, other.example.com=Not A Slug!';

const assert = require('assert');
const { loyaltyHostGate, appPath, appUrl, venueHostOf, parseVenueHosts } = require('../src/loyalty_host');

const gate = loyaltyHostGate();

/** Run the gate; answers what it did: next (with the rewritten url), or a redirect/send. */
function run(host, url) {
  const req = { url, headers: { host } };
  const out = { req };
  const res = {
    statusCode: 200,
    redirect(code, to) { out.redirect = [code, to]; return this; },
    status(c) { this.statusCode = c; out.status = c; return this; },
    type() { return this; },
    send(body) { out.sent = body; return this; },
  };
  gate(req, res, () => { out.next = req.url; });
  return out;
}

// Parsing keeps only well-formed host=slug pairs.
assert.deepStrictEqual([...parseVenueHosts(process.env.LOYALTY_VENUE_HOSTS)], [['member.pontardawerfc.com', 'pontardawe-rfc']]);

// The root of the venue's host is its app.
let r = run('member.pontardawerfc.com', '/');
assert.strictEqual(r.next, '/app/pontardawe-rfc/');
assert.strictEqual(appPath(r.req, 'pontardawe-rfc'), '/');
assert.strictEqual(venueHostOf(r.req), 'member.pontardawerfc.com');

// The app's files and deep links.
assert.strictEqual(run('member.pontardawerfc.com', '/main.dart.js').next, '/app/pontardawe-rfc/main.dart.js');
assert.strictEqual(run('member.pontardawerfc.com', '/manifest.webmanifest').next, '/app/pontardawe-rfc/manifest.webmanifest');

// The API, uploads and the sign-in callback pass straight through, marked.
r = run('member.pontardawerfc.com', '/loyalty/v1/app/pontardawe-rfc');
assert.strictEqual(r.next, '/loyalty/v1/app/pontardawe-rfc');
r = run('member.pontardawerfc.com', '/app/vesopa/callback?code=1&state=pontardawe-rfc.n');
assert.strictEqual(r.next, '/app/vesopa/callback?code=1&state=pontardawe-rfc.n');
assert.strictEqual(appPath(r.req, 'pontardawe-rfc'), '/', 'callback returns to / on the venue host');
assert.strictEqual(run('member.pontardawerfc.com', '/uploads/a.png').next, '/uploads/a.png');

// The back office is not reachable on this host: it is the app's deep link.
assert.strictEqual(run('member.pontardawerfc.com', '/api/offices').next, '/app/pontardawe-rfc/api/offices');

// Its old paths, typed on the new host, go to the root.
assert.deepStrictEqual(run('member.pontardawerfc.com', '/pontardawe-rfc/?x=1').redirect, [301, '/?x=1']);

// robots and sitemap name the host.
assert.ok(run('member.pontardawerfc.com', '/robots.txt').sent.includes('https://member.pontardawerfc.com/sitemap.xml'));
assert.ok(run('member.pontardawerfc.com', '/sitemap.xml').sent.includes('<loc>https://member.pontardawerfc.com/</loc>'));

// The shared address sends this venue's members to its own host, deep link kept.
assert.deepStrictEqual(run('loyalty.vesopa.com', '/pontardawe-rfc/').redirect, [301, 'https://member.pontardawerfc.com/']);
assert.deepStrictEqual(run('loyalty.vesopa.com', '/pontardawe-rfc').redirect, [301, 'https://member.pontardawerfc.com/']);
// ...and the oldest address too, in one hop.
assert.deepStrictEqual(run('menu.vesopaepos.com', '/app/pontardawe-rfc/?a=b').redirect, [301, 'https://member.pontardawerfc.com/?a=b']);

// Every other venue is exactly as before.
r = run('loyalty.vesopa.com', '/thevesopakitchen/');
assert.strictEqual(r.next, '/app/thevesopakitchen/');
assert.strictEqual(appPath(r.req, 'thevesopakitchen'), '/thevesopakitchen/');
assert.deepStrictEqual(run('menu.vesopaepos.com', '/app/thevesopakitchen/').redirect, [301, 'https://loyalty.vesopa.com/thevesopakitchen/']);
assert.strictEqual(venueHostOf(r.req), null);

// Links that leave the page (emails, notifications, the back office) use the venue's host.
assert.strictEqual(appUrl('pontardawe-rfc'), 'https://member.pontardawerfc.com/');
assert.strictEqual(appUrl('thevesopakitchen'), 'https://loyalty.vesopa.com/thevesopakitchen/');

console.log('loyalty venue host: ok');
