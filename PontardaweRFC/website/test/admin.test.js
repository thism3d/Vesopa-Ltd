'use strict';

// The news admin (/admin): the first login, signing in, writing, scheduling,
// photos, editing and deleting, and that each post reaches the home page,
// /news, its own page, the feed and the sitemap at once.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DEEPSEEK_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.WRU_OFF = '1';
process.env.VENUE_API_OFF = '1';
process.env.AUTONEWS_OFF = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prfc-admin-'));
process.env.ADMIN_SETUP_CODE = 'test-setup-code-123';

const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const app = require('../src/server');
const posts = require('../src/posts');

let base;
let server;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

/** A browser of sorts: keeps the admin cookie, sends forms from this site. */
function browser() {
  let cookie = '';
  const go = async (url, { method = 'GET', form = null, body = null, headers = {} } = {}) => {
    const r = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { origin: base, ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : body,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
  return { go, csrf: async () => (await (await go('/admin')).text()).match(/data-csrf="([^"]+)"/)[1] };
}

const owner = browser();
const ME = { email: 'chair@pontardawerfc.com', name: 'Chair', password: 'a-long-password-1' };

test('the first login needs the setup code, then the page closes', async () => {
  assert.strictEqual((await owner.go('/admin')).headers.get('location'), '/admin/login?next=%2Fadmin');
  assert.strictEqual((await owner.go('/admin/login')).headers.get('location'), '/admin/setup');
  assert.strictEqual((await owner.go('/admin/setup', { method: 'POST', form: { code: 'wrong', ...ME } })).status, 400);
  const r = await owner.go('/admin/setup', { method: 'POST', form: { code: 'test-setup-code-123', ...ME } });
  assert.strictEqual(r.status, 303);
  assert.match(r.headers.get('location'), /^\/admin/);
  const list = await (await owner.go('/admin')).text();
  assert.match(list, /News posts/);
  assert.match(list, /Ponty Fest/i, 'the shipped posts are in the admin to edit');
  assert.strictEqual((await browser().go('/admin/setup')).headers.get('location'), '/admin/login');
});

test('signing in: wrong passwords are refused, then too many tries wait', async () => {
  const b = browser();
  const bad = await b.go('/admin/login', { method: 'POST', form: { email: ME.email, password: 'nope-nope-nope' } });
  assert.strictEqual(bad.status, 401);
  const good = await b.go('/admin/login', { method: 'POST', form: { email: ME.email, password: ME.password, next: '/admin?show=draft' } });
  assert.strictEqual(good.status, 303);
  assert.strictEqual(good.headers.get('location'), '/admin?show=draft');
  assert.match(good.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(good.headers.get('set-cookie'), /SameSite=Strict/i);
  const c = browser();
  for (let i = 0; i < 8; i += 1) await c.go('/admin/login', { method: 'POST', form: { email: 'x@y.zz', password: 'nope-nope-nope' } });
  assert.strictEqual((await c.go('/admin/login', { method: 'POST', form: { email: 'x@y.zz', password: 'nope-nope-nope' } })).status, 429);
  assert.strictEqual((await c.go('/admin/login', { method: 'POST', form: { email: ME.email, password: ME.password } })).status, 303, 'others at the same place still sign in');
});

test('the admin is never indexed, and a form without its token is refused', async () => {
  const r = await owner.go('/admin');
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/admin/);
  assert.strictEqual((await owner.go('/admin/posts', { method: 'POST', form: { title: 'x', html: '<p>x</p>' } })).status, 403);
  const csrf = await owner.csrf();
  const elsewhere = await owner.go('/admin/posts', { method: 'POST', form: { _csrf: csrf, title: 'x', html: '<p>x</p>' }, headers: { origin: 'https://evil.example' } });
  assert.strictEqual(elsewhere.status, 403);
});

let photo;
test('a photo is made into every size the site uses', async () => {
  const jpg = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#8f0000' } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('photo', new Blob([jpg], { type: 'image/jpeg' }), 'IMG_0001.jpg');
  const csrf = await owner.csrf();
  const r = await owner.go('/admin/upload', { method: 'POST', body: fd, headers: { 'x-csrf-token': csrf } });
  assert.strictEqual(r.status, 200);
  photo = await r.json();
  assert.match(photo.name, /^u\/\d{6}-[a-f0-9]{10}$/);
  assert.strictEqual(photo.w, 1600);
  for (const s of ['.jpg', '.webp', '-480.webp', '-og.jpg']) {
    const f = await fetch(`${base}/img/${photo.name}${s}`);
    assert.strictEqual(f.status, 200, s);
    assert.match(f.headers.get('cache-control'), /immutable/);
  }
  const og = await sharp(Buffer.from(await (await fetch(`${base}/img/${photo.name}-og.jpg`)).arrayBuffer())).metadata();
  assert.deepStrictEqual([og.width, og.height], [1200, 630]);
  const notPhoto = new FormData();
  notPhoto.append('photo', new Blob(['hello'], { type: 'image/jpeg' }), 'x.jpg');
  assert.strictEqual((await owner.go('/admin/upload', { method: 'POST', body: notPhoto, headers: { 'x-csrf-token': csrf } })).status, 400);
});

const story = (extra = {}) => ({
  title: 'Big win at The Rec',
  html: '<p>What a game. <b>Forty points</b> on the board.</p><script>alert(1)</script><p onclick="x()">More <a href="javascript:alert(1)">here</a>.</p>',
  summary: '',
  kind: 'match',
  pub_day: '2026-10-20',
  pub_time: '17:30',
  action: 'publish',
  ...extra,
});

let id;
test('a published post is on the home page, /news, its own page, the feed and the sitemap at once', async () => {
  const csrf = await owner.csrf();
  const r = await owner.go('/admin/posts', { method: 'POST', form: { _csrf: csrf, ...story(), gallery: photo.name, [`alt:${photo.name}`]: 'The team celebrate' } });
  assert.strictEqual(r.status, 303);
  id = r.headers.get('location').match(/\/admin\/posts\/([a-f0-9]+)\?flash=published/)[1];
  const post = posts.get(id);
  assert.strictEqual(post.slug, 'big-win-at-the-rec');
  assert.ok(!/script|onclick|javascript/.test(post.html), 'the story is cleaned');
  assert.match(post.html, /<strong>Forty points<\/strong>/);
  assert.match(post.summary, /^What a game\. Forty points/);
  const page = await (await fetch(`${base}/news/big-win-at-the-rec`)).text();
  assert.match(page, /<h1 class="reveal">Big win at The Rec<\/h1>/);
  assert.match(page, new RegExp(`og:image" content="https://pontardawerfc.com/img/${photo.name}-og.jpg"`));
  assert.match(page, /og:image:alt" content="The team celebrate"/);
  assert.match(page, /"datePublished":"2026-10-20T17:30:00\+01:00"/);
  assert.match(page, /og:type" content="article"/);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /href="\/news\/big-win-at-the-rec"/);
  assert.match(home, new RegExp(`srcset="/img/${photo.name}-480.webp 480w, /img/${photo.name}.webp 1600w"`));
  assert.match(await (await fetch(`${base}/news`)).text(), /href="\/news\/big-win-at-the-rec"/);
  assert.match(await (await fetch(`${base}/news/feed.xml`)).text(), /<link>https:\/\/pontardawerfc.com\/news\/big-win-at-the-rec<\/link>/);
  assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /\/news\/big-win-at-the-rec<\/loc>/);
  assert.match(await (await fetch(`${base}/whats-on`)).text(), /href="\/news\/big-win-at-the-rec"/, 'a Match post is in the season on What\'s On');
});

test('drafts and scheduled posts stay off the site; preview shows a draft', async () => {
  const csrf = await owner.csrf();
  const d = await owner.go('/admin/posts', { method: 'POST', form: { _csrf: csrf, ...story({ title: 'Secret draft', action: 'draft' }) } });
  assert.match(d.headers.get('location'), /flash=draft/);
  const s = await owner.go('/admin/posts', { method: 'POST', form: { _csrf: csrf, ...story({ title: 'Next season kit', pub_day: '2099-01-01', pub_time: '09:00' }) } });
  assert.match(s.headers.get('location'), /flash=scheduled/);
  for (const slug of ['secret-draft', 'next-season-kit']) assert.strictEqual((await fetch(`${base}/news/${slug}`)).status, 404);
  const home = await (await fetch(`${base}/`)).text();
  assert.ok(!/secret-draft|next-season-kit/.test(home));
  const list = await (await owner.go('/admin?show=sched')).text();
  assert.match(list, /Next season kit/);
  assert.ok(!/Secret draft/.test(list));
  const pv = await owner.go('/admin/preview', { method: 'POST', form: { _csrf: csrf, ...story({ title: 'Preview me' }) } });
  const html = await pv.text();
  assert.match(html, /Preview: not saved yet/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.ok(!posts.all().some((p) => p.title === 'Preview me'), 'a preview saves nothing');
});

test('renaming a post keeps its old address; deleting takes it off', async () => {
  const csrf = await owner.csrf();
  const r = await owner.go(`/admin/posts/${id}`, { method: 'POST', form: { _csrf: csrf, ...story({ title: 'Big win at The Rec (report)', slug: 'big-win-report' }), gallery: photo.name } });
  assert.strictEqual(r.status, 303);
  const old = await fetch(`${base}/news/big-win-at-the-rec`, { redirect: 'manual' });
  assert.strictEqual(old.status, 301);
  assert.strictEqual(old.headers.get('location'), '/news/big-win-report');
  assert.strictEqual((await owner.go(`/admin/posts/${id}/delete`, { method: 'POST', form: { _csrf: csrf } })).status, 303);
  assert.strictEqual((await fetch(`${base}/news/big-win-report`)).status, 404);
  assert.ok(!/big-win-report/.test(await (await fetch(`${base}/`)).text()));
});

test('a shipped post can be edited, and stays deleted once deleted', async () => {
  const csrf = await owner.csrf();
  const r = await owner.go('/admin/posts/f-weekly-lotto', { method: 'POST', form: { _csrf: csrf, title: 'Weekly Lotto results', html: '<p>This week: no winner.</p>', kind: 'lotto', pub_day: '2026-10-01', pub_time: '09:00', action: 'publish', slug: 'weekly-lotto' } });
  assert.strictEqual(r.status, 303);
  assert.match(await (await fetch(`${base}/news/weekly-lotto`)).text(), /This week: no winner\./);
  await owner.go('/admin/posts/f-weekly-lotto/delete', { method: 'POST', form: { _csrf: csrf } });
  posts.init([{ slug: 'weekly-lotto', date: '2026-10-01', title: 'Lotto', summary: 's', paragraphs: ['p'] }]);
  assert.ok(!posts.get('f-weekly-lotto'), 'not copied back in on the next start');
});

test('editors: the owner adds one, who can sign in and change their password', async () => {
  const csrf = await owner.csrf();
  const r = await owner.go('/admin/editors', { method: 'POST', form: { _csrf: csrf, name: 'Sec', email: 'sec@pontardawerfc.com', password: 'another-password-2', role: 'editor' } });
  assert.match(await r.text(), /Sec can now sign in/);
  const sec = browser();
  assert.strictEqual((await sec.go('/admin/login', { method: 'POST', form: { email: 'sec@pontardawerfc.com', password: 'another-password-2' } })).status, 303);
  assert.strictEqual((await sec.go('/admin/editors')).status, 403, 'an editor cannot manage editors');
  const c = await sec.csrf();
  const ch = await sec.go('/admin/account', { method: 'POST', form: { _csrf: c, current: 'another-password-2', password: 'third-password-3' } });
  assert.match(await ch.text(), /Password changed/);
  assert.strictEqual((await browser().go('/admin/login', { method: 'POST', form: { email: 'sec@pontardawerfc.com', password: 'another-password-2' } })).status, 401);
  assert.ok(!fs.readFileSync(path.join(process.env.DATA_DIR, 'users.json'), 'utf8').includes('third-password-3'), 'only a hash is kept');
});

test('/news comes in pages of 12', async () => {
  const pages = Math.ceil(require('../src/content').news.length / 12);
  const one = await (await fetch(`${base}/news`)).text();
  assert.strictEqual((one.match(/class="card news-card/g) || []).length, 12);
  assert.match(one, /<link rel="next" href="https:\/\/pontardawerfc.com\/news\?page=2">/);
  assert.strictEqual((await fetch(`${base}/news?page=2`)).status, 200);
  assert.strictEqual((await fetch(`${base}/news?page=1`, { redirect: 'manual' })).status, 301);
  assert.strictEqual((await fetch(`${base}/news?page=${pages + 1}`)).status, 404);
});

test('photos no post uses are removed after a day; used ones stay', async () => {
  const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#c41414' } }).jpeg().toBuffer();
  const up = async () => {
    const fd = new FormData();
    fd.append('photo', new Blob([jpg], { type: 'image/jpeg' }), 'p.jpg');
    return (await owner.go('/admin/upload', { method: 'POST', body: fd, headers: { 'x-csrf-token': await owner.csrf() } })).json();
  };
  const spare = await up();
  const inStory = await up();
  const csrf = await owner.csrf();
  await owner.go('/admin/posts', { method: 'POST', form: { _csrf: csrf, ...story({ title: 'Photo in the story', action: 'draft', html: `<p>Hi</p><figure><img src="/img/${inStory.name}.jpg" alt="x"></figure>` }) } });
  assert.deepStrictEqual(posts.sweepPhotos(), [], 'nothing goes on the day it was uploaded');
  const gone = posts.sweepPhotos({ minAgeMs: 0 });
  assert.ok(gone.includes(spare.name), 'the unused photo goes');
  assert.ok(!gone.includes(inStory.name), 'a photo in a draft\'s story stays');
  assert.strictEqual((await fetch(`${base}/img/${spare.name}.jpg`)).status, 404);
  assert.strictEqual((await fetch(`${base}/img/${inStory.name}.jpg`)).status, 200);
  assert.ok(!posts.images()[spare.name]);
});
