'use strict';

// Every page renders with its title and share card, the machine files are
// well formed, old addresses redirect, and the helper answers from the FAQ
// with no AI key set.
process.env.DEEPSEEK_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.WRU_OFF = '1';
process.env.WRU_ORG_ID = '165'; // test fixtures' id for the club
process.env.VENUE_API_OFF = '1';
process.env.AUTONEWS_OFF = '1';
// Posts are copied into a store of their own for each run (src/posts.js).
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'prfc-site-'));

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');
const { news, xPosts, updates } = require('../src/content');
const wru = require('../src/wru');
const venue = require('../src/venue_api');

// A season as the WRU sends it (shapes from api.wru.wales, 2026-10-11).
const team = (org, name, score) => ({ orgId: org, organisationName: name, childValue: '1st Team', score, organisationLogoUrl: `https://public.wru.wales/organisation/logos/${name}.png` });
const raw = [
  { fixtureId: 1, homeTeam: team(165, 'Loughor RFC', 0), awayTeam: team(303, 'Penlan RFC', 0), date: '2099-10-17T14:30:00', competitionName: 'WRU Men’s National League', status: 'UPCOMING' },
  { fixtureId: 2, homeTeam: team(119, 'Baglan RFC', 0), awayTeam: team(165, 'Loughor RFC', 0), date: '2099-10-31T14:30:00', competitionName: 'WRU Men’s National League', status: 'UPCOMING' },
  { fixtureId: 3, homeTeam: team(165, 'Loughor RFC', 41), awayTeam: team(153, 'Banwen RFC', 69), date: '2026-10-03T14:30:00', competitionName: 'WRU Men’s National Knockout Competitions', status: 'PLAYED' },
  { fixtureId: 4, homeTeam: team(165, 'Loughor RFC', 0), awayTeam: team(1, 'Brynamman RFC', 0), date: '2026-09-20T00:00:00', competitionName: null, status: 'PLAYED' },
].map(wru.shape);
wru.set({
  upcoming: raw.filter((f) => f.status === 'UPCOMING'),
  results: raw.filter((f) => f.status === 'PLAYED' && f.competition),
  table: { name: 'WRU Men’s National League, 4 West Central', season: '2026/2027', rows: [{ pos: 1, team: 'Cefn Cribbwr RFC', p: 3, w: 3, d: 0, l: 0, pd: 73, pts: 14, us: false }, { pos: 9, team: 'Loughor RFC', p: 2, w: 0, d: 0, l: 2, pd: -71, pts: 1, us: true }] },
  updated: '2026-10-11T01:00:00Z',
});

let base;
let server;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const PAGES = ['/', '/whats-on', '/play', '/licences', '/club', '/teams', '/fixtures', '/tickets', '/news', '/clubhouse', '/membership', '/contact',
  '/privacy', '/cookies', '/ordering-terms', '/accessibility', ...news.map((n) => `/news/${n.slug}`)];

for (const p of PAGES) {
  test(`page ${p}`, async () => {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.match(html, /<title>[^<]*Loughor RFC[^<]*<\/title>/);
    // The page's own share picture, or (a post with no photo) the card drawn for it (src/news_card.js).
    assert.match(html, /<meta property="og:image" content="https:\/\/loughorrfc\.site\/img\/(og-[a-z]+|c\/[0-9a-f]{12})\.jpg/);
    assert.match(html, /<link rel="canonical"/);
    assert.match(html, /\/js\/site\.js/);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no leaked undefined');
    for (const m of html.matchAll(/(?:src|href)="(\/(?:img|css|js|fonts)\/[^"?]+)/g)) {
      const a = await fetch(base + m[1]);
      assert.strictEqual(a.status, 200, `asset ${m[1]} on ${p}`);
    }
  });
}

test('the menu is on menu.loughorrfc.site, and /menu goes there', async () => {
  const r = await fetch(`${base}/menu`, { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://menu.loughorrfc.site/');
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /href="https:\/\/menu\.loughorrfc\.site\/"/);
  assert.ok(!/href="\/menu"/.test(home), 'no link to the old /menu page');
});

test('sitemap, robots, llms.txt, feed, manifest', async () => {
  const sm = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.ok(!/loughorrfc\.site\/menu</.test(sm));
  // Only this host's pages; the other two sites are in the index.
  assert.ok(!/member\.loughorrfc\.site/.test(sm));
  assert.match(sm, /<loc>https:\/\/loughorrfc\.site\/fixtures<\/loc><lastmod>[\d-]+<\/lastmod><changefreq>daily<\/changefreq><priority>0\.9<\/priority>/);
  const idx = await (await fetch(`${base}/sitemap-index.xml`)).text();
  for (const host of ['loughorrfc.site', 'menu.loughorrfc.site', 'member.loughorrfc.site']) {
    assert.ok(idx.includes(`<loc>https://${host}/sitemap.xml</loc>`), host);
  }
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Sitemap: https:\/\/loughorrfc\.site\/sitemap\.xml/);
  assert.match(await (await fetch(`${base}/llms.txt`)).text(), /Founded: 1882/);
  assert.match(await (await fetch(`${base}/news/feed.xml`)).text(), /<rss/);
  const mf = await (await fetch(`${base}/site.webmanifest`)).json();
  assert.strictEqual(mf.icons.length, 3);
});

