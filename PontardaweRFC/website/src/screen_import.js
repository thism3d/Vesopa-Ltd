/**
 * News from screenshots of the club's own social media posts (2026-10-23,
 * /admin/import). No social media account is connected or read: an editor
 * uploads screenshots taken on a phone, and each post in them becomes a
 * DRAFT to check and publish.
 *
 * The AI (src/vesopa_ai.js, DeepSeek; Gemini as its backup) only READS the
 * screenshots: the post's words exactly as written, which network and
 * account it is, when it says it was posted, where its photo is, and an
 * event's date only if the words give it. The post's text is the club's own
 * words, never rewritten; the title is its first sentence. Posts that are not
 * the club's own (another club, the WRU, a comment) are left out. The
 * screenshots are kept in data/screens/ (never public) and shown beside the
 * draft, so the editor can check every word before publishing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const posts = require('./posts');
const { savePhoto } = require('./uploads');
const { club } = require('./content');
const { createClient } = require('./vesopa_ai');

const SCREENS = path.join(posts.DATA, 'screens');
const KINDS = ['match', 'event', 'juniors', 'food', 'lotto', 'touch', 'club'];
const NETWORK = { facebook: 'Facebook page', instagram: 'Instagram', x: 'X (Twitter)' };

let ai = null;
const client = () => ai || (ai = createClient({
  app: 'pontardawerfc',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  gemini: { apiKey: process.env.GEMINI_API_KEY || '' },
  dailyCapUsd: Number(process.env.AI_DAILY_CAP_USD || 0.5),
  logDir: process.env.LOG_DIR || '',
}));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** The words of a post with everything but letters and digits taken out: the same post looks the same. */
const signature = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);

const PROMPT = (today) => `You read screenshots of social media posts for ${club.name}'s website. Today is ${today}.

The screenshots are numbered from 0 in the order given. They may show one post, a long post over several screenshots, or several different posts.

For each post that ${club.name} itself posted (the account is Pontardawe RFC / pontardawerfc / @PontardaweRFC), give:
- "screens": the numbers of the screenshots it is in
- "network": "facebook", "instagram", "x" or "unknown", from how the app looks
- "account": the account name exactly as shown
- "text": the post's own words EXACTLY as written: every word, number, emoji and line break, in order. Join a post split over screenshots. Leave out "See more", the names of people who liked or commented, comments, buttons, counts and anything that is not the post's own text. Never correct, shorten, reword or add anything. If part of the text cannot be read, put [unreadable] there.
- "posted": the date the post was made as YYYY-MM-DD only if an actual date is written on the screen (like "14 October"); null for "2 hours ago", "3d", "1w" and the like, since the screenshot may be older than today
- "cut_off": true if the screen shows the words are not all there ("... more", "See more", text running off the screen); otherwise false
- "photo": where the post's main photo is, as {"screen": n, "box": [left, top, right, bottom]} in fractions of that screenshot (0 to 1), covering only the photo itself, not text or buttons; null if there is none
- "event": only if the post's own words give a date for something happening: {"date": "YYYY-MM-DD", "time": "HH:MM" or null, "place": words from the post or ""}; otherwise null
- "category": the best of ${KINDS.join(', ')}
- "tags": up to 5 short tags made only of words that appear in the post

Posts by anyone else (other clubs, the WRU, news sites, people commenting) go in "others" as {"screens": [...], "account": "..."} and are not transcribed.

Answer with JSON only: {"posts": [...], "others": [...]}`;

