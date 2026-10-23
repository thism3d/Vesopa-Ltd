/**
 * /admin: where the club writes its news (2026-10-23).
 *
 *   /admin/setup            the first login, with ADMIN_SETUP_CODE (closes once anyone exists)
 *   /admin/login            sign in
 *   /admin                  every post: published, scheduled and drafts
 *   /admin/posts/new        write one; /admin/posts/:id edits it
 *   /admin/preview          the post as it would look, before it is saved
 *   /admin/upload           a photo, made ready by src/uploads.js
 *   /admin/editors          who may sign in (owners only)
 *   /admin/account          change your own password
 *
 * A save reaches the site at once: the home page's latest news, /news, the
 * post's own page, What's On, the feed and the sitemap (src/content.js).
 */
'use strict';

const express = require('express');
const multer = require('multer');
const auth = require('./admin_auth');
const views = require('./admin_views');
const posts = require('./posts');
const content = require('./content');
const pages = require('./pages');
const autonews = require('./autonews');
const screens = require('./screen_import');

const form = express.urlencoded({ extended: false, limit: '2mb', parameterLimit: 400 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const shotsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 20 } });

const nextOf = (s) => (/^\/admin(\/|$|\?)/.test(String(s || '')) ? String(s) : '/admin');
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ip = (req) => req.ip || 'x';

/** The editor's form as posts.build() takes it. */
function fromForm(b, action) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.pub_day || '') ? b.pub_day : null;
  const time = /^\d{2}:\d{2}/.test(b.pub_time || '') ? b.pub_time.slice(0, 5) : '09:00';
  return {
    title: b.title,
    html: b.html,
    summary: b.summary,
    gallery: list(b.gallery),
    kind: b.kind,
    slug: b.slug,
    seoTitle: b.seoTitle,
    publishAt: day ? `${day}T${time}` : '',
    status: action === 'publish' ? 'published' : 'draft',
    event: b.ev_day ? { day: b.ev_day, time: /^\d{2}:\d{2}/.test(b.ev_time || '') ? b.ev_time.slice(0, 5) : '', place: b.ev_place, price: b.ev_price, note: b.ev_note } : null,
    cta: b.cta_label && b.cta_href ? { label: b.cta_label, href: b.cta_href } : null,
    tags: b.tags,
  };
}

/** Each photo's description, from its "alt:<name>" field. */
function saveAlts(b) {
  for (const [k, v] of Object.entries(b)) if (k.startsWith('alt:')) posts.setAlt(k.slice(4), v);
}

