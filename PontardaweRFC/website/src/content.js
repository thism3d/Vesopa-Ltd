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

const ROOT = path.join(__dirname, '..', 'content');
const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

const club = read('club.json');
const images = read('images.json');
// The old pontardawerfc.co.uk, 2012-13 (tool/import_archive.py).
const archive = read('archive.json');

// The club's own updates from Instagram and Facebook (content/updates.json),
// with their pictures (content/images-ig.json, from tool/make_update_images.py).
// Each is a news post as well, so it has its own page, a card on the news
// page and a place in the feed and the sitemap; one with an event also shows
// on What's On until its day has passed.
let saved = { updates: [] };
try { saved = read('updates.json'); } catch { /* none shipped */ }
try { Object.assign(images, read('images-ig.json')); } catch { /* pictures not made yet */ }
const updates = (saved.updates || []).map((u) => {
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
const news = [...read('news.json'), ...updates].sort((a, b) => String(b.date).localeCompare(String(a.date)));
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

module.exports = { club, news, updates, images, xPosts, longDate, yearsOld, archive };
