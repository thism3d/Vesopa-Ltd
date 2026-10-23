/**
 * The club's news posts, written in the admin (/admin, src/admin.js) and kept
 * in DATA_DIR (default website/data/), which a deploy never touches:
 *
 *   data/posts.json     every post (drafts, scheduled and published) and the
 *                       uploaded pictures' sizes and alt text
 *   data/uploads/       the pictures, in the sizes src/uploads.js makes
 *
 * The posts shipped in content/ (news.json, updates.json) are copied in the
 * first time, so they can be edited like any other; one shipped later is
 * added on the next start, unless it was deleted in the admin.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const FILE = path.join(DATA, 'posts.json');
const UPLOADS = path.join(DATA, 'uploads');

let store = { posts: [], removed: [], images: {} };

/** Now in the UK, as 2026-10-23T18:05 (how publish times are kept). */
function nowUK(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** 2026-10-23T18:05 (UK) -> 2026-10-23T18:05:00+01:00, for search engines. */
function zoned(local) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(local || ''))) return local || '';
  const t = Date.parse(`${local}:00Z`);
  const summer = nowUK(new Date(t - 3600e3)) === local;
  return `${local}:00${summer ? '+01:00' : '+00:00'}`;
}

/** "Our new kit, 2026!" -> "our-new-kit-2026" */
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'post';
}

const escText = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * What a post's text may hold: paragraphs, headings, lists, quotes, links and
 * the club's own pictures. Anything else (scripts, styles, Word's markup,
 * pictures from other sites) is dropped, so a paste from anywhere is safe.
 */
function cleanHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'h2', 'h3', 'strong', 'em', 'u', 'a', 'ul', 'ol', 'li', 'blockquote', 'br', 'figure', 'figcaption', 'img'],
    // Only what the transforms below set: a visitor's own attributes are dropped.
    allowedAttributes: { a: ['href', 'rel', 'target'], img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    exclusiveFilter: (f) => (f.tag === 'img' && !/^\/img\/[a-z0-9/_-]+\.(jpg|webp)$/i.test(f.attribs.src || ''))
      || (['p', 'h2', 'h3', 'li', 'blockquote', 'figcaption'].includes(f.tag) && !f.text.trim() && !f.mediaChildren.length),
    transformTags: {
      b: 'strong',
      i: 'em',
      h1: 'h2',
      h4: 'h3',
      div: 'p',
      a: (tag, attribs) => {
        const href = String(attribs.href || '').trim();
        const outside = /^https?:\/\//i.test(href) && !/^https?:\/\/(www\.)?pontardawerfc\.com/i.test(href);
        return { tagName: 'a', attribs: outside ? { href, rel: 'noopener', target: '_blank' } : { href } };
      },
      img: (tag, attribs) => ({
        tagName: 'img',
        attribs: { src: attribs.src || '', alt: attribs.alt || '', ...(attribs.width ? { width: attribs.width, height: attribs.height } : {}), loading: 'lazy', decoding: 'async' },
      }),
    },
  }).trim();
}

/** Plain text of a post's body, for summaries and search. */
const textOf = (html) => sanitizeHtml(String(html || '').replace(/<\/(p|h2|h3|li|blockquote)>/g, ' '), { allowedTags: [], allowedAttributes: {} })
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** The old posts' paragraphs as HTML: a numbered line ("1. The role") is a heading. */
const paragraphsToHtml = (ps) => (ps || []).map((p) => (/^\d+\.\s|^\d+\.[A-Z]/.test(p) ? `<h2>${escText(p)}</h2>` : `<p>${escText(p)}</p>`)).join('\n');

