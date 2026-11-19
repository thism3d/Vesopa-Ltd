/**
 * Blog tags are pages of their own (owner, 2026-11-19: Search Console listed
 * 47 /blog?tag=... addresses as "Alternate page with proper canonical", none
 * indexed). /blog/tag/<slug> is its own canonical; the old ?tag= links 301.
 *
 *     node --test test/blog-tags.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

// The router requires ../src/db, which demands DB credentials at load: a
// stand-in pool that answers the three queries the blog index makes.
const queries = [];
const dbPath = path.join(__dirname, '..', 'src', 'db.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/SELECT tags FROM/.test(sql)) return [[{ tags: 'change timer, Vesopa EPOS' }, { tags: 'v1.3.5.0,epos' }]];
        if (/COUNT\(\*\)/.test(sql)) return [[{ total: 2 }]];
        return [[]];
      },
    },
  },
};

const { blogPagesRouter, tagSlug } = require('../src/routes/blog-pages');

function serve() {
  const app = express();
  // What the page would be drawn with, instead of drawing it.
  app.engine('ejs', (_file, opts, cb) => cb(null, JSON.stringify({ title: opts.title, description: opts.description, ogUrl: opts.ogUrl, tag: opts.tag, base: opts.base })));
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use('/', blogPagesRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('a tag has a clean address', () => {
  assert.equal(tagSlug('change timer'), 'change-timer');
  assert.equal(tagSlug('Vesopa Order'), 'vesopa-order');
  assert.equal(tagSlug('v1.3.5.0'), 'v1.3.5.0');
  assert.equal(tagSlug(' multi-store '), 'multi-store');
});

test("old ?tag= links move to the tag's page for good; a tag page is its own canonical", async () => {
  const { server, base } = await serve();
  try {
    let r = await fetch(`${base}/blog?tag=change%20timer`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/blog/tag/change-timer');

    r = await fetch(`${base}/blog?tag=v1.3.5.0&page=2`, { redirect: 'manual' });
    assert.equal(r.headers.get('location'), '/blog/tag/v1.3.5.0?page=2');

    r = await fetch(`${base}/blog/tag/Change%20Timer`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/blog/tag/change-timer');

    r = await fetch(`${base}/blog/tag/change-timer`);
    assert.equal(r.status, 200);
    const page = await r.json();
    assert.equal(page.tag, 'change timer');
    assert.equal(page.ogUrl, '/blog/tag/change-timer');
    assert.match(page.title, /#change timer/);
    assert.match(page.description, /change timer: 2 posts/);
    // The whole tag, never a tag that only contains it ("epos" in "Vesopa EPOS").
    const q = queries.find((x) => /COUNT/.test(x.sql) && x.params.includes('change timer'));
    assert.ok(q && /CONCAT\(','/.test(q.sql));

    r = await fetch(`${base}/blog/tag/no-such-tag`);
    assert.equal(r.status, 404);
  } finally {
    server.close();
  }
});

test('a filtered or later page of the blog is its own canonical too', async () => {
  const { server, base } = await serve();
  try {
    const page = await (await fetch(`${base}/blog?kind=update&page=2`)).json();
    assert.equal(page.ogUrl, '/blog?kind=update&page=2');
    const first = await (await fetch(`${base}/blog`)).json();
    assert.equal(first.ogUrl, '/blog');
  } finally {
    server.close();
  }
});