function adminRoutes() {
  const r = express.Router();
  r.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });
  const send = (res, html, status = 200) => res.status(status).type('html').send(html);

  // ---- First login and signing in ----------------------------------------------------
  r.get('/setup', (req, res) => {
    if (auth.anyone()) return res.redirect(303, '/admin/login');
    if (!auth.SETUP_CODE()) return send(res, views.loginPage({ error: 'The admin is not set up yet: ADMIN_SETUP_CODE is missing from the site settings.' }), 503);
    return send(res, views.setupPage());
  });
  r.post('/setup', form, (req, res) => {
    const b = req.body || {};
    if (auth.anyone()) return res.redirect(303, '/admin/login');
    const code = auth.SETUP_CODE();
    if (!auth.sameSite(req) || auth.blocked(`setup:${ip(req)}`)) return send(res, views.setupPage({ error: 'Too many tries. Wait 15 minutes.', form: b }), 429);
    if (!code || !auth.same(String(b.code || '').trim(), code)) {
      auth.failed(`setup:${ip(req)}`);
      return send(res, views.setupPage({ error: 'That setup code is not right.', form: b }), 400);
    }
    try {
      const user = auth.addUser({ email: b.email, name: b.name, password: b.password, role: 'owner' });
      auth.issue(res, user, req);
      return res.redirect(303, '/admin?flash=welcome');
    } catch (e) {
      return send(res, views.setupPage({ error: e.message, form: b }), 400);
    }
  });

  r.get('/login', (req, res) => {
    if (!auth.anyone()) return res.redirect(303, '/admin/setup');
    if (auth.readCookie(req)) return res.redirect(303, nextOf(req.query.next));
    return send(res, views.loginPage({ next: nextOf(req.query.next), flash: req.query.out ? 'You are signed out.' : '' }));
  });
  r.post('/login', form, (req, res) => {
    const b = req.body || {};
    // Eight tries for one email from one place; forty from one place (a clubhouse shares one address).
    const key = `login:${ip(req)}|${String(b.email || '').trim().toLowerCase()}`;
    const wide = `login:${ip(req)}`;
    const again = (error, status) => send(res, views.loginPage({ error, email: b.email, next: nextOf(b.next) }), status);
    if (!auth.sameSite(req)) return again('Please sign in from this page.', 403);
    if (auth.blocked(key) || auth.blocked(wide, 40)) return again('Too many tries. Wait 15 minutes and try again.', 429);
    const user = auth.verify(b.email, b.password);
    if (!user) {
      auth.failed(key);
      auth.failed(wide);
      return again('That email address and password do not match.', 401);
    }
    auth.issue(res, user, req);
    return res.redirect(303, nextOf(b.next));
  });

  // ---- Everything below needs a login --------------------------------------------------
  // multipart uploads carry their token in a header; forms in _csrf.
  r.post('/upload', auth.required, upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a photo.' });
    try {
      const saved = await require('./uploads').savePhoto(req.file.buffer, req.body && req.body.alt);
      content.refresh();
      return res.json(saved);
    } catch (e) {
      console.error('admin upload:', String(e.message || e).slice(0, 200));
      return res.status(400).json({ error: /not a photo/.test(e.message) ? e.message : 'That photo could not be used. Try a JPG or PNG.' });
    }
  });
  // Screenshots of the club's posts become drafts (src/screen_import.js).
  r.post('/import', auth.required, shotsUpload.fields([{ name: 'shots', maxCount: 10 }, { name: 'photos', maxCount: 10 }]), async (req, res) => {
    const f = req.files || {};
    try {
      const result = await screens.importScreens(f.shots || [], { author: req.admin.name, photos: f.photos || [] });
      content.refresh();
      return send(res, views.importPage({ user: req.admin, csrf: res.locals.csrf, result }));
    } catch (e) {
      console.error('admin import:', String(e.message || e).slice(0, 200));
      const msg = /AI daily spending cap/.test(e.message) ? 'Today\'s limit for reading screenshots is used up. Try again tomorrow.' : e.message;
      return send(res, views.importPage({ user: req.admin, csrf: res.locals.csrf, error: msg }), 400);
    }
  });
  r.use(form, auth.required);
  r.get('/import', (req, res) => send(res, views.importPage({ user: req.admin, csrf: res.locals.csrf })));
  r.get('/screens/:name', (req, res, next) => {
    const f = screens.screenPath(req.params.name);
    return f ? res.sendFile(f) : next();
  });

  r.post('/logout', (req, res) => {
    auth.clear(res);
    res.redirect(303, '/admin/login?out=1');
  });

  const FLASH = {
    welcome: 'Welcome! Your login is made. Write your first post with “New post”.',
    saved: 'Saved.', published: 'Published: it is on the site now.', scheduled: 'Scheduled: it will appear on the site by itself at the time you chose.',
    draft: 'Saved as a draft: only editors can see it.', deleted: 'Post deleted.',
  };
  r.get('/', (req, res) => {
    const show = ['all', 'live', 'sched', 'draft'].includes(req.query.show) ? req.query.show : 'all';
    send(res, views.listPage({
      user: req.admin, csrf: res.locals.csrf, posts: posts.all(), q: String(req.query.q || '').slice(0, 80), show, flash: FLASH[req.query.flash] || '',
    }));
  });

  r.get('/posts/new', (req, res) => send(res, views.editorPage({ user: req.admin, csrf: res.locals.csrf, images: posts.images() })));
  r.get('/posts/:id', (req, res, next) => {
    const post = posts.get(req.params.id);
    if (!post) return next();
    return send(res, views.editorPage({ user: req.admin, csrf: res.locals.csrf, post, images: posts.images(), flash: FLASH[req.query.flash] || '' }));
  });

  const saveRoute = (id) => (req, res) => {
    const b = req.body || {};
    const action = b.action === 'publish' ? 'publish' : 'draft';
    const input = fromForm(b, action);
    try {
      saveAlts(b);
      const post = posts.save(input, { id, author: req.admin.name });
      content.refresh();
      const flash = post.status !== 'published' ? 'draft' : post.publishAt > posts.nowUK() ? 'scheduled' : 'published';
      return res.redirect(303, `/admin/posts/${post.id}?flash=${flash}`);
    } catch (e) {
      const post = id ? posts.get(id) : null;
      const back = { ...(post || {}), ...input, gallery: input.gallery, publishAt: input.publishAt || (post && post.publishAt),
        event: input.event ? { ...input.event, start: input.event.time ? `${input.event.day}T${input.event.time}` : input.event.day } : null };
      return send(res, views.editorPage({ user: req.admin, csrf: res.locals.csrf, post, form: back, images: posts.images(), error: e.message }), 400);
    }
  };
  r.post('/posts', saveRoute(null));
  r.post('/posts/:id', (req, res, next) => (posts.get(req.params.id) ? saveRoute(req.params.id)(req, res) : next()));

  r.post('/posts/:id/delete', (req, res) => {
    posts.remove(req.params.id);
    content.refresh();
    res.redirect(303, '/admin?flash=deleted');
  });

  // The post as it would look, unsaved, in a new tab (never indexed).
  r.post('/preview', (req, res) => {
    const b = req.body || {};
    try {
      saveAlts(b);
      content.refresh();
      const id = b.id && posts.get(b.id) ? b.id : null;
      const post = posts.view(posts.build(fromForm(b, 'publish'), { id, author: req.admin.name }));
      return send(res, pages.articlePage(post, { preview: true }).replace('<main id="main">', '<main id="main"><p style="position:sticky;top:0;z-index:60;margin:0;padding:10px 16px;text-align:center;font:700 15px Montserrat,sans-serif;background:#f2c14e;color:#3a2a00">Preview: not saved yet. Close this tab to go back to the editor.</p>'));
    } catch (e) {
      return send(res, `<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">${String(e.message).replace(/</g, '&lt;')}</p>`, 400);
    }
  });

  // ---- The automatic news (src/autonews.js) -----------------------------------------
  const auto = (req, res, extra = {}, status = 200) => send(res, views.autoPage({ user: req.admin, csrf: res.locals.csrf, st: autonews.status(), ...extra }), status);
  const AUTO_FLASH = { saved: 'Saved.', dismissed: 'Taken off the list.' };
  const ownerOnly = (req, res, next) => (req.admin.role === 'owner' ? next() : res.status(403).type('text/plain').send('Only an owner login can change this.'));
  r.get('/auto', (req, res) => auto(req, res, { flash: AUTO_FLASH[req.query.flash] || '' }));
  r.post('/auto/run', async (req, res) => {
    const log = await autonews.run({ why: 'button' });
    const made = log.made.length
      ? `${log.made.length} written: ${log.made.map((m) => `“${m.title}” (${m.status === 'published' ? 'published' : 'draft'})`).join(', ')}.`
      : 'Checked: nothing new to write.';
    auto(req, res, { flash: made, error: log.errors.join(' · ') });
  });
  r.post('/auto/settings', ownerOnly, (req, res) => {
    autonews.settings(req.body || {});
    res.redirect(303, '/admin/auto?flash=saved');
  });
  r.post('/auto/mentions/:id/dismiss', (req, res) => {
    autonews.dismissMention(req.params.id);
    res.redirect(303, '/admin/auto?flash=dismissed');
  });
  r.post('/auto/mentions/:id/draft', (req, res) => {
    try {
      const post = autonews.draftFromMention(req.params.id, req.admin.name);
      content.refresh();
      return res.redirect(303, `/admin/posts/${post.id}?flash=draft`);
    } catch (e) {
      return auto(req, res, { error: e.message }, 400);
    }
  });

  // ---- People ------------------------------------------------------------------------
  r.get('/account', (req, res) => send(res, views.accountPage({ user: req.admin, csrf: res.locals.csrf })));
  r.post('/account', (req, res) => {
    const b = req.body || {};
    const again = (error, flash = '') => send(res, views.accountPage({ user: req.admin, csrf: res.locals.csrf, error, flash }), error ? 400 : 200);
    if (!auth.verify(req.admin.email, b.current)) return again('Your current password is not right.');
    try {
      auth.setPassword(req.admin.id, b.password);
      auth.issue(res, { ...req.admin, ver: req.admin.ver + 1 }, req);
      return again('', 'Password changed.');
    } catch (e) {
      return again(e.message);
    }
  });

  const owner = (req, res, next) => (req.admin.role === 'owner' ? next() : res.status(403).type('text/plain').send('Only an owner login can manage editors.'));
  const editors = (req, res, extra = {}, status = 200) => send(res, views.editorsPage({ user: req.admin, csrf: res.locals.csrf, users: auth.users(), ...extra }), status);
  r.get('/editors', owner, (req, res) => editors(req, res));
  r.post('/editors', owner, (req, res) => {
    const b = req.body || {};
    try {
      const u = auth.addUser({ email: b.email, name: b.name, password: b.password, role: b.role });
      return editors(req, res, { flash: `${u.name} can now sign in at pontardawerfc.com/admin with ${u.email} and the password you chose.` });
    } catch (e) {
      return editors(req, res, { error: e.message, form: b }, 400);
    }
  });
  r.post('/editors/:id/password', owner, (req, res) => {
    try {
      auth.setPassword(req.params.id, req.body && req.body.password);
      if (req.params.id === req.admin.id) auth.issue(res, { ...req.admin, ver: req.admin.ver + 1 }, req);
      return editors(req, res, { flash: 'Password set. Give it to them in person or by phone, not by email.' });
    } catch (e) {
      return editors(req, res, { error: e.message }, 400);
    }
  });
  r.post('/editors/:id/delete', owner, (req, res) => {
    try {
      auth.removeUser(req.params.id);
      return editors(req, res, { flash: 'Login removed.' });
    } catch (e) {
      return editors(req, res, { error: e.message }, 400);
    }
  });

  r.use((req, res) => res.status(404).type('html').send(views.loginPage({ error: 'That page is not in the admin.' })));
  return r;
}

module.exports = { adminRoutes };
