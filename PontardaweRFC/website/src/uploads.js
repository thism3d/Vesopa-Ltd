/**
 * A photo uploaded in the admin, made ready for the site (sharp):
 *
 *   data/uploads/<id>.jpg       up to 1600px wide, for browsers without WebP and for Google
 *   data/uploads/<id>.webp      the same, smaller
 *   data/uploads/<id>-480.webp  for phones and cards
 *   data/uploads/<id>-og.jpg    1200x630, the picture a shared link shows
 *
 * served at /img/u/<id>... and named "u/<id>" in the posts, as the site's
 * own pictures are named in content/images.json. Turned the right way up from
 * the phone's own record of it, and that record (with any location) is not kept.
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const posts = require('./posts');

const MAX_W = 1600;

async function savePhoto(buffer, alt = '') {
  const src = sharp(buffer, { failOn: 'error', limitInputPixels: 80e6 }).rotate();
  const info = await src.metadata().catch(() => null);
  if (!info || !['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'tiff'].includes(info.format)) {
    throw new Error('That file is not a photo we can use. Please choose a JPG, PNG or WebP picture.');
  }
  const id = `${new Date().toISOString().slice(0, 7).replace('-', '')}-${crypto.randomBytes(5).toString('hex')}`;
  const file = (suffix) => path.join(posts.UPLOADS, `${id}${suffix}`);
  const base = src.clone().resize({ width: MAX_W, withoutEnlargement: true }).flatten({ background: '#ffffff' });
  const out = await base.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(file('.jpg'));
  await base.clone().webp({ quality: 78 }).toFile(file('.webp'));
  await src.clone().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 74 }).toFile(file('-480.webp'));
  await src.clone().resize(1200, 630, { fit: 'cover', position: sharp.strategy.attention }).flatten({ background: '#ffffff' })
    .jpeg({ quality: 80, mozjpeg: true }).toFile(file('-og.jpg'));
  const name = `u/${id}`;
  const meta = { w: out.width, h: out.height, alt: String(alt || '').trim().slice(0, 200), small: true, og: true };
  posts.addImage(name, meta);
  return { name, ...meta, url: `/img/${name}.jpg`, thumb: `/img/${name}-480.webp` };
}

module.exports = { savePhoto };
