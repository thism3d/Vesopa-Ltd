/**
 * /admin — the staff console.
 *
 * Login, the shared locals every screen needs, and the mount points for the
 * feature routers. Each screen lives in its own file; this one only decides
 * who gets in and what the templates can see.
 *
 * Security posture, all of which the PHP panel lacked:
 *
 *   - parameterised queries everywhere (its login interpolated the username,
 *     so `" OR "1"="1` signed you in as the first admin);
 *   - bcrypt, with a one-time upgrade path for the plaintext rows migrated
 *     out of the old database;
 *   - one HMAC-signed cookie keyed from the environment, re-checked against
 *     the database on every request, instead of three AES cookies encrypted
 *     with a key committed to the repo;
 *   - POST-only logout, so a third-party <img> cannot sign you out;
 *   - role checks on the endpoints, not just on the buttons. The PHP hid the
 *     admin-management UI from Subadmins but left the routes open.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const config = require('../config');
const {
  issue, clear, read, authenticate, requireAdmin, requireFullAdmin,
} = require('../admin-auth');
const { formatDate, back, readFlash, navCounts, str } = require('./util');

const { dashboardRouter } = require('./dashboard');
const { officesRouter } = require('./offices');
const { plansRouter } = require('./plans');
const { usersRouter } = require('./users');
const { blogRouter } = require('./blog');
const { filesRouter, filesFor } = require('./files');
const { requestsRouter } = require('./requests');

const router = express.Router();

// ---- Login ----------------------------------------------------------------

router.get('/', (req, res) => {
  if (read(req)) return res.redirect('/admin/dashboard');
  res.render('admin/login', { error: null, APP_VERSION: config.APP_VERSION });
});

router.post('/', async (req, res, next) => {
  const username = str(req.body.username, 40);
  const password = String(req.body.password || '');

  const fail = (error) =>
    res.status(401).render('admin/login', { error, APP_VERSION: config.APP_VERSION });

  if (username.length < 8 || password.length < 8) {
    return fail('Enter a valid username and password.');
  }

  try {
    const admin = await authenticate(username, password);
    if (!admin) return fail('Those details were not recognised.');

    issue(res, admin);
    res.redirect(303, '/admin/dashboard');
  } catch (e) {
    next(e);
  }
});

/**
 * POST, not GET.
 * A GET logout can be fired by any image tag on any site, which is how the PHP
 * panel could be signed out by a third party.
 */
router.post('/logout', (_req, res) => {
  clear(res);
  res.redirect(303, '/admin');
});

// ---- Everything below needs a signed-in admin -----------------------------

router.use(requireAdmin);

/**
 * Locals every admin template reaches for.
 *
 * The shell renders the sidebar, the flash slot and the signed-in name on every
 * screen, so a route that forgot to pass `counts` or `flash` would throw at
 * render time rather than degrade. Defaulting them here means a screen only has
 * to supply what is actually its own.
 */
router.use((req, res, next) => {
  // SITE_URL is deliberately NOT set here. server.js already resolved it —
  // configured value if it names a reachable host, the request's own origin
  // otherwise — and re-assigning config.SITE_URL over the top put it back to
  // whatever the .env said. On the live server that is still localhost:5065,
  // which is what the blog editor was printing under the URL field: the admin
  // was told a post would live at http://localhost:5065/blog/…
  res.locals.BACKOFFICE_URL = config.BACKOFFICE_URL;
  res.locals.CONTACT = config.CONTACT;
  res.locals.APP_VERSION = config.APP_VERSION;
  res.locals.counts = { demos: 0, drafts: 0, expiring: 0 };
  res.locals.flash = readFlash(req);
  res.locals.nav = '';
  next();
});

// Bare /admin/home from an old bookmark or an email link.
router.get('/home', (_req, res) => res.redirect(302, '/admin/dashboard'));

router.use(dashboardRouter);
router.use(officesRouter);
router.use(plansRouter);
router.use(usersRouter);
router.use(blogRouter);
router.use(filesRouter);
router.use(requestsRouter);

// ---- Settings -------------------------------------------------------------

