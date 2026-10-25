/**
 * The picture for a news post with no photo of its own (none uploaded and
 * none in its story): the club card src/match_card.js draws, with the post's
 * kind, title and date, so the home page and /news never show an empty card.
 *
 *   data/cards/<key>.jpg, .webp, -480.webp   served at /img/c/<key>...
 *
 * Drawn once, in the background, and named "c/<key>" in content.images. The
 * key comes from what is written on it, so a renamed post gets a new picture
 * and the old one is deleted. It is never saved on the post: the admin still
 * shows the post as having no photo, and one added there replaces this.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const posts = require('./posts');

const DIR = path.join(posts.DATA, 'cards');
const LABELS = {
  match: 'Match', event: 'Event', juniors: 'Juniors', food: 'Pop-up food', lotto: 'Weekly Lotto', touch: 'Touch rugby', club: 'Club news',
};

/** "Sunday 25 October 2026", as the match cards write it. */
function longDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).replace(',', '');
}

/** What the card for a post says. */
function words(post) {
  const title = post.title.length > 90 ? post.title.slice(0, 89).replace(/\s+\S*$/, '…') : post.title;
  return {
    label: `${LABELS[post.kind] || 'Club news'} · Pontardawe RFC`,
    lines: [title],
    foot: `${longDate(post.date)} · pontardawerfc.com`,
    size: title.length > 48 ? 50 : 60,
  };
}

const keyOf = (w) => crypto.createHash('sha1').update(JSON.stringify(w)).digest('hex').slice(0, 12);
const META = { w: 1200, h: 630, small: true, drawn: true };

let busy = null;

/**
 * Make sure every post in `list` without a cover has a drawn card. Returns
 * at once: posts with a card already have it set as their cover; the rest
 * are drawn in the background, then `done()` is called (to show them).
 */
function fill(list, images, done = () => {}) {
  const want = new Map();
  for (const p of list) {
    if (p.cover) continue;
    const w = words(p);
    const key = keyOf(w);
    want.set(key, w);
    const name = `c/${key}`;
    images[name] = { ...META, alt: '' };
    if (fs.existsSync(path.join(DIR, `${key}-480.webp`))) p.cover = name;
  }
  if (busy) return;
  const missing = [...want].filter(([key]) => !fs.existsSync(path.join(DIR, `${key}-480.webp`)));
  busy = (async () => {
    fs.mkdirSync(DIR, { recursive: true });
    const { card } = require('./match_card');
    for (const [key, w] of missing) {
      const jpg = await card(w);
      const file = (s) => path.join(DIR, `${key}${s}`);
      await sharp(jpg).webp({ quality: 80 }).toFile(file('.webp'));
      fs.writeFileSync(file('.jpg'), jpg);
      await sharp(jpg).resize(480).webp({ quality: 76 }).toFile(file('-480.webp')); // written last: it marks the card done
    }
    // Cards no post needs any more (a post renamed, given a photo or deleted).
    for (const f of fs.readdirSync(DIR)) if (!want.has(f.slice(0, 12))) fs.rmSync(path.join(DIR, f), { force: true });
  })().catch((e) => console.error('news card:', e.message)).finally(() => {
    busy = null;
    if (missing.length) done();
  });
}

/** Waits for any drawing still going (the tests). */
const settled = () => busy || Promise.resolve();

module.exports = { DIR, fill, settled, words };
