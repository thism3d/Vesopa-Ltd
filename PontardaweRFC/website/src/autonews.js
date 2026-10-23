/**
 * The automatic news (2026-10-23): posts written from genuine sources only,
 * checked every three hours, set up at /admin/auto.
 *
 *   WRU results     a report of each First XV result the Welsh Rugby Union
 *                   has published (score, tries, competition, the league
 *                   table, what is next), for ten days after the match
 *   WRU previews    the next match, from a week before: when, where, the
 *                   competition, recent results and both sides in the table
 *   Facebook and    the club's own posts (its words and photo), once the
 *   Instagram       club connects its Page at /admin/auto (Meta Graph API)
 *   In the news     stories that name the club (Google News), listed in the
 *                   admin to read; never turned into posts by themselves
 *
 * NOTHING IS MADE UP. Every sentence is a fixed sentence filled with figures
 * straight from the source, which each post credits; no player names, no
 * quotes, nothing about how a game went beyond what the score says. No AI
 * writes a word. Each source can publish, save drafts for approval, or be off
 * (the WRU's figures publish by default; the club's own posts are drafts).
 *
 * Never twice: each item has a key (wru-result-568140, fb-123_456, ...) kept
 * in data/autonews.json once written, so a post deleted in the admin is never
 * written again. Nothing too old: results ten days, previews a week ahead,
 * social posts fourteen days, news thirty. A match the club has already
 * posted about itself is left to the club's own post.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const posts = require('./posts');
const wru = require('./wru');
const { club } = require('./content');

const FILE = path.join(posts.DATA, 'autonews.json');
const EVERY = 3 * 3600 * 1000;
const RESULT_DAYS = 10;
const PREVIEW_DAYS = 7;
const SOCIAL_DAYS = 14;
const MENTION_DAYS = 30;
const GRAPH = 'https://graph.facebook.com/v21.0';
const NEWS_RSS = 'https://news.google.com/rss/search?q=%22Pontardawe+RFC%22&hl=en-GB&gl=GB&ceid=GB:en';
const MODES = ['publish', 'draft', 'off'];

let state = null;
let running = null;
let timer = null;
let content = null; // src/content.js refresh, given by start()

// ---- The saved state ---------------------------------------------------------------

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    state = {};
  }
  state = {
    settings: { results: 'publish', previews: 'publish', social: 'draft', mentions: 'on', ...(state.settings || {}) },
    meta: state.meta || null,
    done: state.done || {},
    mentions: state.mentions || [],
    runs: state.runs || [],
  };
  return state;
}
function save() {
  fs.mkdirSync(posts.DATA, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// ---- Words -------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayUK = () => posts.nowUK().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
// Written out by hand: Node's own long dates differ between versions ("Saturday, 17 October").
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateParts = (d) => { const t = new Date(`${d}T12:00:00Z`); return [DAYS[t.getUTCDay()], t.getUTCDate(), MONTHS[t.getUTCMonth()], t.getUTCFullYear()]; };
const longDay = (d) => { const [w, n, m, y] = dateParts(d); return `${w} ${n} ${m} ${y}`; };
const shortDay = (d) => { const [w, n, m] = dateParts(d); return `${w} ${n} ${m}`; };
const dayMonth = (d) => { const [, n, m] = dateParts(d); return `${n} ${m}`; };
function time12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
/** "Crynant (Creunant) RFC" -> "Crynant": how the club is named in a sentence. */
const shortName = (name) => String(name).replace(/\s*\(.*?\)/g, '').replace(/\s+RFC$/i, '').trim();
/** "WRU Men’s National League" -> "National League" */
const shortComp = (c) => String(c || '').replace(/^WRU\s+Men[’']s\s+/i, '').trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const US = 'Pontardawe RFC';
const WRU_CREDIT = (on) => `<p><em>Fixtures, scores and the league table from the Welsh Rugby Union's fixtures and results service (<a href="https://www.wru.wales/">wru.wales</a>), as published on ${esc(dayMonth(on))}. Written automatically from those figures.</em></p>`;

function tableRows(f) {
  const t = wru.fixtures().table;
  if (!t || !t.rows || !t.rows.length) return null;
  const us = t.rows.find((r) => r.us);
  const them = t.rows.find((r) => !r.us && shortName(r.team).toLowerCase() === shortName(f.opponent).toLowerCase());
  return us ? { t, us, them } : null;
}
const standing = (r, name) => `${esc(name)} are ${ordinal(r.pos)} with ${plural(r.pts, 'point')} from ${plural(r.p, 'game')} (won ${r.w}, drawn ${r.d}, lost ${r.l})`;

/** The match from both sides, as written: "Pontardawe RFC 18–67 Penlan RFC" (home side first). */
const scoreLine = (f) => (f.home ? `${US} ${f.us}–${f.them} ${f.opponent}` : `${f.opponent} ${f.them}–${f.us} ${US}`);

/** A result report, from the WRU's figures alone. */
function resultArticle(f) {
  const opp = shortName(f.opponent);
  const comp = f.competition;
  const verb = f.result === 'W' ? 'beat' : f.result === 'L' ? 'lost to' : 'drew with';
  const where = f.home ? 'at The Rec' : `away at ${esc(opp)}`;
  const title = f.result === 'W'
    ? `Pontardawe RFC beat ${opp} ${f.us}–${f.them} in the ${shortComp(comp)}`
    : `${scoreLine(f)}: ${shortComp(comp)} result, ${dayMonth(f.day)}`;
  const out = [];
  out.push(`<p>Pontardawe RFC's First XV ${verb} ${esc(f.opponent)} ${where} on ${esc(longDay(f.day))}, in the ${esc(comp)}. The final score was <strong>${esc(scoreLine(f))}</strong>.</p>`);
  if (f.usTries != null && f.themTries != null) {
    out.push(`<p>Pontardawe scored ${plural(f.usTries, 'try', 'tries')} to ${esc(opp)}'s ${f.themTries}.</p>`);
  }
  const tr = tableRows(f);
  if (tr) {
    out.push(`<h2>The league table</h2><p>In the WRU's latest table for the ${esc(tr.t.name)}${tr.t.season ? ` (${esc(tr.t.season)})` : ''}, ${standing(tr.us, US)}.${tr.them ? ` ${standing(tr.them, f.opponent)}.` : ''} <a href="/fixtures">See the full table</a>.</p>`);
  }
  const next = wru.fixtures().upcoming.find((n) => n.day > f.day);
  if (next) {
    out.push(`<h2>Next up</h2><p>${next.home ? `Pontardawe are at home to ${esc(next.opponent)}` : `Pontardawe travel to ${esc(next.opponent)}`} on ${esc(shortDay(next.day))}${next.kickoff ? `, kick-off ${time12(next.kickoff)}` : ''}${next.competition ? ` (${esc(next.competition)})` : ''}.${next.home ? ' <a href="/tickets">Home match tickets</a>.' : ''} <a href="/fixtures">All fixtures and results</a>.</p>`);
  }
  out.push(`<p>Follow the club on <a href="${esc(club.web.facebook)}">Facebook</a> and <a href="${esc(club.web.instagram)}">Instagram</a> for more from Ynysderw Road.</p>`);
  out.push(WRU_CREDIT(todayUK()));
  return {
    title,
    html: out.join('\n'),
    summary: `${scoreLine(f)} in the ${comp}, ${longDay(f.day)}${f.home ? ' at The Rec, Pontardawe' : ''}. The result, the league table and Pontardawe RFC's next match.`,
    seoTitle: `${scoreLine(f)} | ${shortComp(comp)} result`.slice(0, 70),
    tags: ['Match report', 'First XV', shortComp(comp), opp, f.result === 'W' ? 'Win' : f.result === 'L' ? 'Defeat' : 'Draw'],
    card: { label: `Full time · ${comp}`, lines: f.home ? [`${US} ${f.us}`, `${f.opponent} ${f.them}`] : [`${f.opponent} ${f.them}`, `${US} ${f.us}`], foot: `${longDay(f.day)}${f.home ? ' · The Rec, Ynysderw Road' : ''} · pontardawerfc.com` },
    alt: `Full time: ${scoreLine(f)}, ${comp}, ${longDay(f.day)}`,
  };
}

/** A preview of the next match, from the WRU's fixture list and table. */
function previewArticle(f) {
  const opp = shortName(f.opponent);
  const comp = f.competition || 'a match';
  const title = f.home
    ? `Preview: Pontardawe RFC v ${opp}, ${shortDay(f.day)}${f.kickoff ? `, ${time12(f.kickoff)}` : ''}`
    : `Preview: ${opp} v Pontardawe RFC, ${shortDay(f.day)}${f.kickoff ? `, ${time12(f.kickoff)}` : ''}`;
  const out = [];
  out.push(`<p>${f.home ? `Pontardawe RFC's First XV are at home to ${esc(f.opponent)} at The Rec, Ynysderw Road` : `Pontardawe RFC's First XV travel to ${esc(f.opponent)}`} on <strong>${esc(longDay(f.day))}</strong>${f.kickoff ? `, kick-off <strong>${time12(f.kickoff)}</strong>` : ''}, in the ${esc(comp)}.</p>`);
  const recent = wru.fixtures().results.filter((r) => r.competition && r.day < f.day).slice(0, 3);
  if (recent.length) {
    out.push(`<h2>Recent results</h2><ul>${recent.map((r) => `<li>${esc(dayMonth(r.day))}: ${esc(scoreLine(r))} (${esc(shortComp(r.competition))})</li>`).join('')}</ul>`);
  }
  const tr = tableRows(f);
  if (tr) {
    out.push(`<h2>The league table</h2><p>In the WRU's latest table for the ${esc(tr.t.name)}, ${standing(tr.us, US)}.${tr.them ? ` ${standing(tr.them, f.opponent)}.` : ''}</p>`);
  }
  out.push(f.home
    ? `<h2>Coming to The Rec?</h2><p>The ground is on Ynysderw Road, Pontardawe, beside the clubhouse. <a href="/tickets">Home match tickets</a> · <a href="/whats-on">What's on at the club</a>.</p>`
    : `<p>The result will be on our <a href="/fixtures">fixtures and results page</a> once the WRU publishes it.</p>`);
  out.push(WRU_CREDIT(todayUK()));
  return {
    title,
    html: out.join('\n'),
    summary: `${f.home ? `Pontardawe RFC host ${f.opponent} at The Rec` : `Pontardawe RFC travel to ${f.opponent}`} on ${longDay(f.day)}${f.kickoff ? `, kick-off ${time12(f.kickoff)}` : ''}, in the ${comp}. Recent results and the league table.`,
    seoTitle: `${f.home ? `Pontardawe RFC v ${opp}` : `${opp} v Pontardawe RFC`}: match preview, ${dayMonth(f.day)}`.slice(0, 70),
    tags: ['Match preview', 'First XV', shortComp(comp), opp, f.home ? 'Home' : 'Away'],
    card: { label: `Match preview · ${comp}`, lines: f.home ? [US, `v ${f.opponent}`] : [f.opponent, `v ${US}`], foot: `${longDay(f.day)}${f.kickoff ? `, ${time12(f.kickoff)}` : ''}${f.home ? ' · The Rec, Ynysderw Road' : ''}` },
    alt: `Match preview: ${f.home ? `${US} v ${f.opponent}` : `${f.opponent} v ${US}`}, ${longDay(f.day)}`,
    event: { day: f.day, time: f.kickoff || '', place: f.home ? 'The Rec, Ynysderw Road' : `Away at ${opp}`, note: comp },
  };
}

// ---- Sources -----------------------------------------------------------------------

/** Has the club already posted about this match itself? */
function clubCovered(f, { after }) {
  const name = shortName(f.opponent).toLowerCase();
  return posts.all().some((p) => p.origin !== 'auto' && p.kind === 'match' && p.publishAt.slice(0, 10) >= after
    && p.title.toLowerCase().includes(name));
}

function wruItems(log) {
  const s = load().settings;
  const today = todayUK();
  const out = [];
  const fx = wru.fixtures();
  if (!fx.updated) {
    log.skipped.push('WRU: no fixtures read yet');
    return out;
  }
  if (s.results !== 'off') {
    for (const f of fx.results) {
      const age = daysBetween(f.day, today);
      if (!f.competition || f.us == null || f.them == null || age < 0 || age > RESULT_DAYS) continue;
      const key = `wru-result-${f.id}`;
      if (state.done[key]) continue;
      if (clubCovered(f, { after: f.day })) {
        state.done[key] = { at: new Date().toISOString(), note: 'the club posted about it' };
        log.skipped.push(`${scoreLine(f)}: the club has its own post`);
        continue;
      }
      out.push({ key, mode: s.results, kind: 'match', publishAt: `${today}T${posts.nowUK().slice(11)}`, source: 'wru', ...resultArticle(f) });
    }
  }
  if (s.previews !== 'off') {
    const f = fx.upcoming[0];
    const ahead = f ? daysBetween(today, f.day) : null;
    if (f && ahead >= 0 && ahead <= PREVIEW_DAYS) {
      const key = `wru-preview-${f.id}`;
      const own = posts.all().some((p) => p.origin !== 'auto' && p.event && String(p.event.start).slice(0, 10) === f.day);
      if (!state.done[key] && own) {
        state.done[key] = { at: new Date().toISOString(), note: 'the club posted about it' };
        log.skipped.push(`preview v ${f.opponent}: the club has its own post`);
      } else if (!state.done[key]) {
        out.push({ key, mode: s.previews, kind: 'match', source: 'wru', ...previewArticle(f) });
      }
    }
  }
  return out;
}

async function graph(pathname, token) {
  const r = await fetch(`${GRAPH}${pathname}${pathname.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || `${r.status} from Meta`);
  return j;
}

/** The club's own words as paragraphs, and a title from its first sentence. */
function fromCaption(text) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  const first = clean.split('\n').find((l) => l.trim()) || '';
  const sentence = (first.match(/^.{20,}?[.!?](?=\s|$)/) || [first])[0].replace(/[#@]\w+/g, '').replace(/\s+/g, ' ').trim();
  const title = sentence.length > 90 ? `${sentence.slice(0, 88).replace(/\s+\S*$/, '')}…` : sentence;
  const html = clean.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('\n');
  return { title, html };
}

async function socialItems(log) {
  const s = load().settings;
  const m = state.meta;
  if (s.social === 'off' || !m || !m.token) return [];
  const cutoff = Date.now() - SOCIAL_DAYS * 864e5;
  const out = [];
  const seenText = new Set();
  const add = (key, text, when, picture, link, from) => {
    if (Date.parse(when) < cutoff || String(text || '').trim().length < 40) return;
    // The same words on Facebook and Instagram are one post, whichever was written first.
    const sig = String(text).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (state.done[key]) { seenText.add(sig); return; }
    if (seenText.has(sig) || Object.values(state.done).some((d) => d.sig === sig)) {
      state.done[key] = { at: new Date().toISOString(), note: 'the same post on the other network', sig };
      return;
    }
    seenText.add(sig);
    const { title, html } = fromCaption(text);
    out.push({
      key, sig, mode: s.social, kind: 'club', source: from, picture, title,
      html: `${html}\n<p><em>First posted on the club's <a href="${esc(link)}">${from === 'instagram' ? 'Instagram' : 'Facebook page'}</a>.</em></p>`,
      tags: ['Club news', from === 'instagram' ? 'Instagram' : 'Facebook'],
      alt: `Photo from Pontardawe RFC's ${from === 'instagram' ? 'Instagram' : 'Facebook page'}`,
      publishAt: posts.nowUK(),
    });
  };
  try {
    const fb = await graph(`/${encodeURIComponent(m.pageId)}/posts?fields=id,message,created_time,permalink_url,full_picture&limit=15`, m.token);
    for (const p of fb.data || []) add(`fb-${p.id}`, p.message, p.created_time, p.full_picture, p.permalink_url, 'facebook');
  } catch (e) {
    log.errors.push(`Facebook: ${e.message}`);
  }
  if (m.igId) {
    try {
      const ig = await graph(`/${encodeURIComponent(m.igId)}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=15`, m.token);
      for (const p of ig.data || []) add(`ig-${p.id}`, p.caption, p.timestamp, p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url, p.permalink, 'instagram');
    } catch (e) {
      log.errors.push(`Instagram: ${e.message}`);
    }
  }
  return out;
}

