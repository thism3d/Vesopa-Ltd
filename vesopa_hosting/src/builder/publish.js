/**
 * Publishing a Vesopa Studio site onto one of the customer's own domains.
 *
 * EVERY WRITE GOES THROUGH THE FILES BROKER (src/files.js), which switches to
 * the customer's own Linux account before it touches anything and confines
 * every path to that account's home -- the same path the file manager uses.
 * The panel process itself never writes into a customer's web space.
 *
 * HESTIA LOCKS THE DOMAIN FOLDER. web/<domain> is mode 551 even to its owner
 * (found on the first live publish: "You do not have permission to do that
 * here"), so nothing can be created beside public_html or rename it. Only
 * the folders inside are the customer's: public_html and private. So:
 *
 * THE ORDER, and why:
 *   1. the domain must be an active website on THIS account (our domains row
 *      AND Hestia's own list), not suspended, not on a custom document root,
 *      not in the middle of an app install, and its public_html a real folder
 *      (an app installed with its own public folder links it elsewhere, and
 *      moving that folder's contents would break the app);
 *   2. the backup folder ~/.vesopa/replaced/public_html-<domain>-<stamp> is
 *      made first, beside the app installer's own backups -- if it cannot be,
 *      nothing has happened yet;
 *   3. the new site is written into a STAGE folder in web/<domain>/private,
 *      which the web server does not serve, so a failure half-way leaves the
 *      live site untouched;
 *   4. the site's source (the Studio JSON) is kept in private too, so it can
 *      be opened and edited again from any device;
 *   5. everything public_html holds now, hidden files included, is moved --
 *      never deleted -- into the backup. If any of it will not move, what did
 *      move goes back and nothing is changed;
 *   6. the staged files are moved in. If that fails, the old site goes back.
 *
 * A static page, two files: index.html and assets/vesopa-site.css.
 */

const crypto = require('crypto');
const db = require('../db');
const files = require('../files');
const hestia = require('../integrations/hestia');
const apps = require('../apps');
const kit = require('./kit');

const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SOURCE_FILE = 'vesopa-studio.json';

class PublishError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.publish = true;
  }
}

/** The websites on this account a Studio site may be published onto. */
async function publishableDomains(customer) {
  const user = await files.accountFor(customer);
  const rows = await db.query(
    `SELECT domain, ssl_status FROM domains
      WHERE customer_id = ? AND status = 'active' AND pointed_at IS NOT NULL
      ORDER BY domain`,
    [customer.id],
  );
  if (!hestia.isLive()) return rows.map((r) => ({ domain: r.domain, ssl: r.ssl_status || '' }));
  const live = new Map((await hestia.listWebDomains(user)).map((d) => [d.domain, d]));
  return rows
    .filter((r) => live.has(r.domain) && !live.get(r.domain).suspended)
    .map((r) => ({ domain: r.domain, ssl: r.ssl_status || '' }));
}

async function checkDomain(customer, raw) {
  const user = await files.accountFor(customer);
  const domain = String(raw || '').trim().toLowerCase();
  if (!DOMAIN.test(domain)) throw new PublishError('That is not a domain name.');
  const allowed = await publishableDomains(customer);
  if (!allowed.some((d) => d.domain === domain)) {
    throw new PublishError('That domain is not a website on this account yet.', 403);
  }
  if (hestia.isLive()) {
    const web = await hestia.webDomain({ username: user, domain });
    if (!web || web.suspended) throw new PublishError('That website is not active.', 403);
    if (web.docroot) throw new PublishError('That website serves a custom folder, so it cannot be published to from here.', 409);
  }
  return { user, domain };
}

/** What a folder holds, hidden entries included: [{name, link, ...}]. */
async function entries(user, dir) {
  const res = await files.call(user, { op: 'list', path: dir, hidden: true });
  return res.entries || [];
}

async function names(user, dir) {
  try {
    return (await entries(user, dir)).map((e) => e.name);
  } catch {
    return [];
  }
}

async function ensureDir(user, parent, name) {
  if ((await names(user, parent)).includes(name)) return;
  try {
    await files.call(user, { op: 'mkdir', path: parent, name });
  } catch (err) {
    if (err.code !== 'exists') throw err;
  }
}

/** Move `paths` into `dest`; resolves with the names that arrived, or throws with them. */
async function moveAll(user, paths, dest) {
  if (!paths.length) return [];
  const res = await files.call(user, { op: 'move', paths, dest });
  if (res.failed && res.failed.length) {
    const err = new PublishError(`Could not move ${res.failed.map((f) => f.path.split('/').pop()).join(', ')}.`, 500);
    err.moved = res.done || [];
    throw err;
  }
  return res.done || [];
}