test('old addresses redirect', async () => {
  const r = await fetch(`${base}/contact-us/`, { redirect: 'manual' });
  assert.strictEqual(r.status, 301);
  assert.strictEqual(r.headers.get('location'), '/contact');
  const w = await new Promise((resolve, reject) => {
    require('http').get(`${base}/club`, { headers: { host: 'www.loughorrfc.site' } }, resolve).on('error', reject);
  });
  assert.strictEqual(w.statusCode, 301);
  assert.strictEqual(w.headers.location, 'https://loughorrfc.site/club');
  w.resume();
});

test('unknown page is a 404 page', async () => {
  const r = await fetch(`${base}/nope`);
  assert.strictEqual(r.status, 404);
  assert.match(await r.text(), /<title>/);
});

test('helper answers from the FAQ without a key', async () => {
  const r = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: 'Where is the clubhouse?', history: [] }),
  });
  const body = await r.json();
  assert.strictEqual(body.source, 'faq');
  assert.match(body.answer, /Belgrave/);
  for (const [q, want] of [['phone number?', /894109/], ['How do I join?', /member/], ['Can I order food?', /Menu/]]) {
    const a = await (await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) })).json();
    assert.match(a.answer, want, q);
  }
  const empty = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(empty.status, 400);
});

test('fixtures: the WRU season from the club side, next match, table and tickets', async () => {
  assert.deepStrictEqual(raw.map((f) => [f.home, f.opponent, f.result]), [
    [true, 'Penlan RFC', null], [false, 'Baglan RFC', null], [true, 'Banwen RFC', 'L'], [true, 'Brynamman RFC', 'D']]);
  assert.strictEqual(raw[3].kickoff, null);
  const html = await (await fetch(`${base}/fixtures`)).text();
  assert.match(html, /Loughor <span class="vs">v<\/span> Penlan RFC/);
  assert.match(html, /data-countdown="2099-10-17T14:30:00"/);
  assert.match(html, /<b>L<\/b> 41–69/);
  assert.match(html, /<tr class="us">/);
  assert.match(html, /href="\/tickets#m-1"/);
  assert.ok(!/href="\/tickets#m-2"/.test(html), 'no tickets for an away game');
  assert.match(html, /"@type":"SportsEvent"/);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /class="next-match"/);
  const tickets = await (await fetch(`${base}/tickets`)).text();
  assert.match(tickets, /id="m-1"/);
  assert.ok(!/id="m-2"/.test(tickets), 'only home matches on the tickets page');
  assert.match(tickets, /Pay on the gate on match day/);
});