/** A post from content/ as the store keeps it. */
function fromShipped(p) {
  return {
    id: `f-${p.slug}`,
    slug: p.slug,
    oldSlugs: [],
    title: p.title,
    summary: p.summary || '',
    html: paragraphsToHtml(p.paragraphs),
    image: p.image || null,
    gallery: p.gallery || (p.image ? [p.image] : []),
    kind: p.kind || '',
    event: p.event || null,
    cta: p.cta || null,
    source: p.source || null,
    closed: Boolean(p.closed),
    seoTitle: '',
    status: 'published',
    publishAt: `${p.date}T09:00`,
    created: `${p.date}T09:00`,
    updated: `${p.date}T09:00`,
    author: 'club',
    origin: 'file',
  };
}

function write() {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, FILE);
}

/** Load the store, copying in any shipped post it has not seen. */
function init(shipped) {
  fs.mkdirSync(UPLOADS, { recursive: true });
  let fresh = false;
  try {
    store = { posts: [], removed: [], images: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // a damaged file is never written over
    fresh = true;
  }
  const known = new Set([...store.posts.map((p) => p.id), ...store.removed]);
  const added = shipped.filter((p) => !known.has(`f-${p.slug}`) && !store.posts.some((q) => q.slug === p.slug)).map(fromShipped);
  if (fresh || added.length) {
    store.posts.push(...added);
    write();
  }
}

/** The post as the pages read it: published date, and the text either way. */
function view(p) {
  return { ...p, date: p.publishAt.slice(0, 10), paragraphs: [] };
}

/** Published posts whose time has come, newest first. */
function live(now = nowUK()) {
  return store.posts.filter((p) => p.status === 'published' && p.publishAt <= now)
    .sort((a, b) => b.publishAt.localeCompare(a.publishAt)).map(view);
}

/** Every post for the admin list, newest first. */
const all = () => store.posts.slice().sort((a, b) => b.publishAt.localeCompare(a.publishAt));
const get = (id) => store.posts.find((p) => p.id === id) || null;
/** A live post that once had this address, for a redirect. */
const movedFrom = (slug, now = nowUK()) => live(now).find((p) => (p.oldSlugs || []).includes(slug)) || null;

/** An address no other post has (or had). */
function uniqueSlug(want, id) {
  const base = slugify(want);
  const taken = (s) => store.posts.some((p) => p.id !== id && (p.slug === s || (p.oldSlugs || []).includes(s)));
  let s = base;
  for (let n = 2; taken(s); n += 1) s = `${base}-${n}`;
  return s;
}

/**
 * A post from the admin's form, checked and cleaned (so what is kept is
 * always safe to show), not yet saved: the editor's preview shows this.
 */
function build(input, { id = null, author = '' } = {}) {
  const now = nowUK();
  const old = id ? get(id) : null;
  if (id && !old) throw new Error('That post no longer exists.');
  const title = String(input.title || '').trim().slice(0, 140);
  if (!title) throw new Error('Give the post a title.');
  const html = cleanHtml(input.html);
  // Left empty, the summary is the story's opening paragraphs (not its headings or lists).
  const opening = textOf((html.match(/<p>[\s\S]*?<\/p>/g) || [html]).join(' '));
  const auto = opening.length > 157 ? opening.slice(0, 157).replace(/\s+\S*$/, '…') : opening;
  const summary = (String(input.summary || '').trim() || auto).slice(0, 300);
  if (!summary) throw new Error('Write a line or two, or a short summary.');
  const slug = uniqueSlug(input.slug || title, old && old.id);
  const publishAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.publishAt || '') ? input.publishAt : (old ? old.publishAt : now);
  const known = (n) => (n && (store.images[n] || /^(ig\/)?[a-z0-9-]+$/.test(n)) ? n : null);
  const gallery = [...new Set((input.gallery || []).map(known).filter(Boolean))];
  const image = known(input.image) || null;
  const ev = input.event && /^\d{4}-\d{2}-\d{2}$/.test(input.event.day || '')
    ? {
      ...(old && old.event ? old.event : {}),
      start: input.event.time ? `${input.event.day}T${input.event.time}` : input.event.day,
      place: String(input.event.place || '').trim().slice(0, 120),
      price: String(input.event.price || '').trim().slice(0, 80),
      note: String(input.event.note || '').trim().slice(0, 160),
    }
    : null;
  if (ev) for (const k of ['place', 'price', 'note']) if (!ev[k]) delete ev[k];
  const cta = input.cta && input.cta.label && /^(https?:\/\/|\/(?!\/))/.test(input.cta.href || '')
    ? { label: String(input.cta.label).trim().slice(0, 60), href: String(input.cta.href).trim().slice(0, 300) } : null;
  const post = {
    ...(old || { id: crypto.randomBytes(6).toString('hex'), created: now, origin: 'admin', source: null, closed: false, oldSlugs: [] }),
    slug,
    title,
    summary,
    html,
    image: image || gallery[0] || null,
    gallery: image && !gallery.includes(image) ? [image, ...gallery] : gallery,
    kind: ['match', 'event', 'juniors', 'food', 'lotto', 'touch', 'club', ''].includes(input.kind) ? input.kind : 'club',
    event: ev,
    cta,
    seoTitle: String(input.seoTitle || '').trim().slice(0, 70),
    status: input.status === 'published' ? 'published' : 'draft',
    publishAt,
    updated: now,
    author: author || (old && old.author) || '',
  };
  // An address a published post had keeps working: it redirects to the new one.
  if (old && old.slug !== slug && old.status === 'published' && old.publishAt <= now) {
    post.oldSlugs = [...new Set([...(old.oldSlugs || []), old.slug])].filter((s) => s !== slug);
  }
  return post;
}

