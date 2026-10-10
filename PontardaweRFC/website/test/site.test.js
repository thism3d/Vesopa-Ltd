'use strict';

// Every page renders with its title and share card, the machine files are
// well formed, old addresses redirect, and the helper answers from the FAQ
// with no AI key set.
process.env.DEEPSEEK_API_KEY = '';
process.env.GEMINI_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');
const { news } = require('../src/content');

let base;
let server;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const PAGES = ['/', '/club', '/teams', '/news', '/clubhouse', '/menu', '/membership', '/contact',
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
