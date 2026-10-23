/**
 * The club's facts, news and pictures, read once at start-up from content/.
 *
 * Nothing about the club is written into a template: the pages, the
 * structured data, the sitemap and the AI helper's grounding all read from
 * here, so a correction in content/club.json reaches every one of them.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const posts = require('./posts');

const ROOT = path.join(__dirname, '..', 'content');
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

const club = read('club.json');
const images = read('images.json');
// The old pontardawerfc.co.uk, 2012-13 (tool/import_archive.py).
const archive = read('archive.json');

// The club's own updates from Instagram and Facebook (content/updates.json),
// with their pictures (content/images-ig.json, from tool/make_update_images.py).
let saved = { updates: [] };
try { saved = read('updates.json'); } catch { /* none shipped */ }
try { Object.assign(images, read('images-ig.json')); } catch { /* pictures not made yet */ }
const shippedUpdates = (saved.updates || []).map((u) => {
  const gallery = (u.images || []).map((i) => `ig/${i.name}`).filter((n) => images[n]);
  return {
    slug: u.slug,
    date: u.posted,
    title: u.title,
    summary: u.summary,
    paragraphs: u.paragraphs || [],
    image: gallery[0] || null,
    gallery,
    kind: u.kind || 'club',
    event: u.event || null,
    cta: u.cta || null,
    source: 'instagram',
  };
});

/*
 * The news (2026-10-23): every post now lives in the store the admin writes
 * (src/posts.js, data/posts.json), which the shipped posts above are copied
 * into. `news` is every published post whose time has come, newest first;
 * `updates` is those with a kind (Match, Event, ...), which What's On shows,
 * and with an event date, until its day has passed. Both are filled again in
 * place after every save in the admin and each minute (scheduled posts), so
 * the pages that hold them always read the current list.
 */
posts.init([...read('news.json'), ...shippedUpdates]);
const news = [];
const updates = [];
function refresh() {
  Object.assign(images, posts.images());
  const live = posts.live();
  news.splice(0, news.length, ...live);
  updates.splice(0, updates.length, ...live.filter((p) => p.kind));
}
refresh();
setInterval(refresh, 60 * 1000).unref();

// The club's posts on X, as saved from x.com/PontardaweRFC (content/source/x-posts.json).
// Missing file = no X archive, never a site that will not start.
let xSaved = { posts: [] };
try { xSaved = read('source/x-posts.json'); } catch { /* none shipped */ }
const xPosts = (xSaved.posts || [])
  .filter((p) => p && p.text && !/^@\w+$/.test(p.text.trim()))
  .sort((a, b) => String(b.date).localeCompare(String(a.date)));

/** "10 October 2026" from 2026-10-10. */
function longDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

const yearsOld = (now = new Date()) => now.getFullYear() - club.founded;

module.exports = { club, news, updates, images, xPosts, longDate, yearsOld, archive, refresh };
