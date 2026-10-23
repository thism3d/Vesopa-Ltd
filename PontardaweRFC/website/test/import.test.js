'use strict';

// News from screenshots: each club post in them becomes a draft with the
// club's own words, its photo and a credit; never published by itself; other
// accounts' posts and posts already on the site are left out; the
// screenshots are kept for the editor only. The AI is stood in for.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DEEPSEEK_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.WRU_OFF = '1';
process.env.VENUE_API_OFF = '1';
process.env.AUTONEWS_OFF = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prfc-import-'));
process.env.ADMIN_SETUP_CODE = 'code-123456';

const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const app = require('../src/server');
const posts = require('../src/posts');
const screens = require('../src/screen_import');

const WORDS = 'Huge thanks to everyone who came to the quiz night on Friday! Over £600 raised for the juniors.\n\nNext quiz is on Friday 4th December at 8pm in the clubhouse.';
let asked = null;
let answer = null;
screens.useClient({
  enabled: true,
  chat: async (req) => {
    asked = req;
    return { content: JSON.stringify(answer) };
  },
});

let base;
let server;
let cookie = '';
let csrf = '';
async function go(url, { form, body, headers = {} } = {}) {
  const r = await fetch(base + url, {
    method: form || body ? 'POST' : 'GET',
    redirect: 'manual',
    headers: { origin: base, cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: form ? new URLSearchParams(form) : body,
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  return r;
}
const shot = (color) => sharp({ create: { width: 1080, height: 2340, channels: 3, background: color } })
  .composite([{ input: { create: { width: 1080, height: 1080, channels: 3, background: '#2a6' } }, left: 0, top: 500 }]).png().toBuffer();

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await go('/admin/setup', { form: { code: 'code-123456', name: 'Chair', email: 'c@p.test', password: 'long-password-1' } });
  csrf = (await (await go('/admin/import')).text()).match(/data-csrf="([^"]+)"/)[1];
});
test.after(() => server.close());

async function upload(n = 2) {
  const fd = new FormData();
  for (let i = 0; i < n; i += 1) fd.append('shots', new Blob([await shot(i ? '#eee' : '#fff')], { type: 'image/png' }), `Screenshot_${i}.png`);
  return go(`/admin/import?_csrf=${encodeURIComponent(csrf)}`, { body: fd });
}

let draft;
test('the club\'s post becomes a draft: its words as written, its photo, the event its words give, a credit', async () => {
  answer = {
    posts: [{
      screens: [0], network: 'facebook', account: 'Pontardawe RFC', text: WORDS, posted: posts.nowUK().slice(0, 10),
      photo: { screen: 0, box: [0, 500 / 2340, 1, 1580 / 2340] },
      event: { date: '2026-12-04', time: '20:00', place: 'the clubhouse' }, category: 'event', tags: ['quiz night', 'juniors', 'Cardiff'],
    }],
    others: [{ screens: [1], account: 'WRU' }],
  };
  const r = await upload();
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.match(html, /One draft/);
  assert.match(html, /Not the club's own posts, so left out: WRU/);
  assert.strictEqual(asked.messages[1].content.filter((c) => c.type === 'image_url').length, 2, 'both screenshots read');
  draft = posts.all().find((p) => p.origin === 'import');
  assert.strictEqual(draft.status, 'draft');
  assert.strictEqual(draft.title, 'Huge thanks to everyone who came to the quiz night on Friday!');
  assert.match(draft.html, /<p>Over £600 raised for the juniors\.<\/p>|Over £600 raised for the juniors\./);
  assert.match(draft.html, /<p>Next quiz is on Friday 4th December at 8pm in the clubhouse\.<\/p>/);
  assert.match(draft.html, /First posted on the club's <a href="https:\/\/www.facebook.com\/PontardaweRFC\/"[^>]*>Facebook page<\/a>/);
  assert.deepStrictEqual(draft.tags, ['quiz night', 'juniors', 'Facebook'], 'only tags made of the post\'s own words');
  assert.strictEqual(draft.event.start, '2026-12-04T20:00');
  assert.match(draft.image, /^u\//, 'the photo cut from the screenshot');
  const meta = posts.images()[draft.image];
  assert.ok(meta.w >= 1000 && Math.abs(meta.w - meta.h) < 40, 'the square photo, not the whole screen');
  assert.strictEqual(draft.screens.length, 1, 'the WRU screenshot is not kept');
  assert.strictEqual(fs.readdirSync(path.join(process.env.DATA_DIR, 'screens')).length, 1);
  assert.strictEqual((await fetch(`${base}/news/${draft.slug}`)).status, 404, 'not on the site until published');
});

test('the editor shows the screenshot to check against; nobody else can see it', async () => {
  const page = await (await go(`/admin/posts/${draft.id}`)).text();
  assert.match(page, /Check against the screenshots/);
  const src = page.match(/src="(\/admin\/screens\/[^"]+)"/)[1];
  assert.strictEqual((await go(src)).status, 200);
  assert.strictEqual((await fetch(base + src, { redirect: 'manual' })).status, 303, 'signed out: off to sign in');
  assert.strictEqual((await fetch(`${base}/admin/screens/..%2Fposts.json`, { redirect: 'manual' })).status, 303);
});

test('the same post again is left out; an event date not in the words is dropped; another account is never imported', async () => {
  answer = { posts: [{ screens: [0], network: 'instagram', account: 'pontardawerfc', text: WORDS.replace('\n\n', '\n'), category: 'club' }], others: [] };
  const again = await (await upload(1)).text();
  assert.match(again, /Already on the site, so left out/);
  answer = { posts: [
    { screens: [0], network: 'instagram', account: 'pontardawerfc', text: 'Training is back on Tuesday night, all welcome. Bring boots!', event: { date: '2026-11-17', time: null }, category: 'club' },
    { screens: [0], network: 'facebook', account: 'Penlan RFC', text: 'Great game against Pontardawe on Saturday, well played all.' },
  ], others: [] };
  const r = await (await upload(1)).text();
  assert.match(r, /One draft/);
  assert.match(r, /left out: Penlan RFC/);
  const p = posts.all().find((x) => x.title.startsWith('Training is back'));
  assert.strictEqual(p.event, null, '17 is not in the words');
  assert.ok(p.tags.includes('Instagram'));
  assert.ok(!posts.all().some((x) => /well played all/.test(x.html)));
});

test('a form without its token, or signed out, is refused', async () => {
  const fd = new FormData();
  fd.append('shots', new Blob([await shot('#fff')], { type: 'image/png' }), 's.png');
  assert.strictEqual((await go('/admin/import', { body: fd })).status, 403);
  assert.strictEqual((await fetch(`${base}/admin/import`, { method: 'POST', body: fd })).status, 401);
});

test('deleting the draft lets its screenshot go', async () => {
  posts.remove(draft.id);
  screens.sweepScreens();
  assert.ok(!fs.readdirSync(path.join(process.env.DATA_DIR, 'screens')).includes(draft.screens[0]));
});