/** Stories that name the club, to read in the admin (never posted by themselves). */
async function checkMentions(log) {
  if (load().settings.mentions === 'off') return;
  try {
    const r = await fetch(NEWS_RSS, { headers: { 'User-Agent': 'pontardawerfc.com (club news)' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${r.status}`);
    const xml = await r.text();
    const tag = (s, t) => ((s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    const cutoff = Date.now() - MENTION_DAYS * 864e5;
    let added = 0;
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const link = tag(m[1], 'link');
      const date = Date.parse(tag(m[1], 'pubDate'));
      if (!/^https:\/\//.test(link) || !(date >= cutoff)) continue;
      const id = crypto.createHash('sha1').update(link).digest('hex').slice(0, 12);
      if (state.mentions.some((x) => x.id === id)) continue;
      const source = tag(m[1], 'source');
      const title = tag(m[1], 'title').replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
      state.mentions.unshift({ id, title: title.slice(0, 200), source: source.slice(0, 80), link, date: new Date(date).toISOString(), found: new Date().toISOString(), dismissed: false });
      added += 1;
    }
    state.mentions = state.mentions.slice(0, 60);
    if (added) log.notes.push(`${plural(added, 'new story', 'new stories')} naming the club, to read at /admin/auto`);
  } catch (e) {
    log.errors.push(`News search: ${e.message}`);
  }
}

// ---- Writing the posts -------------------------------------------------------------

async function picture(item) {
  const { savePhoto } = require('./uploads');
  if (item.card) {
    const { card } = require('./match_card');
    return savePhoto(await card(item.card), item.alt);
  }
  if (item.picture && /^https:\/\//.test(item.picture)) {
    const r = await fetch(item.picture, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`photo ${r.status}`);
    return savePhoto(Buffer.from(await r.arrayBuffer()), item.alt);
  }
  return null;
}

async function write(item, log) {
  let photo = null;
  try { photo = await picture(item); } catch (e) { log.errors.push(`${item.title}: picture not made (${e.message})`); }
  const post = posts.save({
    title: item.title,
    html: item.html,
    summary: item.summary || '',
    seoTitle: item.seoTitle || '',
    tags: item.tags,
    kind: item.kind,
    gallery: photo ? [photo.name] : [],
    event: item.event || null,
    publishAt: item.publishAt || posts.nowUK(),
    status: item.mode === 'publish' ? 'published' : 'draft',
  }, { author: 'Automatic news', extra: { origin: 'auto', source: item.source, autoKey: item.key } });
  state.done[item.key] = { at: new Date().toISOString(), postId: post.id, ...(item.sig ? { sig: item.sig } : {}) };
  log.made.push({ key: item.key, id: post.id, title: post.title, slug: post.slug, status: post.status });
  return post;
}

/** One check of every source. Returns what it did (also kept for /admin/auto). */
async function run({ why = 'schedule' } = {}) {
  if (running) return running;
  running = (async () => {
    load();
    const started = Date.now();
    const log = { at: new Date().toISOString(), why, made: [], skipped: [], notes: [], errors: [] };
    try {
      if (!wru.fixtures().updated || Date.now() - Date.parse(wru.fixtures().updated) > 3600e3) await wru.refresh();
      const items = [...wruItems(log), ...(await socialItems(log))];
      for (const item of items) await write(item, log);
      await checkMentions(log);
    } catch (e) {
      log.errors.push(String(e.message || e).slice(0, 300));
    }
    log.ms = Date.now() - started;
    state.runs = [log, ...state.runs].slice(0, 40);
    save();
    if (log.made.length && content) content();
    if (log.made.length || log.errors.length) console.log(`autonews (${why}): ${log.made.length} written, ${log.errors.length} problem(s)`);
    return log;
  })();
  try { return await running; } finally { running = null; }
}

/** Every three hours, the first a few minutes after the site starts. */
function start(refresh) {
  content = refresh;
  if (timer || process.env.AUTONEWS_OFF) return;
  setTimeout(() => run({ why: 'start' }).catch(() => {}), 3 * 60 * 1000).unref();
  timer = setInterval(() => run().catch(() => {}), EVERY);
  timer.unref();
}

// ---- For /admin/auto ---------------------------------------------------------------

function settings(next) {
  load();
  if (next) {
    for (const k of ['results', 'previews', 'social']) if (MODES.includes(next[k])) state.settings[k] = next[k];
    if (['on', 'off'].includes(next.mentions)) state.settings.mentions = next.mentions;
    save();
  }
  return state.settings;
}

/** Check a Page token with Meta and keep it (with the Page's Instagram account, if any). */
async function connectMeta(pageId, token) {
  load();
  pageId = String(pageId || '').trim();
  token = String(token || '').trim();
  if (!/^\d{5,25}$/.test(pageId)) throw new Error('The Page ID is a number, found in the Page’s About section (Page transparency).');
  if (token.length < 50) throw new Error('That does not look like a Page access token.');
  const page = await graph(`/${pageId}?fields=name,instagram_business_account`, token);
  await graph(`/${pageId}/posts?fields=id&limit=1`, token); // can read its posts
  state.meta = { pageId, token, pageName: page.name, igId: page.instagram_business_account ? page.instagram_business_account.id : null, connectedAt: new Date().toISOString() };
  save();
  return { pageName: page.name, instagram: Boolean(state.meta.igId) };
}
function disconnectMeta() {
  load();
  state.meta = null;
  save();
}

function status() {
  load();
  const m = state.meta;
  return {
    settings: state.settings,
    meta: m ? { pageName: m.pageName, instagram: Boolean(m.igId), connectedAt: m.connectedAt } : null,
    runs: state.runs,
    mentions: state.mentions.filter((x) => !x.dismissed),
    nextRun: state.runs[0] ? new Date(Date.parse(state.runs[0].at) + EVERY).toISOString() : null,
    running: Boolean(running),
  };
}
function dismissMention(id) {
  load();
  const m = state.mentions.find((x) => x.id === id);
  if (m) { m.dismissed = true; save(); }
}
/** A draft about a story in the news: its headline and a link to it, credited, for an editor to write up. */
function draftFromMention(id, author) {
  load();
  const m = state.mentions.find((x) => x.id === id);
  if (!m) throw new Error('That story is no longer in the list.');
  const post = posts.save({
    title: m.title,
    html: `<p>${esc(m.source)} reported on ${esc(longDay(m.date.slice(0, 10)))}: <a href="${esc(m.link)}">${esc(m.title)}</a>.</p>`,
    kind: '',
    tags: ['In the news'],
    status: 'draft',
  }, { author, extra: { origin: 'auto', source: 'news', autoKey: `news-${m.id}` } });
  m.dismissed = true;
  save();
  return post;
}

/** For tests. */
function reset() { state = null; }

module.exports = {
  run, start, settings, connectMeta, disconnectMeta, status, dismissMention, draftFromMention, resultArticle, previewArticle, fromCaption, reset, FILE,
};