/** The screenshots as the AI and the editor see them: upright, at most 1280px tall-side, JPG. */
async function prepare(files, batch) {
  fs.mkdirSync(SCREENS, { recursive: true });
  const out = [];
  for (const [i, f] of files.entries()) {
    const img = sharp(f.buffer, { failOn: 'error', limitInputPixels: 80e6 }).rotate();
    const meta = await img.metadata().catch(() => null);
    if (!meta || !meta.width) throw new Error(`Picture ${i + 1} is not a screenshot we can read. Use PNG or JPG.`);
    const full = await img.clone().resize({ width: 1600, height: 3200, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
    const name = `${batch}-${i}.jpg`;
    fs.writeFileSync(path.join(SCREENS, name), full.data);
    const small = await sharp(full.data).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    out.push({ name, file: path.join(SCREENS, name), w: full.info.width, h: full.info.height, dataUrl: `data:image/jpeg;base64,${small.toString('base64')}` });
  }
  return out;
}

/** The post's photo, cut from its screenshot where the AI says it is, if that is a sensible photo. */
async function cutPhoto(shot, box) {
  if (!shot || !Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) return null;
  const [l, t, r, b] = box;
  const left = Math.round(l * shot.w);
  const top = Math.round(t * shot.h);
  const width = Math.round((r - l) * shot.w);
  const height = Math.round((b - t) * shot.h);
  if (width < 300 || height < 200 || width * height < 0.12 * shot.w * shot.h) return null;
  return sharp(shot.file).extract({ left, top, width: Math.min(width, shot.w - left), height: Math.min(height, shot.h - top) }).jpeg({ quality: 90 }).toBuffer();
}

/** First sentence of the club's words as the title; the words, as they are, for the story. */
function fromText(text, network) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  const first = clean.split('\n').find((l) => l.trim()) || '';
  const sentence = (first.match(/^.{20,}?[.!?](?=\s|$)/) || [first])[0].replace(/(^|\s)[#@][\w]+/g, ' ').replace(/\s+/g, ' ').trim();
  const title = sentence.length > 90 ? `${sentence.slice(0, 88).replace(/\s+\S*$/, '')}…` : sentence;
  const link = network === 'instagram' ? club.web.instagram : network === 'x' ? club.web.x : club.web.facebook;
  const html = `${clean.split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('\n')}
<p><em>First posted on the club's <a href="${esc(link)}">${esc(NETWORK[network] || 'social media')}</a>.</em></p>`;
  return { title: title || 'From the club', html };
}

/** An event's date is kept only if its day of the month is written in the post. */
function checkedEvent(ev, text) {
  if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) return null;
  const dayNum = String(Number(ev.date.slice(8, 10)));
  if (!new RegExp(`(^|\\D)${dayNum}(st|nd|rd|th)?(\\D|$)`, 'i').test(text)) return null;
  return { day: ev.date, time: /^\d{2}:\d{2}$/.test(ev.time || '') ? ev.time : '', place: String(ev.place || '').slice(0, 120) };
}

/**
 * Read the screenshots and save each club post in them as a draft.
 * Returns { drafts: [post], others: [account], duplicates: [{title, id}], problems: [text] }.
 */
async function importScreens(files, { author = '', photos = [] } = {}) {
  if (!files.length) throw new Error('Choose at least one screenshot.');
  if (!client().enabled) throw new Error('Reading screenshots needs the AI key in the site settings (DEEPSEEK_API_KEY).');
  const batch = `${posts.nowUK().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
  const shots = await prepare(files, batch);
  const today = posts.nowUK().slice(0, 10);
  const res = await client().chat({
    purpose: 'vision',
    json: true,
    maxTokens: 4000,
    timeoutMs: 120000,
    messages: [
      { role: 'system', content: PROMPT(today) },
      { role: 'user', content: [{ type: 'text', text: `${shots.length} screenshot(s):` }, ...shots.map((s) => ({ type: 'image_url', image_url: { url: s.dataUrl } }))] },
    ],
    validate: (r) => {
      try { return Array.isArray(JSON.parse(r.content).posts) || 'no posts list'; } catch { return 'not JSON'; }
    },
  });
  let answer;
  try { answer = JSON.parse(res.content); } catch { throw new Error('The screenshots could not be read just now. Please try again.'); }

  const out = { drafts: [], others: (answer.others || []).map((o) => String(o.account || 'someone else')), duplicates: [], problems: [] };
  const used = new Set();
  for (const p of answer.posts || []) {
    const text = String(p.text || '').trim();
    const mine = /pontardawe/i.test(String(p.account || ''));
    if (!mine) { out.others.push(String(p.account || 'someone else')); continue; }
    if (text.replace(/\[unreadable\]/g, '').trim().length < 15) { out.problems.push('A post had too few words to read; try a clearer screenshot.'); continue; }
    const sig = signature(text);
    const same = sig.length >= 20 && posts.all().find((q) => q.sig === sig || signature(posts.textOf(q.html)).startsWith(sig.slice(0, 60)));
    if (same) { out.duplicates.push({ title: same.title, id: same.id }); continue; }
    const network = ['facebook', 'instagram', 'x'].includes(p.network) ? p.network : 'unknown';
    const { title, html } = fromText(text, network);
    const screens = (Array.isArray(p.screens) ? p.screens : []).filter((n) => Number.isInteger(n) && shots[n]).map((n) => shots[n].name);
    screens.forEach((n) => used.add(n));
    // The post's own photos if the editor added them; else its photo cut from the screenshot.
    const gallery = [];
    for (const ph of photos.splice(0)) {
      try { gallery.push((await savePhoto(ph.buffer, `Photo from Pontardawe RFC's ${NETWORK[network] || 'social media'}`)).name); } catch (e) { out.problems.push(e.message); }
    }
    if (!gallery.length && p.photo) {
      try {
        const buf = await cutPhoto(shots[p.photo.screen], p.photo.box);
        if (buf) gallery.push((await savePhoto(buf, `Photo from Pontardawe RFC's ${NETWORK[network] || 'social media'}`)).name);
      } catch { /* a draft without a photo; one can be added in the editor */ }
    }
    const posted = /^\d{4}-\d{2}-\d{2}$/.test(p.posted || '') && p.posted <= today ? p.posted : null;
    const post = posts.save({
      title,
      html,
      kind: KINDS.includes(p.category) ? p.category : 'club',
      tags: [...(Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string' && text.toLowerCase().includes(t.toLowerCase())) : []), NETWORK[network] ? network[0].toUpperCase() + network.slice(1) : null].filter(Boolean),
      gallery,
      event: checkedEvent(p.event, text),
      publishAt: posted ? `${posted}T${posts.nowUK().slice(11)}` : posts.nowUK(),
      status: 'draft',
    }, { author, extra: { origin: 'import', source: network, sig, screens } });
    out.drafts.push(post);
    if (p.cut_off) out.problems.push(`“${title}”: the words are cut off in the screenshot. Open the post, tap “more”, and screenshot it again (or add the rest in the editor).`);
  }
  // Screenshots no draft came from are not kept.
  for (const s of shots) if (!used.has(s.name)) fs.rmSync(s.file, { force: true });
  return out;
}

/** A kept screenshot, for the editor (admin only). */
function screenPath(name) {
  if (!/^[0-9]{8}-[a-f0-9]{8}-\d+\.jpg$/.test(String(name))) return null;
  const f = path.join(SCREENS, name);
  return fs.existsSync(f) ? f : null;
}

/** Screenshots no post uses any more (its draft deleted). */
function sweepScreens() {
  if (!fs.existsSync(SCREENS)) return 0;
  const keep = new Set(posts.all().flatMap((p) => p.screens || []));
  let n = 0;
  for (const f of fs.readdirSync(SCREENS)) if (!keep.has(f)) { fs.rmSync(path.join(SCREENS, f), { force: true }); n += 1; }
  return n;
}

/** For tests: a stand-in for the AI. */
function useClient(c) { ai = c; }

module.exports = { importScreens, screenPath, sweepScreens, fromText, checkedEvent, signature, useClient };