test('news shows every saved X post, and no X section without any', async () => {
  const html = await (await fetch(`${base}/news`)).text();
  assert.strictEqual((html.match(/class="x-post/g) || []).length, xPosts.length);
  if (!xPosts.length) assert.ok(!/class="section x-archive"/.test(html));
});

test('the club email is the new address on every page', async () => {
  const html = await (await fetch(`${base}/contact`)).text();
  assert.match(html, /info@loughorrfc\.site/);
  assert.ok(!/hotmail/.test(html));
});

test('the kick-off opening never hides the page; menu drawn in the page', async () => {
  const home = await (await fetch(`${base}/`)).text();
  // Shown only when the head script turns it on: once a visit, never for a
  // crawler or reduced motion, and lifted by a timer even with no motion.js.
  assert.match(home, /<div class="kick" data-kick aria-hidden="true">/);
  assert.match(home, /sessionStorage\.getItem\('prfc-kick'\)/);
  assert.match(home, /setTimeout\(function\(\)\{d\.classList\.remove\('kick-on'\)\},6500\)/);
  const css = await (await fetch(`${base}/css/motion.css`)).text();
  assert.match(css, /^\.kick \{ display: none; \}$/m);
  assert.match(css, /--T: 5\.2s;/);
  assert.match(home, /data-kick-skip/);
  assert.match(home, /type="speculationrules"/);
});

test('tickets: events on sale with a form, buying goes to card payment, the order shows the tickets', async () => {
  venue.set('events', { events: [{
    id: 5, title: 'Loughor v Penlan', kind: 'match', starts_at: '2099-10-17T14:30', location: 'Villa Field', on_sale: 1, wru_fixture_id: 1,
    ticket_types: [{ id: 11, name: 'Adult', price_minor: 800, remaining: null, max_per_order: 6 }, { id: 12, name: 'Under 16', price_minor: 0, remaining: 0, max_per_order: 6 }],
  }] });
  const html = await (await fetch(`${base}/tickets`)).text();
  assert.match(html, /id="e-5"/);
  assert.match(html, /name="qty_11"/);
  assert.ok(!/name="qty_12"/.test(html), 'sold-out types are not offered');
  assert.match(html, /£8\.00/);

  const post = (body) => fetch(`${base}/tickets/buy`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  let r = await post({ event_id: '5', qty_11: '0', name: 'Sam', email: 'sam@example.com' });
  assert.strictEqual(r.status, 400);
  assert.match(await r.text(), /Choose how many tickets/);
  r = await post({ event_id: '5', qty_11: '2', name: 'Sam', email: 'not-an-email' });
  assert.match(await r.text(), /check your email/);

  const sent = [];
  const real = { checkout: venue.checkout, order: venue.order };
  venue.checkout = async (b) => { sent.push(b); return { ok: true, status: 200, data: { order_id: 'abc', pay_url: 'https://pay.dojo.tech/checkout/pi_1' } }; };
  r = await post({ event_id: '5', qty_11: '2', name: 'Sam Jones', email: 'sam@example.com' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get('location'), 'https://pay.dojo.tech/checkout/pi_1');
  assert.deepStrictEqual(sent[0].items, [{ ticket_type_id: 11, qty: 2 }]);
  assert.strictEqual(sent[0].return_url, 'https://loughorrfc.site/tickets/order');

  venue.order = async () => ({ ok: true, status: 200, data: { status: 'paid', name: 'Sam Jones', event: { title: 'Loughor v Penlan', starts_at: '2099-10-17T14:30' }, tickets: [{ code: 'ABCDE12345', type: 'Adult', holder: 'Sam Jones' }] } });
  const done = await (await fetch(`${base}/tickets/order?order=abc`)).text();
  assert.match(done, /Your tickets/);
  assert.match(done, /ticket\/ABCDE12345\.svg/);
  assert.match(done, /noindex/);
  Object.assign(venue, real);
  venue.set('events', null);
});

test('the club app: store badges on every page, and /app sends each phone to its own store', async () => {
  for (const p of ['/', '/news', '/contact']) {
    const html = await (await fetch(`${base}${p}`)).text();
    assert.match(html, /Download on the App Store/);
    assert.match(html, /href="https:\/\/member\.loughorrfc\.site\/"/);
    assert.match(html, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.vesopaepos\.loughorrfc"/);
  }
  const go = (ua) => fetch(`${base}/app`, { redirect: 'manual', headers: { 'User-Agent': ua } }).then((r) => r.headers.get('location'));
  assert.strictEqual(await go('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'https://member.loughorrfc.site/');
  assert.strictEqual(await go('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'https://play.google.com/store/apps/details?id=com.vesopaepos.loughorrfc');
  assert.strictEqual(await go('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), '/membership#app');
});

test("the club's updates: What's On and a page for each", async () => {
  for (const u of updates) assert.ok(u.slug && u.title, `${u.slug} has a title`);
  const html = await (await fetch(`${base}/whats-on`)).text();
  assert.match(html, /<h1 class="reveal">What&#39;s On<\/h1>/);
  if (!updates.length) assert.match(html, /Nothing announced just yet/);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /href="\/whats-on"/);
  assert.match(home, /class="hero-match/);
  assert.match(home, /data-hero-canvas/);
  const map = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(map, /\/whats-on<\/loc>/);
  assert.strictEqual((await fetch(`${base}/events`, { redirect: 'manual' })).status, 301);
});

test('find us: an opt-in satellite map, directions for each device, what the club offers', async () => {
  const r = await fetch(`${base}/`);
  assert.match(r.headers.get('content-security-policy'), /frame-src https:\/\/www\.google\.com/);
  const home = await r.text();
  assert.match(home, /data-sat-map/);
  assert.match(home, /data-src="https:\/\/www\.google\.com\/maps\/embed\?origin=mfe&amp;pb=[^"]*!5e1/, 'satellite, and only when asked');
  assert.ok(!/<iframe/.test(home), 'nothing from Google until the visitor presses the button');
  assert.match(home, /class="btn btn-glow dir-apple" href="https:\/\/maps\.apple\.com\/\?daddr=51\.6627,-4\.0655/);
  assert.match(home, /class="btn btn-glow dir-google" href="https:\/\/www\.google\.com\/maps\/dir\/\?api=1&amp;destination=51\.6627,-4\.0655/);
  assert.match(home, /class="offers"/);
  assert.match(home, /Members&#39; bar/);
  const cookies = await (await fetch(`${base}/cookies`)).text();
  assert.match(cookies, /Show satellite view/);
});