/**
 * Publish. Resolves with where it went and where the previous site was kept.
 * @param {object} customer  req.customer
 * @param {string} domainRaw
 * @param {object} site      the Studio site from the browser
 */
async function publish(customer, domainRaw, site) {
  const { user, domain } = await checkDomain(customer, domainRaw);
  const clean = kit.normalise(site);
  if (!clean.sections.length) throw new PublishError('There is nothing on this site yet.');

  const jobs = await apps.jobs(user).catch(() => []);
  if (jobs.some((j) => j.domain === domain && !j.finished && j.state !== 'done' && j.state !== 'failed')) {
    throw new PublishError('An app is being installed on that domain right now. Try again when it has finished.', 409);
  }

  const base = `web/${domain}`;
  const docroot = `${base}/public_html`;
  const top = await entries(user, base);
  const pub = top.find((e) => e.name === 'public_html');
  if (!pub) throw new PublishError('That website has no public folder yet. Try again in a minute.', 409);
  if (pub.link) throw new PublishError('That website runs an app with its own public folder, so a Studio site cannot replace it from here.', 409);

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const backupName = `public_html-${domain}-${stamp}`;
  const backupDir = `.vesopa/replaced/${backupName}`;
  const stageName = `studio-stage-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const stage = `${base}/private/${stageName}`;

  // 1. Somewhere to keep the current site, before anything else happens.
  await ensureDir(user, '', '.vesopa');
  await ensureDir(user, '.vesopa', 'replaced');
  await files.call(user, { op: 'mkdir', path: '.vesopa/replaced', name: backupName });

  // 2. The new site, staged where nobody can see it.
  await ensureDir(user, base, 'private');
  try {
    await files.call(user, { op: 'mkdir', path: `${base}/private`, name: stageName });
    await files.call(user, { op: 'mkdir', path: stage, name: 'assets' });
    await files.callWithBody(user, { op: 'write', path: `${stage}/index.html` }, kit.render(clean, { cssHref: 'assets/vesopa-site.css' }));
    await files.callWithBody(user, { op: 'write', path: `${stage}/assets/vesopa-site.css` }, kit.siteCss());
    await files.callWithBody(user, { op: 'write', path: `${base}/private/${SOURCE_FILE}` }, JSON.stringify({ ...clean, publishedAt: new Date().toISOString() }));
  } catch (err) {
    await files.call(user, { op: 'delete', paths: [stage, backupDir] }).catch(() => {});
    throw err;
  }

  // 3. Everything live now goes into the backup -- all of it, or none of it.
  const current = (await entries(user, docroot)).map((e) => `${docroot}/${e.name}`);
  try {
    await moveAll(user, current, backupDir);
  } catch (err) {
    await files.call(user, { op: 'move', paths: (err.moved || []).map((n) => `${backupDir}/${n}`), dest: docroot }).catch(() => {});
    await files.call(user, { op: 'delete', paths: [stage] }).catch(() => {});
    throw new PublishError('Part of the current website could not be moved aside, so nothing was changed.', 500);
  }

  // 4. The new site in; on failure, the old one back.
  try {
    await moveAll(user, [`${stage}/index.html`, `${stage}/assets`], docroot);
  } catch (err) {
    await files.call(user, { op: 'move', paths: (err.moved || []).map((n) => `${docroot}/${n}`), dest: stage }).catch(() => {});
    const kept = await names(user, backupDir);
    await files.call(user, { op: 'move', paths: kept.map((n) => `${backupDir}/${n}`), dest: docroot }).catch(() => {});
    throw new PublishError('The new website could not be put in place, so the previous one is back.', 500);
  }
  await files.call(user, { op: 'delete', paths: [stage] }).catch(() => {});

  // An empty backup (a brand-new website) is not worth keeping or mentioning.
  let backup = `~/${backupDir}`;
  if (!current.length) {
    await files.call(user, { op: 'delete', paths: [backupDir] }).catch(() => {});
    backup = null;
  }

  await db.logActivity({ actorType: 'customer', actorId: customer.id, action: 'studio.publish', target: domain, detail: backup ? `previous site kept at ${backup}` : 'first site on this domain' });
  return { ok: true, domain, url: `https://${domain}/`, backup };
}

/** The Studio source kept beside a published site, if there is one. */
async function source(customer, domainRaw) {
  const { user, domain } = await checkDomain(customer, domainRaw);
  let header;
  let socket;
  try {
    ({ header, socket } = await files.openStream(user, { op: 'read', path: `web/${domain}/private/${SOURCE_FILE}` }));
  } catch {
    return null;
  }
  const chunks = [];
  await new Promise((resolve, reject) => {
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', resolve);
    socket.on('error', reject);
  });
  void header;
  try {
    return kit.normalise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return null;
  }
}

module.exports = { publish, publishableDomains, source, PublishError };
