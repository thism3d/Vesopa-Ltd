'use strict';

// The automatic news: posts from the WRU's figures only, never twice, never
// stale, the club's own posts left alone, Facebook and Instagram as drafts,
// news stories listed and never posted. The WRU, Meta and Google News are
// stood in for, so nothing here leaves the machine.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DEEPSEEK_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.WRU_OFF = '1';
process.env.VENUE_API_OFF = '1';
process.env.AUTONEWS_OFF = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prfc-auto-'));
process.env.LOG_DIR = process.env.DATA_DIR;

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');
const posts = require('../src/posts');
const wru = require('../src/wru');
const autonews = require('../src/autonews');

const day = (n) => { const d = new Date(Date.now() + n * 864e5); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d); };
const team = (org, name, score, tries) => ({ orgId: org, organisationName: name, childValue: '1st Team', score, tryCount: tries });
const fixture = (id, when, home, away, status = 'PLAYED', comp = 'WRU Men’s National League') => ({ fixtureId: id, homeTeam: home, awayTeam: away, date: `${when}T14:30:00`, competitionName: comp, status });
function season() {
  const results = [
    fixture(901, day(-6), team(165, 'Pontardawe RFC', 18, 2), team(303, 'Penlan RFC', 67, 11)),
    fixture(902, day(-20), team(165, 'Pontardawe RFC', 41, 6), team(153, 'Banwen RFC', 69, 10), 'PLAYED', 'WRU Men’s National Knockout Competitions'),
    fixture(903, day(-3), team(77, 'Crynant (Creunant) RFC', 10, 1), team(165, 'Pontardawe RFC', 24, 4)),
  ].map(wru.shape);
  const upcoming = [fixture(904, day(5), team(119, 'Baglan RFC', 0), team(165, 'Pontardawe RFC', 0), 'UPCOMING')].map(wru.shape);
  wru.set({
    upcoming, results,
    table: { name: 'WRU Men’s National League, 4 West Central', season: '2026/2027', rows: [
      { pos: 3, team: 'Baglan RFC', p: 5, w: 2, d: 0, l: 3, pd: 4, pts: 12, us: false },
      { pos: 10, team: 'Pontardawe RFC', p: 4, w: 0, d: 0, l: 4, pd: -120, pts: 1, us: true },
    ] },
    updated: new Date().toISOString(),
  });
}

// Meta and Google News, stood in for; everything else (the site itself) goes through.
const realFetch = global.fetch;
let meta = null;
let rss = '';
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://graph.facebook.com/')) {
    if (!meta) return new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } }), { status: 400 });
    const p = new URL(u).pathname;
    if (/\/v21\.0\/\d+$/.test(p)) return Response.json({ name: 'Pontardawe RFC', instagram_business_account: { id: '1784' } });
    if (p.endsWith('/posts')) return Response.json({ data: meta.fb });
    if (p.endsWith('/media')) return Response.json({ data: meta.ig });
  }
  if (u.startsWith('https://news.google.com/')) return new Response(rss, { status: 200 });
  if (u === 'https://scontent.example/photo.jpg') {
    const sharp = require('sharp');
    return new Response(await sharp({ create: { width: 900, height: 900, channels: 3, background: '#2a6' } }).jpeg().toBuffer());
  }
  return realFetch(url, opts);
};

let base;
let server;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  season();
});
test.after(() => server.close());