router.get('/settings', async (req, res, next) => {
  try {
    let others = [];
    if (req.admin.status === 'Admin') {
      [others] = await pool.query(
        `SELECT id, dateadded, fullname, username, status, enabled
         FROM admin_table
         WHERE username <> ? AND username <> 'demoadmin'
         ORDER BY id`,
        [req.admin.username]
      );
    }

    res.render('admin/settings', {
      title: 'Admins & Profile | Vesopa Admin',
      heading: 'Admins & Profile',
      nav: 'settings',
      counts: await navCounts(),
      flash: readFlash(req),
      others,
      formatDate,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Your own name and username.
 * The PHP gated this on being a full Admin, which meant a Subadmin was shown
 * the form and then silently ignored. Everyone can edit their own profile;
 * nobody can edit anyone else's.
 */
router.post('/settings/profile', async (req, res, next) => {
  const fullname = str(req.body.admin_user_fullname, 255);
  const username = str(req.body.admin_user_username, 20);

  if (fullname.length < 5 || username.length < 8) {
    return back(res, '/admin/settings', {
      err: 'Name must be 5 characters or more, username 8 to 20.',
    });
  }

  try {
    await pool.query('UPDATE admin_table SET username = ?, fullname = ? WHERE id = ?', [
      username, fullname, req.admin.id,
    ]);
    // The session carries the old username, so re-issue it or the header and
    // the next password check disagree with the database.
    issue(res, { ...req.admin, fullname, username });
    back(res, '/admin/settings', { ok: 'Profile saved.' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, '/admin/settings', { err: 'That username is taken.' });
    }
    next(e);
  }
});

/** Change your own password. Requires the current one. */
router.post('/settings/password', async (req, res, next) => {
  const current = String(req.body.currentpassword || '');
  const next_ = String(req.body.newpassword || '');

  if (current.length < 8 || next_.length < 8) {
    return res.json({ status: 'FAILED', message: 'Both passwords must be at least 8 characters.' });
  }

  try {
    const verified = await authenticate(req.admin.username, current);
    if (!verified || verified.id !== req.admin.id) {
      return res.json({ status: 'FAILED', message: 'The current password is wrong.' });
    }

    await pool.query('UPDATE admin_table SET password = ? WHERE id = ?', [
      await bcrypt.hash(next_, 12),
      req.admin.id,
    ]);
    clear(res);
    res.json({ status: 'SUCCESS' });
  } catch (e) {
    next(e);
  }
});

// Managing other admins — full Admins only, enforced here and not just in the UI.

router.post('/settings/admins/new', requireFullAdmin, async (req, res, next) => {
  const fullname = str(req.body.admin_fullname, 255);
  const username = str(req.body.admin_username, 20);
  const password = String(req.body.admin_password || '');

  if (fullname.length < 5 || username.length < 8 || password.length < 8) {
    return back(res, '/admin/settings', { err: 'Check the name, username and password lengths.' });
  }

  try {
    await pool.query(
      `INSERT INTO admin_table (fullname, username, status, password, enabled)
       VALUES (?, ?, 'Subadmin', ?, 'Y')`,
      [fullname, username, await bcrypt.hash(password, 12)]
    );
    back(res, '/admin/settings', { ok: `${fullname} added as a Subadmin.` });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, '/admin/settings', { err: 'That username is taken.' });
    }
    next(e);
  }
});

router.post('/settings/admins/delete', requireFullAdmin, async (req, res, next) => {
  const id = Number.parseInt(req.body.admin_user_id, 10);
  // Deleting yourself locks you out of the panel you are standing in.
  if (!Number.isInteger(id) || id === req.admin.id) {
    return back(res, '/admin/settings', { err: 'You cannot remove your own account.' });
  }

  try {
    await pool.query('DELETE FROM admin_table WHERE id = ?', [id]);
    back(res, '/admin/settings', { ok: 'Admin removed.' });
  } catch (e) {
    next(e);
  }
});

router.post('/settings/admins/status', requireFullAdmin, async (req, res, next) => {
  const id = Number.parseInt(req.body.my_id, 10);
  const status = String(req.body.new_status || '');

  if (!Number.isInteger(id) || !['Admin', 'Subadmin'].includes(status) || id === req.admin.id) {
    return res.json({ status: 'FAILED' });
  }

  try {
    await pool.query('UPDATE admin_table SET status = ? WHERE id = ?', [status, id]);
    res.json({ status: 'SUCCESS' });
  } catch (e) {
    next(e);
  }
});

module.exports = { adminRouter: router, filesFor };