/** Save a post from the admin's form; returns it as saved. */
function save(input, opts = {}) {
  const post = build(input, opts);
  const at = store.posts.findIndex((p) => p.id === post.id);
  if (at >= 0) store.posts[at] = post;
  else store.posts.push(post);
  write();
  return post;
}

function remove(id) {
  const p = get(id);
  if (!p) return false;
  store.posts.splice(store.posts.indexOf(p), 1);
  if (p.origin === 'file') store.removed.push(p.id);
  write();
  return true;
}

/** Uploaded pictures' sizes and alt text, as content/images.json has them. */
const images = () => store.images;
function addImage(name, meta) {
  store.images[name] = { ...meta, added: new Date().toISOString() };
  write();
}

/**
 * Uploaded photos no post uses (a draft, a scheduled post or a published
 * one, as its photos or in its story), uploaded more than `minAgeMs` ago:
 * one taken off a post, from a deleted post, or added to a post that was
 * never saved. The day's grace keeps a post still being written safe.
 * Their files and their record go; returns their names.
 */
function sweepPhotos({ minAgeMs = 24 * 3600e3, now = Date.now() } = {}) {
  const used = new Set();
  for (const p of store.posts) {
    (p.gallery || []).forEach((n) => used.add(n));
    if (p.image) used.add(p.image);
    for (const m of String(p.html || '').matchAll(/\/img\/(u\/[a-z0-9-]+)\.(?:jpg|webp)/g)) used.add(m[1]);
  }
  const gone = Object.keys(store.images).filter((n) => n.startsWith('u/') && !used.has(n)
    && now - Date.parse(store.images[n].added || 0) >= minAgeMs);
  for (const n of gone) {
    const id = n.slice(2);
    for (const suffix of ['.jpg', '.webp', '-480.webp', '-og.jpg']) {
      try { fs.unlinkSync(path.join(UPLOADS, `${id}${suffix}`)); } catch { /* already gone */ }
    }
    delete store.images[n];
  }
  if (gone.length) write();
  return gone;
}
function setAlt(name, alt) {
  if (!store.images[name]) return;
  store.images[name].alt = String(alt || '').trim().slice(0, 200);
  write();
}

module.exports = {
  DATA, UPLOADS, init, live, all, zoned, get, movedFrom, build, save, view, remove, images, addImage, setAlt, sweepPhotos, nowUK, slugify, cleanHtml, textOf,
};
