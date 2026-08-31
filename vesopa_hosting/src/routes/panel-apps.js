/**
 * Applications — install one, run it, and see whether it is actually working.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * Everything between "you have hosting" and "you have a website". A customer
 * could create a database, open a terminal and upload files, and every one of
 * those is a tool for somebody who already knows what they are doing. The
 * person who bought hosting to put WordPress on it had no button.
 *
 * And the Node side, which is the reason this panel exists at all, had nothing:
 * the node has three Node versions, a pm2 daemon per account and a wrapper that
 * creates apps, and none of it was reachable from the panel. You could start a
 * Node app over SSH and then have no way of knowing whether it was up.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DECISION THAT SHAPES THIS WHOLE FILE
 * ---------------------------------------------------------------------------
 * "Working" is a claim, and this panel only makes it when it is true. pm2 will
 * happily report `online` for a process that is crash-looping, that never bound
 * its port, or that throws on every request — and the panel that repeats that
 * word next to a green dot has told a customer their broken site is fine. They
 * believe it, they go looking somewhere else, and the ticket arrives two days
 * later. So the status shown here is pm2's answer AND a restart count read
 * against uptime AND an HTTP probe of the port, and the pessimistic one wins.
 * See health() in src/apps.js.
 */

const express = require('express');
const crypto = require('node:crypto');

const db = require('../db');
const apps = require('../apps');
const catalogue = require('../app-catalogue');
const hestia = require('../integrations/hestia');
const { flash, rateLimited } = require('../http-utils');

const router = express.Router();

/**
 * The customer's websites, as somewhere an application can go.
 *
 * Sourced from our own `domains` table rather than from the node, because that
 * is the list the rest of the panel shows and the two disagreeing is worse than
 * either being slightly stale. Where the node is live its own list is merged in
 * so that a site created outside the panel is still installable-to.
 */
async function sitesFor(req) {
  const rows = await db.query(
    `SELECT domain, source, status, ssl_status FROM domains
      WHERE customer_id = ? AND status <> 'removed' ORDER BY domain`,
    [req.customer.id],
  );
  const byName = new Map(rows.map((r) => [r.domain, { ...r, onNode: false }]));

  if (hestia.isLive() && req.customer.hestia_user) {
    try {
      const live = await hestia.listWebDomains(req.customer.hestia_user);
      live.forEach((site) => {
        const existing = byName.get(site.domain);
        if (existing) Object.assign(existing, { onNode: true, ssl: site.ssl, suspended: site.suspended });
        else byName.set(site.domain, { domain: site.domain, source: 'node', status: 'active', onNode: true });
      });
    } catch {
      // The node being unreachable must not empty the picker. Our own list is
      // still the right answer, just without the confirmation.
    }
  }
  return [...byName.values()];
}

/** The one active service, for the tabs and the plan allowance. */
async function serviceFor(req) {
  return db.one(
    `SELECT s.*, p.name AS plan_name, p.\`databases\` AS plan_databases
       FROM services s JOIN plans p ON p.id = s.plan_id
      WHERE s.customer_id = ? AND s.status = 'active'
      ORDER BY s.created_at ASC LIMIT 1`,
    [req.customer.id],
  );
}

/**
 * A database password, generated rather than asked for.
 *
 * Same alphabet and the same reasoning as panel-databases.js: this string ends
 * up inside `mysql://user:pass@host/db` in wp-config.php and in half a dozen
 * .env files, so the characters that break a DSN or an unquoted shell word are
 * not in it.
 */
function makePassword(len = 24) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_.';
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len && i < bytes.length; i++) {
    const v = bytes[i];
    if (v >= 256 - (256 % alphabet.length)) continue;
    out += alphabet[v % alphabet.length];
  }
  return out;
}

