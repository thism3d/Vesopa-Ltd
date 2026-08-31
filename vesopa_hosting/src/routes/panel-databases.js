/**
 * Databases.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING
 * ---------------------------------------------------------------------------
 * The panel could LIST databases and open one in phpMyAdmin, and that was all.
 * There was no way to make one. Every customer installing anything — WordPress,
 * Laravel, a static site with a contact form — hit that wall on their first
 * afternoon and had to open a ticket for a thing the machine does in a second.
 *
 * ---------------------------------------------------------------------------
 * TWO DECISIONS WORTH KNOWING ABOUT
 * ---------------------------------------------------------------------------
 * THE PASSWORD IS SHOWN ONCE AND NEVER STORED. Hestia does not hand it back,
 * and we do not keep our own copy: a table of plaintext database passwords is
 * a liability with no upside, because the customer can reset one in a click.
 * So the page after creation is the only place it exists, it says so plainly,
 * and there is a reset button for when somebody closes the tab too fast.
 *
 * THE NAME IS PREFIXED BY HESTIA, NOT BY US. `v-add-database` creates
 * `<account>_<name>`, so a customer typing `shop` gets `u265966_shop`. The form
 * shows the prefix as part of the field rather than letting somebody discover
 * it in a connection error at midnight — and the connection details card
 * repeats the FULL name, because that is what goes in wp-config.php.
 */

const express = require('express');

const db = require('../db');
const auth = require('../auth');
const hestia = require('../integrations/hestia');
const sso = require('../integrations/hestia-sso');
const { flash, rateLimited } = require('../http-utils');

const router = express.Router();

/**
 * MySQL is offered first because it is what nearly everything expects, and
 * PostgreSQL second because the people who want it know they want it. Both are
 * only offered when the node actually runs them — Hestia can be built with one
 * and not the other, and a form that offers a database the box cannot create
 * fails after the customer has typed a password.
 */
const ENGINES = {
  mysql: { label: 'MySQL / MariaDB', note: 'What WordPress, Laravel and almost everything else expects.' },
  pgsql: { label: 'PostgreSQL', note: 'Choose this only if your application asks for it by name.' },
};

/**
 * A name Hestia will accept, and one somebody can type into a config file.
 *
 * Deliberately stricter than the node: letters, digits and underscore, and it
 * has to start with a letter. Hyphens are legal in a MySQL identifier but only
 * inside backticks, which means the first query a customer writes by hand
 * fails with a syntax error they cannot read. Refusing the hyphen at the form
 * is kinder than allowing a name that half of their tools reject.
 */
function cleanName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
}

/**
 * A password worth having, generated here rather than asked for.
 *
 * A database password is typed into a config file once and never again, so
 * there is nothing to remember and no reason to let somebody choose `letmein`.
 * The alphabet leaves out the characters that break an unquoted shell word or
 * a DSN — quotes, backslash, backtick, @, : and / — because the string ends up
 * inside `mysql://user:pass@host/db` in something like half of all projects.
 */
function makePassword(len = 22) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_.!*+=';
  const bytes = require('node:crypto').randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len && i < bytes.length; i++) {
    const v = bytes[i];
    // Reject the tail of the byte range rather than taking a modulus of it,
    // which would make the first few characters of the alphabet likelier.
    if (v >= 256 - (256 % alphabet.length)) continue;
    out += alphabet[v % alphabet.length];
  }
  return out;
}

/** The account, the plan's allowance, and what is on the node right now. */
async function context(req) {
  const service = await db.one(
    `SELECT s.*, p.name AS plan_name, p.\`databases\` AS plan_databases
       FROM services s JOIN plans p ON p.id = s.plan_id
      WHERE s.customer_id = ? AND s.status = 'active'
      ORDER BY s.created_at ASC LIMIT 1`,
    [req.customer.id],
  );

  const user = req.customer.hestia_user;
  let items = [];
  let error = null;
  if (user && service) {
    try {
      items = await hestia.listDatabases(user);
    } catch (err) {
      error = err.message;
    }
  }
  return { service, user, items, error };
}

// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const { service, items, error } = await context(req);

    /*
     * A password is handed to the view exactly once, through the flash cookie,
     * and is gone on the next request. It is never written to the database and
     * never put in a URL, because a URL is in the browser's history and in
     * whatever proxy log sits between here and the customer.
     */
    const created = res.locals.flashData && res.locals.flashData.database
      ? res.locals.flashData.database
      : null;

    res.render('panel/databases', {
      title: 'Databases',
      robots: 'noindex',
      service,
      items,
      error,
      created,
      engines: ENGINES,
      ssoReady: sso.configured(),
      hestiaLive: hestia.isLive(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/create', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/databases');
    // Creating a database is cheap for us and expensive for the node's disk if
    // somebody loops it. Ten a minute is far above any honest use.
    if (rateLimited(req.ip, 'db-create', { max: 10, windowMs: 60_000 })) {
      flash(res, 'That is a lot of databases at once. Give it a minute.', 'error');
      return res.redirect('/panel/databases');
    }

    const { service, user, items, error } = await context(req);
    if (!service || !user) {
      flash(res, 'There is no live hosting on this account yet.', 'error');
      return res.redirect('/panel/databases');
    }
    if (error) {
      flash(res, 'We could not reach the hosting node just now. Try again in a moment.', 'error');
      return res.redirect('/panel/databases');
    }

    const name = cleanName(req.body.name);
    const type = ENGINES[req.body.type] ? req.body.type : 'mysql';

    if (name.length < 3 || !/^[a-z]/.test(name)) {
      flash(res, 'Give the database a name of at least three characters, starting with a letter. Letters, numbers and underscores only.', 'error');
      return res.redirect('/panel/databases');
    }

    /*
     * The allowance is checked against the NODE's list, not against a counter
     * we keep. A count of our own drifts the moment anything creates a database
     * outside the panel — a migration, a support engineer, an older version of
     * this page — and the drift always ends with a customer being told they are
     * at their limit when they are not.
     */
    const limit = Number(service.plan_databases || 0);
    if (limit && items.length >= limit) {
      flash(res, `Your plan includes ${limit} database${limit === 1 ? '' : 's'} and you are using ${items.length}. Upgrade the plan, or delete one you no longer need.`, 'error');
      return res.redirect('/panel/databases');
    }

    // Hestia prefixes both the database and its user with the account name, so
    // what we pass is the suffix and what comes back is the full identifier.
    const full = `${user}_${name}`;
    if (items.some((d) => d.name === full)) {
      flash(res, `You already have a database called ${full}.`, 'error');
      return res.redirect('/panel/databases');
    }

    const password = makePassword();
    try {
      await hestia.addDatabase({ username: user, name, dbUser: name, password, type });
    } catch (err) {
      flash(res, `The server refused to create it: ${err.message}`, 'error');
      return res.redirect('/panel/databases');
    }

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'database.created',
      target: full, detail: type, ip: req.ip,
    }).catch(() => {});

    flash(res, `${full} is ready.`, 'ok', {
      database: {
        name: full, user: full, password, type,
        // Applications connect over the loopback interface on the same box.
        // Telling somebody to use the public hostname would work and would
        // also route their queries out and back through the firewall.
        host: 'localhost',
        port: type === 'pgsql' ? 5432 : 3306,
      },
    });
    res.redirect('/panel/databases');
  } catch (err) {
    next(err);
  }
});

router.post('/reset', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/databases');
    const { user, items } = await context(req);
    // The node's list is the authority on ownership — never the posted name.
    const target = items.find((d) => d.name === req.body.name);
    if (!user || !target) return next();

    const password = makePassword();
    try {
      await hestia.run('v-change-database-password', [user, target.name, password]);
    } catch (err) {
      flash(res, `The server refused: ${err.message}`, 'error');
      return res.redirect('/panel/databases');
    }

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'database.password_reset',
      target: target.name, ip: req.ip,
    }).catch(() => {});

    flash(res, `New password for ${target.name}.`, 'ok', {
      database: {
        name: target.name, user: target.user || target.name, password,
        type: target.type || 'mysql', host: 'localhost',
        port: (target.type === 'pgsql') ? 5432 : 3306,
        reset: true,
      },
    });
    res.redirect('/panel/databases');
  } catch (err) {
    next(err);
  }
});

router.post('/delete', async (req, res, next) => {
  try {
    if (!auth.checkCsrf(req)) return res.redirect('/panel/databases');
    const { user, items } = await context(req);
    const target = items.find((d) => d.name === req.body.name);
    if (!user || !target) return next();

    /*
     * Typing the name is the confirmation. A dialog is dismissed by muscle
     * memory; a name has to be read off the row it belongs to, which is the
     * only guard that actually stops the wrong database being dropped. There
     * is no undo here — the data is gone the moment the node returns.
     */
    if (String(req.body.confirm || '').trim() !== target.name) {
      flash(res, 'Type the database name exactly to confirm. Nothing was deleted.', 'error');
      return res.redirect('/panel/databases');
    }

    try {
      await hestia.deleteDatabase({ username: user, name: target.name });
    } catch (err) {
      flash(res, `The server refused: ${err.message}`, 'error');
      return res.redirect('/panel/databases');
    }

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'database.deleted',
      target: target.name, ip: req.ip,
    }).catch(() => {});
    flash(res, `${target.name} was deleted.`, 'ok');
    res.redirect('/panel/databases');
  } catch (err) {
    next(err);
  }
});

/**
 * Open one in the database manager, already signed in.
 *
 * A redirect rather than a link in the page: the node's signed handoff is good
 * for sixty seconds, so a URL baked into HTML is stale before most people
 * finish reading the page — and minting it on the click keeps the token out of
 * our own page source.
 */
router.get('/:name/open', async (req, res, next) => {
  try {
    const { service, user, items } = await context(req);
    if (!user || !service) return next();
    if (!sso.configured()) {
      flash(res, 'One-click database access is not set up on this server yet.', 'warn');
      return res.redirect('/panel/databases');
    }

    const target = items.find((d) => d.name === req.params.name);
    if (!target) return next();

    const url = target.type === 'pgsql'
      ? sso.phpPgAdminUrl(req, { username: user, database: target.name })
      : sso.phpMyAdminUrl(req, { username: user, database: target.name });

    await db.logActivity({
      actorType: 'customer', actorId: req.customer.id, action: 'database.sso_opened',
      target: target.name, detail: target.type || 'mysql', ip: req.ip,
    }).catch(() => {});

    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
