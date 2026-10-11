'use strict';

// Every page renders with its title and share card, the machine files are
// well formed, old addresses redirect, and the helper answers from the FAQ
// with no AI key set.
process.env.DEEPSEEK_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.WRU_OFF = '1';

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');
const { news, xPosts } = require('../src/content');
const wru = require('../src/wru');

// A season as the WRU sends it (shapes from api.wru.wales, 2026-10-11).
const team = (org, name, score) => ({ orgId: org, organisationName: name, childValue: '1st Team', score, organisationLogoUrl: `https://public.wru.wales/organisation/logos/${name}.png` });
const raw = [
  { fixtureId: 1, homeTeam: team(165, 'Pontardawe RFC', 0), awayTeam: team(303, 'Penlan RFC', 0), date: '2099-10-17T14:30:00', competitionName: 'WRU Men’s National League', status: 'UPCOMING' },
  { fixtureId: 2, homeTeam: team(119, 'Baglan RFC', 0), awayTeam: team(165, 'Pontardawe RFC', 0), date: '2099-10-31T14:30:00', competitionName: 'WRU Men’s National League', status: 'UPCOMING' },
  { fixtureId: 3, homeTeam: team(165, 'Pontardawe RFC', 41), awayTeam: team(153, 'Banwen RFC', 69), date: '2026-10-03T14:30:00', competitionName: 'WRU Men’s National Knockout Competitions', status: 'PLAYED' },
  { fixtureId: 4, homeTeam: team(165, 'Pontardawe RFC', 0), awayTeam: team(1, 'Brynamman RFC', 0), date: '2026-09-20T00:00:00', competitionName: null, status: 'PLAYED' },
].map(wru.shape);
wru.set({
  upcoming: raw.filter((f) => f.status === 'UPCOMING'),
  results: raw.filter((f) => f.status === 'PLAYED' && f.competition),
  table: { name: 'WRU Men’s National League, 4 West Central', season: '2026/2027', rows: [{ pos: 1, team: 'Cefn Cribbwr RFC', p: 3, w: 3, d: 0, l: 0, pd: 73, pts: 14, us: false }, { pos: 9, team: 'Pontardawe RFC', p: 2, w: 0, d: 0, l: 2, pd: -71, pts: 1, us: true }] },
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

const PAGES = ['/', '/club', '/teams', '/fixtures', '/tickets', '/news', '/clubhouse', '/menu', '/membership', '/contact',
  '/privacy', '/cookies', '/ordering-terms', '/accessibility', ...news.map((n) => `/news/${n.slug}`)];

for (const p of PAGES) {
  test(`page ${p}`, async () => {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.match(html, /<title>[^<]*Pontardawe RFC[^<]*<\/title>/);
    assert.match(html, /<meta property="og:image" content="https:\/\/pontardawerfc\.com\/img\/og-[a-z]+\.jpg/);
    assert.match(html, /<link rel="canonical"/);
    assert.match(html, /\/js\/site\.js/);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no leaked undefined');
    for (const m of html.matchAll(/(?:src|href)="(\/(?:img|css|js|fonts)\/[^"?]+)/g)) {
      const a = await fetch(base + m[1]);
      assert.strictEqual(a.status, 200, `asset ${m[1]} on ${p}`);
    }
  });
}

test('menu page wires the ordering script', async () => {
  const html = await (await fetch(`${base}/menu`)).text();
  assert.match(html, /data-api="https:\/\/menu\.vesopa\.com"/);
  assert.match(html, /data-slug="pontardawe-rfc"/);
  assert.match(html, /\/js\/order\.js/);
});

test('sitemap, robots, llms.txt, feed, manifest', async () => {
  const sm = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sm, /<loc>https:\/\/pontardawerfc\.com\/menu<\/loc>/);
  assert.match(sm, /<loc>https:\/\/member\.pontardawerfc\.com\/<\/loc>/);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Sitemap: https:\/\/pontardawerfc\.com\/sitemap\.xml/);
  assert.match(await (await fetch(`${base}/llms.txt`)).text(), /Founded: 1881/);
  assert.match(await (await fetch(`${base}/news/feed.xml`)).text(), /<rss/);
  const mf = await (await fetch(`${base}/site.webmanifest`)).json();
  assert.strictEqual(mf.icons.length, 3);
});

test('old addresses redirect', async () => {
  const r = await fetch(`${base}/contact-us/`, { redirect: 'manual' });
  assert.strictEqual(r.status, 301);
  assert.strictEqual(r.headers.get('location'), '/contact');
  const w = await new Promise((resolve, reject) => {
    require('http').get(`${base}/club`, { headers: { host: 'www.pontardawerfc.com' } }, resolve).on('error', reject);
  });
  assert.strictEqual(w.statusCode, 301);
  assert.strictEqual(w.headers.location, 'https://pontardawerfc.com/club');
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
  assert.match(body.answer, /Ynysderw/);
  for (const [q, want] of [['phone number?', /864811/], ['How do I join?', /member/], ['Can I order food?', /Menu/], ['who coaches', /Nathan/]]) {
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
  assert.match(html, /Pontardawe <span class="vs">v<\/span> Penlan RFC/);
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
  assert.match(tickets, /\/js\/tickets\.js/);
});

test('news shows every saved X post, links made safe', async () => {
  const html = await (await fetch(`${base}/news`)).text();
  assert.ok(xPosts.length >= 15);
  assert.strictEqual((html.match(/class="x-post/g) || []).length, xPosts.length);
  assert.match(html, /<a href="http:\/\/pontardawerfc\.co\.uk" rel="noopener nofollow">pontardawerfc\.co\.uk<\/a>/);
  assert.match(html, /Pontardawe RFC 24 - 0 Cefn Cribbwr/);
});

test('the club email is the new address on every page', async () => {
  const html = await (await fetch(`${base}/contact`)).text();
  assert.match(html, /info@pontardawerfc\.com/);
  assert.ok(!/hotmail/.test(html));
});
