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
const news = read('news.json').sort((a, b) => String(b.date).localeCompare(String(a.date)));
const images = read('images.json');
// The club's posts on X, as saved from x.com/PontardaweRFC (content/source/x-posts.json).
const xPosts = read('source/x-posts.json').posts
  .filter((p) => p && p.text && !/^@\w+$/.test(p.text.trim()))
  .sort((a, b) => String(b.date).localeCompare(String(a.date)));

/** "10 October 2026" from 2026-10-10. */
function longDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

const yearsOld = (now = new Date()) => now.getFullYear() - club.founded;

module.exports = { club, news, images, xPosts, longDate, yearsOld };