let result;
test('a WRU result becomes a published report with only the WRU figures, on every news page', async () => {
  const log = await autonews.run({ why: 'test' });
  assert.deepStrictEqual(log.errors, []);
  const keys = log.made.map((m) => m.key).sort();
  assert.deepStrictEqual(keys, ['wru-preview-904', 'wru-result-901', 'wru-result-903'], 'the old cup game (20 days) is left out');
  result = posts.get(log.made.find((m) => m.key === 'wru-result-901').id);
  assert.strictEqual(result.status, 'published');
  assert.strictEqual(result.origin, 'auto');
  assert.strictEqual(result.title, `Pontardawe RFC 18–67 Penlan RFC: National League result, ${result.title.split(', ').pop()}`);
  assert.match(result.html, /lost to Penlan RFC at The Rec/);
  assert.match(result.html, /Pontardawe scored 2 tries to Penlan's 11\./);
  assert.match(result.html, /10th with 1 point from 4 games/);
  assert.match(result.html, /travel to Baglan RFC/);
  assert.match(result.html, /Welsh Rugby Union/);
  assert.ok(result.tags.includes('Match report'));
  assert.match(result.image, /^u\//, 'a match card');
  const away = posts.get(log.made.find((m) => m.key === 'wru-result-903').id);
  assert.match(away.title, /^Pontardawe RFC beat Crynant 24–10/);
  assert.match(away.html, /Crynant \(Creunant\) RFC 10–24 Pontardawe RFC/, 'home side first in the score');

  const page = await (await realFetch(`${base}/news/${result.slug}`)).text();
  assert.match(page, /<meta property="article:tag" content="Match report">/);
  assert.match(page, /"keywords":"Match report, First XV/);
  assert.match(page, /og:image" content="https:\/\/pontardawerfc.com\/img\/u\/[^"]+-og.jpg"/);
  const home = await (await realFetch(`${base}/`)).text();
  assert.ok(home.includes(`href="/news/${result.slug}"`), 'on the home page');
  assert.ok((await (await realFetch(`${base}/news`)).text()).includes(`/news/${result.slug}`));
});

test('the preview is an event until the day, so What\'s On shows it', async () => {
  const pv = posts.all().find((p) => p.autoKey === 'wru-preview-904');
  assert.match(pv.title, /^Preview: Baglan v Pontardawe RFC/);
  assert.strictEqual(pv.event.start, `${day(5)}T14:30`);
  assert.match(pv.html, /Baglan RFC are 3rd with 12 points/);
  assert.match(pv.html, /<li>[^<]+: Pontardawe RFC 18–67 Penlan RFC \(National League\)<\/li>/);
  assert.ok((await (await realFetch(`${base}/whats-on`)).text()).includes(`/news/${pv.slug}`));
});

test('never twice, and a deleted post stays deleted', async () => {
  assert.strictEqual((await autonews.run()).made.length, 0);
  posts.remove(result.id);
  assert.strictEqual((await autonews.run()).made.length, 0);
});

test('a match the club posted about itself is left to the club', async () => {
  autonews.reset();
  fs.rmSync(autonews.FILE);
  for (const p of posts.all().filter((x) => x.origin === 'auto')) posts.remove(p.id);
  posts.save({ title: 'Tough day against Penlan', html: '<p>Thanks for the support.</p>', kind: 'match', status: 'published', publishAt: `${day(-5)}T19:00` }, { author: 'Chair' });
  posts.save({ title: 'Away at Baglan next Saturday', html: '<p>Bus at 12.</p>', kind: 'match', status: 'published', event: { day: day(5), time: '14:30' } }, { author: 'Chair' });
  const log = await autonews.run();
  assert.deepStrictEqual(log.made.map((m) => m.key), ['wru-result-903']);
  assert.strictEqual(log.skipped.length, 2);
});

test('set to drafts, a result waits for approval and is not on the site', async () => {
  autonews.settings({ results: 'draft' });
  wru.set({ ...wru.fixtures(), results: [...wru.fixtures().results, wru.shape(fixture(905, day(-1), team(165, 'Pontardawe RFC', 30, 4), team(5, 'Nantymoel RFC', 12, 2)))] });
  const log = await autonews.run();
  assert.deepStrictEqual(log.made.map((m) => [m.key, m.status]), [['wru-result-905', 'draft']]);
  assert.strictEqual((await realFetch(`${base}/news/${log.made[0].slug}`)).status, 404);
  autonews.settings({ results: 'publish' });
});

test('Facebook and Instagram: connected with a token, the club\'s own posts become drafts with their photo, credited', async () => {
  await assert.rejects(autonews.connectMeta('123456789', 'x'.repeat(60)), /Invalid OAuth/);
  const recent = new Date(Date.now() - 2 * 864e5).toISOString();
  const words = 'Huge thanks to everyone who came to the quiz night on Friday! Over £600 raised for the juniors.\n\nNext quiz in December.';
  meta = {
    fb: [
      { id: '1_2', message: words, created_time: recent, permalink_url: 'https://www.facebook.com/PontardaweRFC/posts/2', full_picture: 'https://scontent.example/photo.jpg' },
      { id: '1_3', message: 'Old news from last season, more than two weeks ago now.', created_time: '2026-01-01T10:00:00+0000', permalink_url: 'https://www.facebook.com/x' },
      { id: '1_4', message: 'Short one', created_time: recent },
    ],
    ig: [{ id: '9', caption: words, media_type: 'IMAGE', media_url: 'https://scontent.example/photo.jpg', permalink: 'https://www.instagram.com/p/x/', timestamp: recent }],
  };
  const c = await autonews.connectMeta('123456789', 'x'.repeat(60));
  assert.deepStrictEqual(c, { pageName: 'Pontardawe RFC', instagram: true });
  const log = await autonews.run();
  assert.deepStrictEqual(log.made.map((m) => [m.key, m.status]), [['fb-1_2', 'draft']], 'one draft: old, short and the Instagram copy left out');
  const p = posts.get(log.made[0].id);
  assert.strictEqual(p.title, 'Huge thanks to everyone who came to the quiz night on Friday!');
  assert.match(p.html, /<p>Next quiz in December\.<\/p>/);
  assert.match(p.html, /First posted on the club's <a href="https:\/\/www.facebook.com\/PontardaweRFC\/posts\/2"/);
  assert.match(p.image, /^u\//, 'the club\'s photo, kept here');
  assert.ok(!JSON.stringify(autonews.status()).includes('x'.repeat(60)), 'the token is never shown');
});

test('stories naming the club are listed to read, never posted; a draft can be started from one', async () => {
  const when = new Date(Date.now() - 3 * 864e5).toUTCString();
  rss = `<rss><channel>
<item><title>Pontardawe RFC launch new junior section - South Wales Evening Post</title><link>https://news.example/a</link><pubDate>${when}</pubDate><source url="https://news.example">South Wales Evening Post</source></item>
<item><title>Old story - Wales Online</title><link>https://news.example/b</link><pubDate>Sun, 01 Feb 2026 08:00:00 GMT</pubDate><source>Wales Online</source></item>
</channel></rss>`;
  const before = posts.all().length;
  const log = await autonews.run();
  assert.strictEqual(posts.all().length, before, 'nothing posted');
  const list = autonews.status().mentions;
  assert.deepStrictEqual(list.map((m) => [m.title, m.source]), [['Pontardawe RFC launch new junior section', 'South Wales Evening Post']]);
  assert.match(log.notes[0], /1 new story/);
  const d = autonews.draftFromMention(list[0].id, 'Chair');
  assert.strictEqual(d.status, 'draft');
  assert.match(d.html, /South Wales Evening Post reported on .+: <a href="https:\/\/news.example\/a"/);
  assert.strictEqual(autonews.status().mentions.length, 0);
});

test('the admin page: status, sources and the run log; Check now', async () => {
  process.env.ADMIN_SETUP_CODE = 'code-123456';
  let cookie = '';
  const go = async (url, form) => {
    const r = await realFetch(base + url, { method: form ? 'POST' : 'GET', redirect: 'manual', headers: { origin: base, cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  };
  await go('/admin/setup', { code: 'code-123456', name: 'Chair', email: 'c@p.test', password: 'long-password-1' });
  const page = await (await go('/admin/auto')).text();
  assert.match(page, /Automatic news/);
  assert.match(page, /Connected to <b>Pontardawe RFC<\/b>/);
  assert.match(page, /Published: <a href="\/admin\/posts\//);
  const csrf = page.match(/data-csrf="([^"]+)"/)[1];
  const ran = await (await go('/admin/auto/run', { _csrf: csrf })).text();
  assert.match(ran, /Checked: nothing new to write\./);
  assert.strictEqual((await go('/admin/auto/settings', { _csrf: csrf, previews: 'off', results: 'draft', social: 'publish', mentions: 'off' })).status, 303);
  assert.deepStrictEqual(autonews.settings(), { results: 'draft', previews: 'off', social: 'publish', mentions: 'off' });
});