/** A short, legal database name derived from the app and the site. */
function dbNameFor(slug, domain) {
  const base = `${slug}${domain}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  return `${base || 'app'}${crypto.randomBytes(2).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const [service, sites, nodeApps] = await Promise.all([
      serviceFor(req),
      sitesFor(req),
      apps.nodeApps(req.customer.hestia_user).catch(() => []),
    ]);

    res.render('panel/apps', {
      title: 'Install an app',
      robots: 'noindex',
      service,
      sites,
      nodeApps,
      groups: catalogue.GROUPS,
      appsByKind: Object.fromEntries(
        catalogue.GROUPS.map((g) => [g.kind, catalogue.list({ kind: g.kind })]),
      ),
      mock: !apps.isLive(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

router.get('/install/:slug', async (req, res, next) => {
  try {
    const app = catalogue.find(req.params.slug);
    if (!app) return res.status(404).render('404', { title: 'Not found', robots: 'noindex' });

    const [service, sites, runtimes] = await Promise.all([
      serviceFor(req),
      sitesFor(req),
      apps.runtimes(req.customer.hestia_user).catch(() => ({ php: [], node: [] })),
    ]);

    return res.render('panel/app-install', {
      title: `Install ${app.name}`,
      robots: 'noindex',
      app,
      service,
      sites,
      runtimes,
      mock: !apps.isLive(),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/install/:slug', async (req, res, next) => {
  const app = catalogue.find(req.params.slug);
  if (!app) return res.status(404).redirect('/panel/apps');

  const back = `/panel/apps/install/${app.slug}`;
  try {
    /*
     * An install is minutes of CPU, a few hundred megabytes of download and a
     * write into somebody's web root. Five in ten minutes is far more than
     * anybody legitimately needs and well short of anything that would annoy a
     * customer setting up a new account.
     */
    if (rateLimited(req.ip, 'app-install', { max: 5, windowMs: 600_000 })) {
      flash(res, 'That is a lot of installs at once. Give it a few minutes.', 'error');
      return res.redirect(back);
    }

    const user = await apps.accountFor(req.customer);
    const service = await serviceFor(req);
    const domain = String(req.body.domain || '').trim().toLowerCase();
    const sites = await sitesFor(req);
    if (!sites.some((s) => s.domain === domain)) {
      flash(res, 'Choose one of your own websites to install it on.', 'error');
      return res.redirect(back);
    }

    /*
     * "Yes, replace what is there" is a separate tick rather than a second
     * confirmation page. The install never deletes anything — the broker moves
     * the old web root to ~/.vesopa/replaced — but somebody whose live site
     * goes to a WordPress setup screen does not care that it is recoverable if
     * nobody warned them first.
     */
    if (!req.body.confirm) {
      flash(res, 'Tick the box to confirm this replaces whatever is on that site now.', 'error');
      return res.redirect(back);
    }

    // The database, made here rather than in the broker: creating one is a
    // Hestia call, it counts against the plan's allowance, and the panel
    // already has all the code for both.
    let database = null;
    let dbUser = null;
    let dbPassword = null;
    if (app.needs.database) {
      const name = dbNameFor(app.slug, domain);
      dbPassword = makePassword();
      try {
        const made = await hestia.addDatabase({
          username: user, name, dbUser: name, password: dbPassword, type: 'mysql',
        });
        database = made.database || `${user}_${name}`;
        dbUser = `${user}_${name}`;
      } catch (err) {
        flash(res, `The database could not be created: ${err.message}`, 'error');
        return res.redirect(back);
      }
    }

    const started = await apps.install(user, {
      slug: app.slug,
      domain,
      database,
      dbUser,
      dbPassword,
      phpVersion: req.body.php || null,
      nodeMajor: req.body.node || null,
    });

    /*
     * The database password is shown ONCE, on the progress page, and is never
     * written to our database. It is already inside the application's own
     * config file by the time the customer reads it, so the copy here is a
     * convenience rather than the only copy — and a table of plaintext database
     * passwords is a liability with no upside.
     */
    await db.query(
      `INSERT INTO app_installs (customer_id, service_id, job_id, slug, domain, database_name, status)
       VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      [req.customer.id, service?.id || null, started.job, app.slug, domain, database],
    ).catch(() => { /* history, not the mechanism — never block an install on it */ });

    if (database) {
      flash(res, 'Installing.', 'ok', { database, dbUser, dbPassword });
    }
    return res.redirect(`/panel/apps/jobs/${started.job}`);
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

/** The progress page. Polls itself; safe to close and come back to. */
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const user = await apps.accountFor(req.customer);
    const job = await apps.job(user, req.params.id);
    const record = await db.one(
      'SELECT * FROM app_installs WHERE customer_id = ? AND job_id = ? LIMIT 1',
      [req.customer.id, req.params.id],
    );
    const app = catalogue.find(job.slug || record?.slug);
    return res.render('panel/app-job', {
      title: app ? `Installing ${app.name}` : 'Installing',
      robots: 'noindex',
      job,
      app,
      record,
      domain: job.domain || record?.domain || '',
    });
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect('/panel/apps');
    }
    return next(err);
  }
});

/** The same thing as JSON, which is what the progress bar actually reads. */
router.get('/jobs/:id/status', async (req, res) => {
  try {
    const user = await apps.accountFor(req.customer);
    const job = await apps.job(user, req.params.id);
    if (job.finished) {
      await db.query(
        "UPDATE app_installs SET status = ?, finished_at = NOW() WHERE customer_id = ? AND job_id = ? AND status = 'running'",
        [job.state === 'done' ? 'done' : 'failed', req.customer.id, req.params.id],
      ).catch(() => {});
    }
    res.json(job);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Node applications
// ---------------------------------------------------------------------------

router.get('/node', async (req, res, next) => {
  try {
    const user = await apps.accountFor(req.customer).catch(() => null);
    const [list, runtimes] = await Promise.all([
      user ? apps.nodeApps(user) : [],
      user ? apps.runtimes(user).catch(() => ({ node: [] })) : { node: [] },
    ]);
    return res.render('panel/node-apps', {
      title: 'Node.js apps',
      robots: 'noindex',
      apps: list,
      runtimes,
      hasHosting: Boolean(user),
      mock: !apps.isLive(),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * One app's live state, as JSON.
 *
 * The list page polls this every few seconds. It is the cheapest thing here —
 * one pm2 jlist and one 2.5-second-capped socket probe — and it is what makes
 * the difference between a status somebody trusts and a page they have to
 * refresh and then still not believe.
 */
router.get('/node/status', async (req, res) => {
  try {
    const user = await apps.accountFor(req.customer);
    res.json({ ok: true, apps: await apps.nodeApps(user) });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

router.get('/node/:name', async (req, res, next) => {
  try {
    const user = await apps.accountFor(req.customer);
    const app = await apps.nodeApp(user, req.params.name);
    if (!app) {
      flash(res, 'There is no application by that name on this account.', 'error');
      return res.redirect('/panel/apps/node');
    }
    const [logs, env, packages] = await Promise.all([
      apps.nodeLogs(user, app.name).catch(() => ({ out: [], err: [] })),
      apps.readEnv(user, app.name).catch(() => ({ text: '' })),
      apps.plugins(user, { target: 'node', name: app.name }).catch(() => []),
    ]);
    return res.render('panel/node-app', {
      title: app.name,
      robots: 'noindex',
      app,
      logs,
      env: env.text,
      packages,
      mock: !apps.isLive(),
    });
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect('/panel/apps/node');
    }
    return next(err);
  }
});

router.post('/node/:name/action', async (req, res, next) => {
  const back = `/panel/apps/node/${encodeURIComponent(req.params.name)}`;
  try {
    const user = await apps.accountFor(req.customer);
    const action = String(req.body.action || '');
    await apps.nodeAction(user, req.params.name, action);
    const said = {
      start: 'Started.', stop: 'Stopped.', restart: 'Restarted.',
      reload: 'Reloaded with no downtime.', delete: 'Removed from pm2. The files are still there.',
    };
    flash(res, said[action] || 'Done.', 'ok');
    return res.redirect(action === 'delete' ? '/panel/apps/node' : back);
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

router.post('/node/:name/env', async (req, res, next) => {
  const back = `/panel/apps/node/${encodeURIComponent(req.params.name)}`;
  try {
    const user = await apps.accountFor(req.customer);
    await apps.writeEnv(user, req.params.name, req.body.env || '');
    /*
     * Saved and restarted in one action, deliberately. An environment file that
     * has been written but not loaded is the most confusing state this page can
     * be in: the customer changed the value, the page shows the new value, and
     * the running process still has the old one.
     */
    await apps.nodeAction(user, req.params.name, 'restart').catch(() => {});
    flash(res, 'Environment saved and the app restarted.', 'ok');
    return res.redirect(back);
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

router.post('/node/:name/packages', async (req, res, next) => {
  const back = `/panel/apps/node/${encodeURIComponent(req.params.name)}`;
  try {
    const user = await apps.accountFor(req.customer);
    await apps.pluginAction(user, {
      target: 'node',
      name: req.params.name,
      pkg: req.body.package,
      action: req.body.action === 'remove' ? 'remove' : 'add',
    });
    await apps.nodeAction(user, req.params.name, 'restart').catch(() => {});
    flash(res, req.body.action === 'remove' ? 'Package removed and the app restarted.' : 'Package installed and the app restarted.', 'ok');
    return res.redirect(back);
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Runtime — the language, its settings, and what is plugged into it
// ---------------------------------------------------------------------------

router.get('/runtime', async (req, res, next) => {
  try {
    const user = await apps.accountFor(req.customer).catch(() => null);
    const [sites, runtimes, nodeApps] = await Promise.all([
      sitesFor(req),
      user ? apps.runtimes(user).catch(() => ({ php: [], node: [], extensions: {} })) : { php: [], node: [], extensions: {} },
      user ? apps.nodeApps(user).catch(() => []) : [],
    ]);

    /*
     * Which site the page is looking at. A picker rather than a page per site,
     * because most accounts have one and the ones with six do not want six
     * bookmarks.
     */
    const selected = String(req.query.site || '') || (sites[0] && sites[0].domain) || '';
    let phpConfig = { values: {}, path: '' };
    let wpPlugins = null;
    if (user && selected) {
      phpConfig = await apps.phpConfig(user, selected).catch(() => ({ values: {}, path: '' }));
      wpPlugins = await apps.plugins(user, { target: 'wordpress', name: selected }).catch(() => null);
    }

    // The site's current PHP, straight off the node where we can see it.
    const nodeSite = (runtimes.sites || []).find((s) => s.domain === selected) || null;

    return res.render('panel/runtime', {
      title: 'Languages & settings',
      robots: 'noindex',
      sites,
      selected,
      runtimes,
      nodeApps,
      nodeSite,
      phpConfig,
      wpPlugins,
      settings: apps.PHP_SETTINGS,
      hasHosting: Boolean(user),
      mock: !apps.isLive(),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Change a site's PHP version.
 *
 * This one does NOT go through the broker: the PHP version of a website is
 * Hestia's FPM backend template, and changing it means rewriting the pool and
 * reloading php-fpm — root's work, which the Hestia API already does properly.
 * Adding a second way to do it here would be two things to keep in step.
 */
router.post('/runtime/php', async (req, res, next) => {
  const domain = String(req.body.site || '').trim().toLowerCase();
  const back = `/panel/apps/runtime?site=${encodeURIComponent(domain)}`;
  try {
    const user = await apps.accountFor(req.customer);
    const sites = await sitesFor(req);
    if (!sites.some((s) => s.domain === domain)) {
      flash(res, 'That is not one of your websites.', 'error');
      return res.redirect('/panel/apps/runtime');
    }

    const version = String(req.body.php || '');
    const runtimes = await apps.runtimes(user);
    const chosen = (runtimes.php || []).find((p) => p.version === version);
    if (!chosen) {
      flash(res, 'This server does not have that PHP version.', 'error');
      return res.redirect(back);
    }

    const template = chosen.template || `PHP-${version.replace('.', '_')}`;
    if (hestia.isLive()) {
      await hestia.run('v-change-web-domain-backend-tpl', [user, domain, template, 'yes']);
    }
    /*
     * Said with the caveat attached. Moving a live WordPress from 8.1 to 8.4 is
     * a change that can break a plugin instantly, and a customer who is told
     * only "Saved" has not been told the thing they need to know.
     */
    flash(res, `${domain} now runs PHP ${version}. Open the site and check it — a version jump can break an old plugin.`, 'ok');
    return res.redirect(back);
  } catch (err) {
    if (err instanceof apps.AppError || err instanceof hestia.HestiaError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

router.post('/runtime/config', async (req, res, next) => {
  const domain = String(req.body.site || '').trim().toLowerCase();
  const back = `/panel/apps/runtime?site=${encodeURIComponent(domain)}`;
  try {
    const user = await apps.accountFor(req.customer);
    const sites = await sitesFor(req);
    if (!sites.some((s) => s.domain === domain)) {
      flash(res, 'That is not one of your websites.', 'error');
      return res.redirect('/panel/apps/runtime');
    }
    const values = {};
    Object.keys(apps.PHP_SETTINGS).forEach((key) => {
      if (req.body[key] !== undefined && req.body[key] !== '') values[key] = req.body[key];
    });
    await apps.setPhpConfig(user, domain, values);
    // PHP caches .user.ini for five minutes by default, so "saved" and "in
    // effect" are not the same moment and saying so saves a support ticket.
    flash(res, 'Saved. PHP re-reads these every five minutes, so give it a moment before testing.', 'ok');
    return res.redirect(back);
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

router.post('/runtime/plugins', async (req, res, next) => {
  const domain = String(req.body.site || '').trim().toLowerCase();
  const back = `/panel/apps/runtime?site=${encodeURIComponent(domain)}`;
  try {
    const user = await apps.accountFor(req.customer);
    await apps.pluginAction(user, {
      target: 'wordpress',
      name: domain,
      pkg: req.body.plugin,
      action: req.body.action === 'remove' ? 'remove' : 'add',
    });
    flash(res, req.body.action === 'remove' ? 'Plugin removed.' : 'Plugin installed and activated.', 'ok');
    return res.redirect(back);
  } catch (err) {
    if (err instanceof apps.AppError) {
      flash(res, err.message, 'error');
      return res.redirect(back);
    }
    return next(err);
  }
});

module.exports = router;
