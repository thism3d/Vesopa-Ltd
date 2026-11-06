/**
 * admin.vesopa.com's pages.
 *
 * SIGN-IN is Connect with Vesopa only. Who gets in is decided here: the owner
 * (OWNER_EMAIL) and anybody in adm_admins with an active role. Auth proves who
 * the person is; it does not decide what they may do here.
 *
 * Every check is on the ROUTE. The menu hides what a role cannot use, and the
 * route refuses it anyway.
 */
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const db = require('./db');
const session = require('./session');
const roles = require('./roles');
const audit = require('./audit');
const catalogue = require('./catalogue');
const licences = require('./licences');
const serverStats = require('./server_stats');
const releases = require('./releases');
const epos = require('./apps/epos');
const hosting = require('./apps/hosting');
const web = require('./apps/web');
const { connected } = require('./upstream');
const { createClient } = require('./oidc');

const oidc = createClient({
  issuer: config.AUTH_ISSUER,
  clientId: config.AUTH_CLIENT_ID,
  clientSecret: config.AUTH_CLIENT_SECRET,
  redirectUri: `${config.BASE_URL}/callback`,
  scope: 'openid profile email',
});

const router = express.Router();
const STATE_COOKIE = 'va_state';
const stateCookie = { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: 10 * 60 * 1000 };
const FLASH = 'va_flash';

function flash(res, kind, text) {
  res.cookie(FLASH, Buffer.from(JSON.stringify({ kind, text })).toString('base64url'), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30000 });
}

function takeFlash(req, res) {
  const raw = req.cookies && req.cookies[FLASH];
  if (!raw) return null;
  res.clearCookie(FLASH, { path: '/' });
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
}

const money = (minor) => `£${(Number(minor || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).valueOf()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** An audit action in words: 'till.pause' is "Till paused". */
const DID = { add: 'added', seats: 'licences changed', pause: 'paused', resume: 'resumed', remove: 'removed', stopped: 'stopped (grace day ended)', changed: 'changed', suspend: 'suspended', restore: 'restored' };
function describe(action) {
  const parts = String(action || '').split('.');
  if (parts[0] === 'signin') return parts[1] === 'refused' ? 'Sign-in refused' : 'Signed in';
  if (parts[0] === 'admin') return `Admin ${parts[1] || ''}`.trim();
  if (parts[0] === 'catalogue') return 'Catalogue price or switch changed';
  if (parts[0] === 'hosting') return `Hosting service ${DID[parts[1]] || parts[1]}`;
  if (parts[0] === 'subscription') return `Subscription: ${String(parts[1] || '').replace(/_/g, ' ')}`;
  if (parts[0] === 'release') return `Installer ${{ download: 'downloaded', withdraw: 'withdrawn', restore: 'put back' }[parts[1]] || parts[1]}`;
  if (parts[0] === 'versions') return { set: 'Venue versions set', default: 'Default version set', updates: 'Update prompts switched' }[parts[1]] || 'Versions changed';
  const item = catalogue.BY_KEY[parts[0]];
  const verb = parts[2] === 'stopped' ? DID.stopped : DID[parts[1]] || parts.slice(1).join(' ');
  return `${item ? item.label : parts[0]} ${verb}`;
}

function page(req, res, view, data = {}) {
  res.render(view, {
    me: req.me,
    flash: takeFlash(req, res),
    roles,
    can: (p, app) => roles.can(req.me, p, app),
    money, ago, when, describe, size: releases.size,
    path: req.path,
    ...data,
  });
}

// ---- Who is this ----------------------------------------------------------

router.use(async (req, _res, next) => {
  try { req.me = await session.read(req); } catch (e) { console.warn('[session]', e.message); req.me = null; }
  next();
});

function signedIn(req, res, next) {
  if (!req.me) return res.redirect(303, '/signin');
  next();
}

function allow(permission, app) {
  return (req, res, next) => {
    if (roles.can(req.me, permission, typeof app === 'function' ? app(req) : app)) return next();
    res.status(403);
    page(req, res, 'noaccess', { title: 'Not for your role', body: `Your role (${req.me.roleLabel}) cannot open this. Ask the owner.` });
  };
}

function csrf(req, res, next) {
  if (session.csrfOk(req, req.me)) return next();
  res.status(403);
  page(req, res, 'noaccess', { title: 'That form had expired', body: 'Go back, reload the page and try again.' });
}

// ---- Signing in -----------------------------------------------------------

router.get('/signin', (req, res) => {
  if (req.me) return res.redirect(303, '/');
  const error = {
    signin: 'That sign-in did not work. Try again.',
    noaccess: 'You are signed in to Vesopa, but this account is not an admin here. Ask the owner to add you.',
    unverified: 'Your Vesopa email address is not confirmed. Sign in to your Vesopa account with an emailed code once, then come back.',
  }[req.query.error] || null;
  res.render('signin', { error, ready: oidc.enabled, flash: takeFlash(req, res) });
});

router.get('/start', (req, res) => {
  if (!oidc.enabled) return res.redirect(303, '/signin');
  const { url, state } = oidc.begin({ select: req.query.switch === '1' });
  res.cookie(STATE_COOKIE, state, stateCookie);
  res.redirect(303, url);
});

router.get('/callback', async (req, res) => {
  const held = req.cookies && req.cookies[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/' });
  try {
    if (!held || !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(held)).digest(),
      crypto.createHash('sha256').update(String(req.query.state || '')).digest()
    )) throw new Error('the sign-in was started in another browser');
    const person = await oidc.complete(req.query);
    if (!person.email) return res.redirect(303, '/signin?error=unverified');
    const row = await session.adminRow(person.email);
    const who = roles.principal({ email: person.email, name: person.name, row, ownerEmail: config.OWNER_EMAIL });
    if (!who.active) {
      await audit.record({ actor: person.email, action: 'signin.refused', detail: 'not an admin', ok: false });
      return res.redirect(303, '/signin?error=noaccess');
    }
    if (req.me) await session.destroy(req, res);
    await session.create(res, person, req.ip);
    if (row) await db.run('UPDATE adm_admins SET last_seen_at = UTC_TIMESTAMP(), name = COALESCE(name, ?) WHERE id = ?', [person.name, row.id]);
    await audit.record({ actor: person.email, action: 'signin', detail: who.roleLabel });
    res.redirect(303, '/');
  } catch (e) {
    console.warn(`[signin] ${e.message}`);
    res.redirect(303, '/signin?error=signin');
  }
});

router.post('/signout', async (req, res) => {
  await session.destroy(req, res);
  // "Switch account": signed out here, then Vesopa's account picker.
  res.redirect(303, req.body && req.body.switch === '1' ? '/start?switch=1' : '/signin');
});

router.get('/healthz', (_req, res) => res.json({ ok: true, epos: connected('epos'), gift: connected('gift'), hosting: connected('hosting') }));

// ---- Home: the live overview ----------------------------------------------

async function loadOverview(req) {
  try {
    return { o: await licences.overview(req.me.email), error: null };
  } catch (e) {
    return { o: null, error: e.message };
  }
}

router.get('/', signedIn, allow('licences.view'), async (req, res, next) => {
  try {
    const { o, error } = await loadOverview(req);
    const recent = await audit.recent({ limit: 12 }).catch(() => []);
    const quiet = o ? o.venues.filter((v) => v.status === 'active' && v.device_count > 0 && v.online === 0) : [];
    const grace = o ? o.venues.flatMap((v) => v.holds.filter((h) => !h.stopped).map((h) => ({ venue: v, hold: h }))) : [];
    const owing = o ? o.venues.filter((v) => v.overdue.count > 0) : [];
    const top = o ? [...o.venues].sort((a, b) => b.today.total_minor - a.today.total_minor).slice(0, 8) : [];
    page(req, res, 'overview', { title: 'Overview', o, error, recent, quiet, grace, owing, top, label: (k) => labelOf(k) });
  } catch (e) { next(e); }
});

function labelOf(holdItem) {
  const item = catalogue.ITEMS.find((i) => i.holdKey === holdItem || i.key === holdItem);
  return item ? item.label : holdItem;
}

// ---- Venues ---------------------------------------------------------------

router.get('/venues', signedIn, allow('licences.view', 'epos'), async (req, res, next) => {
  try {
    const { o, error } = await loadOverview(req);
    const q = String(req.query.q || '').trim().toLowerCase();
    const show = String(req.query.show || 'all');
    let list = o ? o.venues : [];
    if (q) list = list.filter((v) => `${v.name} ${v.email} ${v.id}`.toLowerCase().includes(q));
    if (show === 'paused') list = list.filter((v) => v.status === 'paused' || v.holds.length);
    if (show === 'offline') list = list.filter((v) => v.device_count > 0 && v.online === 0);
    if (show === 'owing') list = list.filter((v) => v.overdue.count > 0);
    page(req, res, 'venues', { title: 'Venues', o, error, list, q, show, items: catalogue.ITEMS, label: labelOf });
  } catch (e) { next(e); }
});

router.get('/venues/:id', signedIn, allow('licences.view', 'epos'), async (req, res, next) => {
  try {
    let data = null;
    let error = null;
    try { data = await licences.venue(req.params.id, req.me.email); } catch (e) { if (e.status === 404) return next(); error = e.message; }
    const history = await audit.recent({ limit: 30, venueId: Number(req.params.id) }).catch(() => []);
    page(req, res, 'venue', { title: 'Venues', data, error, history, groups: catalogue.GROUPS, grace: catalogue.GRACE_HOURS });
  } catch (e) { next(e); }
});

// Each printer's place online. The same drives as the back office's Devices page.
async function printDrivesPage(req, res, error = null) {
  const venueId = Number(req.params.id);
  let data = { drives: [], connectors: [] };
  const jobs = {};
  try {
    data = await epos.printDrives(venueId, req.me.email);
    for (const d of data.drives) jobs[d.id] = (await epos.printDriveJobs(venueId, d.id, req.me.email)).jobs;
  } catch (e) { error = error || e.message; }
  page(req, res, 'print_drives', { title: 'Printer drives', venueId, drives: data.drives, connectors: data.connectors, jobs, error });
}

router.get('/venues/:id/print-drives', signedIn, allow('licences.view', 'epos'), (req, res, next) => {
  printDrivesPage(req, res).catch(next);
});

router.post('/venues/:id/print-drives', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res, next) => {
  const venueId = Number(req.params.id);
  const b = req.body || {};
  const [terminal, printer] = String(b.printer || '').split('|');
  try {
    await epos.addPrintDrive(venueId, { name: b.name, terminal_id: Number(terminal), printer_id: printer }, req.me.email);
    await audit.record({ actor: req.me.email, action: 'print-drive.add', venueId, detail: String(b.name || '').slice(0, 80) });
    res.redirect(303, `/venues/${venueId}/print-drives`);
  } catch (e) {
    printDrivesPage(req, res, e.message).catch(next);
  }
});

router.post('/venues/:id/print-drives/:drive/test', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res, next) => {
  const venueId = Number(req.params.id);
  try {
    await epos.printDriveTest(venueId, req.params.drive, req.me.email);
    res.redirect(303, `/venues/${venueId}/print-drives`);
  } catch (e) {
    printDrivesPage(req, res, e.message).catch(next);
  }
});

// Who takes each kind of card payment at a venue. The same switch as the back
// office's Card Payments page, through the same route.
router.get('/venues/:id/cards', signedIn, allow('licences.view', 'epos'), async (req, res) => {
  const venueId = Number(req.params.id);
  let providers = null;
  let error = req.query.error ? String(req.query.error).slice(0, 200) : null;
  try { providers = await epos.providers(venueId, req.me.email); } catch (e) { error = e.message; }
  page(req, res, 'venue_cards', { title: 'Card payments', venueId, providers, error });
});

router.post('/venues/:id/cards', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res) => {
  const venueId = Number(req.params.id);
  const b = req.body || {};
  const back = `/venues/${venueId}/cards`;
  try {
    if (!['tills', 'online', 'tap'].includes(b.what)) throw new Error('Unknown payment type');
    await epos.setProviders(venueId, { [b.what]: b.provider }, req.me.email);
    await audit.record({ actor: req.me.email, action: 'cards.provider', venueId, detail: `${b.what} to ${b.provider}` });
  } catch (e) {
    return res.redirect(303, `${back}?error=${encodeURIComponent(e.message)}`);
  }
  res.redirect(303, back);
});

// Every terminal of a venue, its access key and its settings. The whole key is
// only ever on the page that issued it: it is not in a URL or the audit trail.
async function terminalsPage(req, res, { issued = null, error = null } = {}) {
  const venueId = Number(req.params.id);
  let data = { terminals: [], kinds: [] };
  let go = { modes: [], devices: [] };
  try { data = await epos.terminals(venueId, req.me.email); } catch (e) { error = error || e.message; }
  try { go = await epos.goModes(venueId, req.me.email); } catch (_) { /* a server without Go: the table stays empty */ }
  page(req, res, 'terminals', { title: 'Terminals', venueId, terminals: data.terminals, kinds: data.kinds, go, issued, error });
}

router.get('/venues/:id/terminals', signedIn, allow('licences.view', 'epos'), (req, res, next) => {
  terminalsPage(req, res).catch(next);
});

router.post('/venues/:id/terminals', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res, next) => {
  const venueId = Number(req.params.id);
  const b = req.body || {};
  try {
    const made = await epos.addTerminal(venueId, { kind: b.kind, name: b.name }, req.me.email);
    await audit.record({ actor: req.me.email, action: 'terminal.add', venueId, detail: `${made.kind} ${made.number}` });
    await terminalsPage(req, res, { issued: made });
  } catch (e) {
    terminalsPage(req, res, { error: e.message }).catch(next);
  }
});

router.post('/venues/:id/terminals/:tid/act', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res, next) => {
  const venueId = Number(req.params.id);
  const action = String((req.body || {}).action || '');
  try {
    if (!['key', 'unbind', 'revoke'].includes(action)) throw new Error('Unknown action');
    const done = await epos.terminalAct(venueId, req.params.tid, action, req.me.email);
    await audit.record({ actor: req.me.email, action: `terminal.${action}`, venueId, detail: `${done.kind} ${done.number}` });
    await terminalsPage(req, res, { issued: action === 'key' ? done : null });
  } catch (e) {
    terminalsPage(req, res, { error: e.message }).catch(next);
  }
});

router.post('/venues/:id/terminals/:tid/provider', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res, next) => {
  const venueId = Number(req.params.id);
  const provider = String((req.body || {}).provider || '');
  try {
    await epos.setTerminalProvider(venueId, req.params.tid, provider, req.me.email);
    await audit.record({ actor: req.me.email, action: 'terminal.provider', venueId, detail: `${Number(req.params.tid)} to ${provider || 'venue default'}` });
    res.redirect(303, `/venues/${venueId}/terminals`);
  } catch (e) {
    terminalsPage(req, res, { error: e.message }).catch(next);
  }
});

router.post('/venues/:id/go-mode', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res, next) => {
  const venueId = Number(req.params.id);
  const b = req.body || {};
  try {
    await epos.setGoMode(venueId, String(b.device || ''), String(b.mode || ''), req.me.email);
    await audit.record({ actor: req.me.email, action: 'go.mode', venueId, detail: String(b.mode || '') });
    res.redirect(303, `/venues/${venueId}/terminals`);
  } catch (e) {
    terminalsPage(req, res, { error: e.message }).catch(next);
  }
});

router.get('/venues/:id/terminals/:tid', signedIn, allow('licences.view', 'epos'), async (req, res, next) => {
  const venueId = Number(req.params.id);
  try {
    const [data, all] = await Promise.all([
      epos.terminalSettings(venueId, req.params.tid, req.me.email),
      epos.terminals(venueId, req.me.email),
    ]);
    const others = all.terminals.filter((t) => t.kind === data.terminal.kind && t.id !== data.terminal.id && !t.revoked_at);
    page(req, res, 'terminal_settings', { title: 'Terminals', venueId, terminal: data.terminal, settings: data.settings, others, error: null });
  } catch (e) {
    if (e.status === 404) return next();
    next(e);
  }
});

router.post('/venues/:id/terminals/:tid/copy', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res) => {
  const venueId = Number(req.params.id);
  const b = req.body || {};
  const back = `/venues/${venueId}/terminals/${Number(req.params.tid)}`;
  try {
    await epos.copyTerminal(venueId, req.params.tid, { to: [Number(b.to)], category: b.category, name: b.name }, req.me.email);
    await audit.record({ actor: req.me.email, action: 'terminal.copy', venueId, detail: `to ${Number(b.to)}` });
  } catch (e) {
    return res.redirect(303, `${back}?error=${encodeURIComponent(e.message)}`);
  }
  res.redirect(303, back);
});

router.post('/venues/:id/items/:item', signedIn, csrf, async (req, res) => {
  const back = `/venues/${Number(req.params.id)}`;
  const b = req.body || {};
  try {
    const r = await licences.act(req.me, req.params.id, req.params.item, String(b.action || ''), {
      seats: b.seats, reason: b.reason, graceHours: b.grace_hours, notify: b.notify !== '0',
    });
    const item = catalogue.BY_KEY[req.params.item];
    const done = {
      add: `${item.label} added.`,
      seats: `${item.label} licences changed.`,
      resume: `${item.label} resumed.`,
      pause: r.until ? `${item.label} paused. It keeps working until ${when(r.until)}.` : `${item.label} paused and stopped now.`,
      remove: r.until ? `${item.label} removed. It keeps working until ${when(r.until)}.` : `${item.label} removed and stopped now.`,
    }[b.action];
    flash(res, 'ok', done || 'Done.');
  } catch (e) {
    flash(res, 'bad', e.message);
  }
  res.redirect(303, back);
});

/** One action on one item across several venues: the venues list's tick boxes. */
router.post('/venues/bulk', signedIn, csrf, async (req, res) => {
  const b = req.body || {};
  const ids = [].concat(b.ids || []).map(Number).filter(Boolean);
  const action = String(b.action || '');
  if (!ids.length || !['pause', 'resume'].includes(action) || !catalogue.BY_KEY[b.item]) {
    flash(res, 'bad', 'Tick at least one venue, then choose what to pause or resume.');
    return res.redirect(303, '/venues');
  }
  let ok = 0;
  const failed = [];
  for (const id of ids) {
    try { await licences.act(req.me, id, b.item, action, { reason: b.reason }); ok += 1; } catch (e) { failed.push(`${id}: ${e.message}`); }
  }
  flash(res, failed.length ? 'bad' : 'ok', `${catalogue.BY_KEY[b.item].label}: ${action === 'pause' ? 'paused' : 'resumed'} at ${ok} venue${ok === 1 ? '' : 's'}.${failed.length ? ` Not done: ${failed.join('; ')}` : ''}`);
  res.redirect(303, '/venues');
});

// ---- Catalogue: prices and platform switches -------------------------------

router.get('/catalogue', signedIn, allow('licences.view', 'epos'), async (req, res, next) => {
  try {
    let mods = [];
    let error = null;
    try { mods = await epos.catalogue(req.me.email); } catch (e) { error = e.message; }
    page(req, res, 'catalogue', { title: 'Catalogue', items: catalogue.ITEMS, mods, error, groups: catalogue.GROUPS });
  } catch (e) { next(e); }
});

router.post('/catalogue/:key', signedIn, csrf, allow('licences.sell', 'epos'), async (req, res) => {
  const b = req.body || {};
  try {
    const body = {};
    if (b.price !== undefined && b.price !== '') body.price_minor = Math.round(Number(String(b.price).replace(/[£,\s]/g, '')) * 100);
    if (b.active !== undefined) body.active = b.active === '1';
    await epos.setModuleCatalogue(req.params.key, body, req.me.email);
    await audit.record({ actor: req.me.email, action: 'catalogue.changed', app: 'epos', item: req.params.key, detail: body });
    flash(res, 'ok', 'Saved. Venues are charged the new price from their next invoice.');
  } catch (e) { flash(res, 'bad', e.message); }
  res.redirect(303, '/catalogue');
});

// ---- Hosting ----------------------------------------------------------------

router.get('/hosting', signedIn, allow('licences.view', 'hosting'), async (req, res, next) => {
  try {
    let services = [];
    let error = null;
    try { services = await hosting.services(req.me.email); } catch (e) { error = e.message; }
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) services = services.filter((s) => `${s.primary_domain} ${s.email} ${s.plan_name}`.toLowerCase().includes(q));
    page(req, res, 'hosting', { title: 'Cloud hosting', services, error, q });
  } catch (e) { next(e); }
});

router.post('/hosting/:id', signedIn, csrf, allow('licences.run', 'hosting'), async (req, res) => {
  const b = req.body || {};
  try {
    if (b.action === 'suspend') await hosting.suspend(req.params.id, b.reason, req.me.email);
    else await hosting.unsuspend(req.params.id, req.me.email);
    await audit.record({ actor: req.me.email, action: `hosting.${b.action === 'suspend' ? 'suspend' : 'restore'}`, app: 'hosting', item: `service:${Number(req.params.id)}`, detail: b.reason || null });
    flash(res, 'ok', b.action === 'suspend' ? 'Service suspended.' : 'Service restored.');
  } catch (e) {
    await audit.record({ actor: req.me.email, action: `hosting.${b.action}`, app: 'hosting', item: `service:${Number(req.params.id)}`, detail: e.message, ok: false });
    flash(res, 'bad', e.message);
  }
  res.redirect(303, '/hosting');
});

// ---- Subscriptions (vesopaepos.com, billed through Dojo) --------------------

// Who may do what: chasing a payment is an operational call (licences.run);
// anything that changes what is charged or refunds money is licences.sell.
const SUB_ACTIONS = {
  retry: 'licences.run', card_link: 'licences.run', extend_trial: 'licences.run', link_venue: 'licences.run', note: 'licences.run',
  change_plan: 'licences.sell', refund: 'licences.sell', cancel: 'licences.sell', reactivate: 'licences.sell',
};

router.get('/subscriptions', signedIn, allow('licences.view'), async (req, res, next) => {
  try {
    const show = String(req.query.show || '');
    let data = null;
    let error = null;
    try { data = await web.list(show || undefined, req.me.email); } catch (e) { error = e.message; }
    const q = String(req.query.q || '').trim().toLowerCase();
    let rows = data ? data.rows : [];
    if (q) rows = rows.filter((r) => `${r.venue_name} ${r.email} ${r.plan_name}`.toLowerCase().includes(q));
    page(req, res, 'subscriptions', { title: 'Subscriptions', data, rows, error, show, q });
  } catch (e) { next(e); }
});

router.get('/subscriptions/:id', signedIn, allow('licences.view'), async (req, res, next) => {
  try {
    let d = null;
    let plans = null;
    let error = null;
    try { [d, plans] = await Promise.all([web.detail(req.params.id, req.me.email), web.plans(req.me.email)]); } catch (e) { if (e.status === 404) return next(); error = e.message; }
    page(req, res, 'subscription', { title: 'Subscriptions', d, plans, error, actions: SUB_ACTIONS });
  } catch (e) { next(e); }
});

router.post('/subscriptions/:id/:action', signedIn, csrf, async (req, res) => {
  const back = `/subscriptions/${Number(req.params.id)}`;
  const action = String(req.params.action);
  const perm = SUB_ACTIONS[action];
  if (!perm || !roles.can(req.me, perm)) {
    flash(res, 'bad', `Your role (${req.me.roleLabel}) cannot do that.`);
    return res.redirect(303, back);
  }
  const b = req.body || {};
  try {
    const r = await web.act(req.params.id, action, {
      days: b.days, period: b.period, amount: b.amount, when: b.when, venue_id: b.venue_id, notes: b.notes,
      addons: b.display !== undefined ? { display: b.display, kitchen: b.kitchen, till: b.till } : undefined,
    }, req.me.email);
    await audit.record({ actor: req.me.email, action: `subscription.${action}`, app: 'web', item: `subscription:${Number(req.params.id)}`, detail: r.message });
    flash(res, 'ok', r.message || 'Done.');
  } catch (e) {
    await audit.record({ actor: req.me.email, action: `subscription.${action}`, app: 'web', item: `subscription:${Number(req.params.id)}`, detail: e.message, ok: false });
    flash(res, 'bad', e.message);
  }
  res.redirect(303, back);
});

// ---- Audit ------------------------------------------------------------------

router.get('/audit', signedIn, allow('audit.view'), async (req, res, next) => {
  try {
    page(req, res, 'audit', { title: 'Audit log', rows: await audit.recent({ limit: 300 }) });
  } catch (e) { next(e); }
});

// ---- Admins -----------------------------------------------------------------

router.get('/admins', signedIn, allow('admins.manage'), async (req, res, next) => {
  try {
    const rows = await db.all('SELECT * FROM adm_admins ORDER BY status, email');
    page(req, res, 'admins', { title: 'Admins', rows, owner: config.OWNER_EMAIL });
  } catch (e) { next(e); }
});

const cleanEmail = (s) => String(s || '').trim().toLowerCase().slice(0, 190);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

router.post('/admins', signedIn, csrf, allow('admins.manage'), async (req, res) => {
  const b = req.body || {};
  const email = cleanEmail(b.email);
  const role = roles.ROLES[b.role] ? b.role : 'readonly';
  const apps = roles.cleanApps(b.apps);
  if (!isEmail(email)) { flash(res, 'bad', 'That email address does not look right.'); return res.redirect(303, '/admins'); }
  if (email === config.OWNER_EMAIL) { flash(res, 'bad', 'That address is the owner already.'); return res.redirect(303, '/admins'); }
  if (role === 'owner' && !req.me.isOwner) { flash(res, 'bad', 'Only the owner can make another Owner.'); return res.redirect(303, '/admins'); }
  if (!apps) { flash(res, 'bad', 'Choose at least one app.'); return res.redirect(303, '/admins'); }
  await db.run(
    `INSERT INTO adm_admins (email, name, role, apps, status, added_by) VALUES (?, ?, ?, ?, 'active', ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), apps = VALUES(apps), status = 'active'`,
    [email, String(b.name || '').slice(0, 120) || null, role, apps, req.me.email]
  );
  await audit.record({ actor: req.me.email, action: 'admin.added', detail: { email, role, apps } });
  flash(res, 'ok', `${email} can sign in as ${roles.ROLES[role].label} with their Vesopa account.`);
  res.redirect(303, '/admins');
});

router.post('/admins/:id', signedIn, csrf, allow('admins.manage'), async (req, res) => {
  const b = req.body || {};
  const row = await db.one('SELECT * FROM adm_admins WHERE id = ?', [Number(req.params.id)]);
  if (!row) return res.redirect(303, '/admins');
  if (row.email === req.me.email && !req.me.isOwner) { flash(res, 'bad', 'You cannot change your own access.'); return res.redirect(303, '/admins'); }
  if ((row.role === 'owner' || b.role === 'owner') && !req.me.isOwner) { flash(res, 'bad', 'Only the owner can change an Owner.'); return res.redirect(303, '/admins'); }
  if (b.action === 'remove') {
    await db.run('DELETE FROM adm_admins WHERE id = ?', [row.id]);
    await db.run('UPDATE adm_sessions SET revoked_at = UTC_TIMESTAMP() WHERE email = ? AND revoked_at IS NULL', [row.email]);
    await audit.record({ actor: req.me.email, action: 'admin.removed', detail: { email: row.email } });
    flash(res, 'ok', `${row.email} can no longer sign in here.`);
    return res.redirect(303, '/admins');
  }
  const role = roles.ROLES[b.role] ? b.role : row.role;
  const apps = b.apps === undefined ? row.apps : roles.cleanApps(b.apps);
  const status = b.status === 'suspended' ? 'suspended' : 'active';
  if (!apps) { flash(res, 'bad', 'Choose at least one app.'); return res.redirect(303, '/admins'); }
  await db.run('UPDATE adm_admins SET role = ?, apps = ?, status = ? WHERE id = ?', [role, apps, status, row.id]);
  if (status === 'suspended') await db.run('UPDATE adm_sessions SET revoked_at = UTC_TIMESTAMP() WHERE email = ? AND revoked_at IS NULL', [row.email]);
  await audit.record({ actor: req.me.email, action: 'admin.changed', detail: { email: row.email, role, apps, status } });
  flash(res, 'ok', `Saved ${row.email}.`);
  res.redirect(303, '/admins');
});

// ---- Downloads: our own Windows installers ---------------------------------

const downloadable = (req) => releases.APPS.filter((a) => roles.can(req.me, 'releases.download', a.role));

router.get('/downloads', signedIn, async (req, res, next) => {
  try {
    const apps = downloadable(req);
    if (!apps.length) return allow('releases.download')(req, res, next);
    const all = await releases.list({ withdrawn: roles.can(req.me, 'versions.manage') }).catch((e) => { req.listError = e.message; return []; });
    const byApp = Object.fromEntries(apps.map((a) => [a.key, all.filter((r) => r.app === a.key)]));
    page(req, res, 'downloads', { title: 'Downloads', apps, byApp, error: req.listError || null, ready: !!config.RELEASES_SECRET });
  } catch (e) { next(e); }
});

router.get('/downloads/:id', signedIn, async (req, res, next) => {
  try {
    const r = await releases.get(req.params.id);
    if (!r || !releases.BY_KEY[r.app]) return next();
    if (!roles.can(req.me, 'releases.download', releases.BY_KEY[r.app].role)) {
      res.status(403);
      return page(req, res, 'noaccess', { title: 'Not for your role', body: `Your role (${req.me.roleLabel}) cannot download this app. Ask the owner.` });
    }
    if (!releases.hasFile(r)) {
      flash(res, 'bad', `${releases.BY_KEY[r.app].short} ${r.version} is on the Microsoft Store only: there is no installer to download.`);
      return res.redirect(303, '/downloads');
    }
    const file = releases.fileOf(r);
    if (!require('fs').existsSync(file)) {
      flash(res, 'bad', `The file for ${releases.BY_KEY[r.app].short} ${r.version} is missing on the server.`);
      return res.redirect(303, '/downloads');
    }
    await audit.record({ actor: req.me.email, action: 'release.download', app: releases.BY_KEY[r.app].role, item: `${r.app}:${r.version}` });
    res.download(file, r.file);
  } catch (e) { next(e); }
});

/**
 * Re-send every pin on [release]'s version, so a venue already set to it
 * picks up a change to where it can be had (now on the Store, or not).
 * Returns how many venues (and the default) were re-sent.
 */
async function repin(release, as) {
  const fresh = await releases.get(release.id);
  const data = await epos.appVersions(fresh.app, as);
  const same = (data.pins || []).filter((p) => p.version && releases.normalise(p.version) === fresh.version);
  if (!same.length) return 0;
  const body = await pinBody(fresh.app, String(fresh.id));
  const ids = same.filter((p) => !p.default && p.office_id).map((p) => Number(p.office_id));
  if (ids.length) await epos.setAppVersion(fresh.app, { offices: ids, ...body }, as);
  if (same.some((p) => p.default)) await epos.setAppVersion(fresh.app, { offices: 'default', ...body }, as);
  return ids.length + (same.some((p) => p.default) ? 1 : 0);
}

/** Record a version that is live on the Microsoft Store (2026-10-08). */
router.post('/downloads/store', signedIn, csrf, allow('versions.manage'), async (req, res) => {
  try {
    const r = await releases.addStore({ app: String(req.body.app || ''), version: String(req.body.version || ''), by: req.me.email });
    await audit.record({ actor: req.me.email, action: 'release.store', app: releases.BY_KEY[r.app].role, item: `${r.app}:${r.version}` });
    await repin(r, req.me.email).catch(() => null);
    flash(res, 'ok', `${releases.BY_KEY[r.app].short} ${r.version} is marked as live on the Microsoft Store.`);
  } catch (e) { flash(res, 'bad', e.message); }
  res.redirect(303, '/downloads');
});

router.post('/downloads/:id', signedIn, csrf, allow('versions.manage'), async (req, res) => {
  const r = await releases.get(req.params.id);
  if (r && (req.body.action === 'store-on' || req.body.action === 'store-off')) {
    const on = req.body.action === 'store-on';
    await releases.setStore(r.id, on);
    await audit.record({ actor: req.me.email, action: on ? 'release.store' : 'release.unstore', app: releases.BY_KEY[r.app].role, item: `${r.app}:${r.version}` });
    const moved = await repin(r, req.me.email).catch(() => null);
    flash(res, 'ok', on
      ? `${releases.BY_KEY[r.app].short} ${r.version} is live on the Store: venues set to it now move their Store copies too${moved ? ` (${moved} updated)` : ''}.`
      : `${releases.BY_KEY[r.app].short} ${r.version} is no longer marked as on the Store.`);
    return res.redirect(303, '/downloads');
  }
  if (r) {
    const back = req.body.action === 'restore';
    await releases.withdraw(r.id, back);
    await audit.record({ actor: req.me.email, action: back ? 'release.restore' : 'release.withdraw', app: releases.BY_KEY[r.app].role, item: `${r.app}:${r.version}` });
    flash(res, 'ok', back ? `${releases.BY_KEY[r.app].short} ${r.version} is back on the list.` : `${releases.BY_KEY[r.app].short} ${r.version} is hidden. Venues already set to it keep it until you choose another.`);
  }
  res.redirect(303, '/downloads');
});

/** A device fetching the version its venue is set to. No sign-in: the signature is the permission. */
router.get('/dl/:id/:sig/:file', async (req, res, next) => {
  try {
    const r = await releases.get(req.params.id);
    if (!r || !releases.signatureOk(r, req.params.sig)) return next();
    const file = releases.fileOf(r);
    if (!require('fs').existsSync(file)) return next();
    res.set('Cache-Control', 'private, max-age=3600');
    res.download(file, r.file);
  } catch (e) { next(e); }
});

// ---- Versions: which version each venue runs --------------------------------

// Loyalty is a member's own app, not a venue's: it has a default and no venues.
const VERSION_APPS = releases.APPS;

/**
 * What a venue is set to and how its devices compare. `target` is the version
 * the devices should be on; null is "No auto updates".
 */
/**
 * When the devices install (2026-10-20): "If I say update and choose update
 * and schedule then it updates on time" (the owner). ask = on screen as
 * before; now = straight away; at = the date and time chosen, UK time.
 * Now and at are the permission: nobody is asked. A till still waits until
 * it is between sales.
 */
function whenFrom(b) {
  const mode = b.when === 'now' || b.when === 'at' ? b.when : 'ask';
  const force = mode !== 'ask' && (b.force === '1' || b.force === 'on' || b.force === true);
  if (mode !== 'at') return force ? { mode, force } : { mode };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(b.when_at || ''));
  if (!m) throw new Error('Choose the date and time to install.');
  // The time was typed in UK time: find its UTC instant.
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = (t) => {
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName').value; // GMT or GMT+1
    const h = /GMT([+-]\d+)/.exec(name);
    return (h ? Number(h[1]) : 0) * 3600000;
  };
  const utc = guess - offset(guess - offset(guess));
  if (utc < Date.now() - 60000) throw new Error('That time has passed. Choose a time from now on, or Install now.');
  return force ? { mode, install_at: new Date(utc).toISOString(), force } : { mode, install_at: new Date(utc).toISOString() };
}

/** "at 20 Oct 22:00" in UK time, for the table. */
function whenLabel(pin) {
  if (!pin || !pin.version) return '';
  const forced = pin.force ? ', forced: an open bill is kept and comes back' : '';
  if (pin.mode === 'now') return `Installs now (no question${forced})`;
  if (pin.mode === 'at' && pin.install_at) {
    const t = new Date(pin.install_at);
    const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t);
    return t.getTime() > Date.now() ? `Installs at ${s} (no question${forced})` : `Installing since ${s}${forced ? ' (forced)' : ''}`;
  }
  return 'Asks on screen';
}

function venueVersion(venue, pins, devices, byId) {
  const own = pins.find((p) => !p.default && Number(p.office_id) === Number(venue.id)) || null;
  const def = pins.find((p) => p.default) || null;
  const rule = own || def;
  const target = rule && rule.version ? releases.normalise(rule.version) : null;
  const mine = devices.filter((d) => Number(d.office_id) === Number(venue.id));
  // Store copies count once the version is live on the Store: they are sent
  // there for it (2026-10-08). Until then only installed copies can follow.
  const direct = mine.filter((d) => d.install !== 'store' || (rule && rule.store));
  const onTarget = direct.filter((d) => target && releases.normalise(d.version) === target).length;
  let status;
  if (!mine.length) status = 'none';
  else if (!direct.length) status = 'store';
  else if (!target) status = 'hold';
  else if (onTarget === direct.length) status = 'ok';
  else if (onTarget) status = 'some';
  else status = 'behind';
  const releaseId = own && own.version ? (byId[`v:${releases.normalise(own.version)}`] || null) : null;
  return { own, def, target, devices: mine, onTarget, direct: direct.length, status, when: whenLabel(rule),
    choice: !own ? 'follow' : own.version ? String(releaseId ? releaseId.id : 'unknown') : 'none' };
}

router.get('/versions', signedIn, allow('versions.manage', 'epos'), async (req, res, next) => {
  try {
    const app = VERSION_APPS.find((a) => a.key === req.query.app) || VERSION_APPS[0];
    const q = String(req.query.q || '').trim().toLowerCase();
    const show = String(req.query.show || 'all');
    let venues = [];
    let data = { enabled: false, pins: [], devices: [] };
    let error = null;
    try {
      [{ venues }, data] = await Promise.all([epos.overview(req.me.email), epos.appVersions(app.key, req.me.email)]);
    } catch (e) { error = e.message; }
    const list = await releases.list({ app: app.key });
    const byId = Object.fromEntries(list.map((r) => [`v:${r.version}`, r]));
    let rows = app.key === 'loyalty' ? [] : venues.map((v) => ({ venue: v, ...venueVersion(v, data.pins, data.devices, byId) }));
    if (q) rows = rows.filter((r) => `${r.venue.name} ${r.venue.email} ${r.venue.id}`.toLowerCase().includes(q));
    if (show !== 'all') rows = rows.filter((r) => r.status === show);
    const def = data.pins.find((p) => p.default) || null;
    page(req, res, 'versions', {
      title: 'Versions', apps: VERSION_APPS, app, rows, list, q, show, error, enabled: data.enabled,
      def, defChoice: def && def.version && byId[`v:${releases.normalise(def.version)}`] ? String(byId[`v:${releases.normalise(def.version)}`].id) : 'none',
      ready: !!config.RELEASES_SECRET, norm: releases.normalise, reach: releases.reach,
    });
  } catch (e) { next(e); }
});

/** What to send the back office for a choice: 'follow', 'none' or a release id. */
async function pinBody(app, choice) {
  if (choice === 'follow') return { clear: true };
  if (choice === 'none') return { version: null };
  const r = await releases.get(choice);
  if (!r || r.app !== app) throw new Error('That version is not on the list for this app.');
  // Installed copies get the installer; Store copies are sent to the Store,
  // when the version is live there (2026-10-08). Either or both.
  const store = !!Number(r.store_live);
  if (!releases.hasFile(r)) return { version: r.version, store: true };
  const url = releases.deviceUrl(r);
  if (!url && !store) throw new Error('RELEASES_SECRET is not set on admin.vesopa.com, so devices cannot be given a download address yet.');
  return url ? { version: r.version, url, sha256: r.sha256, size: Number(r.size), store } : { version: r.version, store };
}

router.post('/versions', signedIn, csrf, allow('versions.manage', 'epos'), async (req, res) => {
  const b = req.body || {};
  const app = VERSION_APPS.find((a) => a.key === b.app && a.key !== 'loyalty');
  const back = /^\/fleet(\/\d+)?(\?[\w=&%.-]*)?$/.test(String(b.back || '')) ? String(b.back)
    : `/versions?app=${app ? app.key : ''}${b.q ? `&q=${encodeURIComponent(b.q)}` : ''}${b.show ? `&show=${encodeURIComponent(b.show)}` : ''}`;
  if (!app) return res.redirect(303, '/versions');
  try {
    // Every row whose choice changed, grouped by what it changed to. Or, with
    // "Apply to ticked" / "Apply to all shown", one choice for many venues.
    const groups = new Map();
    const add = (choice, id) => { if (!groups.has(choice)) groups.set(choice, []); groups.get(choice).push(id); };
    if (b.bulk === 'ticked' || b.bulk === 'shown') {
      const ids = [].concat(b.bulk === 'ticked' ? b.ids || [] : b.shown || []).map(Number).filter(Boolean);
      if (!ids.length) throw new Error(b.bulk === 'ticked' ? 'Tick at least one venue first.' : 'No venues are shown.');
      if (!b.choice) throw new Error('Choose a version to apply.');
      for (const id of ids) add(String(b.choice), id);
    } else {
      for (const [k, v] of Object.entries(b)) {
        const m = /^pin_(\d+)$/.exec(k);
        if (m && String(v) !== String(b[`was_${m[1]}`])) add(String(v), Number(m[1]));
      }
    }
    if (!groups.size) throw new Error('Nothing changed.');
    const when = whenFrom(b);
    let n = 0;
    for (const [choice, ids] of groups) {
      const body = await pinBody(app.key, choice);
      const send = body.version ? { ...body, ...when } : body;
      await epos.setAppVersion(app.key, { offices: ids, ...send }, req.me.email);
      await audit.record({ actor: req.me.email, action: 'versions.set', app: 'epos', item: app.key,
        detail: { venues: ids, version: body.version === undefined ? 'follow default' : body.version || 'no auto updates', when: body.version ? when : undefined } });
      n += ids.length;
    }
    flash(res, 'ok', `${app.short}: ${n} venue${n === 1 ? '' : 's'} changed. ${when.mode === 'now' ? 'They install it now, between sales.' : when.mode === 'at' ? `They install it at the time chosen.` : 'Each device asks on screen.'}`);
  } catch (e) {
    flash(res, 'bad', e.message);
  }
  res.redirect(303, back);
});

// ---- Fleet: every venue's devices, versions, hardware and errors -------------

/** How a device is doing, in one word for the table. */
function deviceState(d) {
  const lastMs = d.last_seen_at ? Date.now() - new Date(d.last_seen_at).getTime() : Infinity;
  if (d.errors && d.errors.day > 0) return { key: 'errors', label: `${d.errors.day} error${d.errors.day === 1 ? '' : 's'} today`, tone: 'red' };
  if (d.health && d.health.warnings > 0) return { key: 'warn', label: `${d.health.warnings} warning${d.health.warnings === 1 ? '' : 's'}`, tone: 'amber' };
  if (d.online === false || lastMs > 30 * 60 * 1000) return { key: 'off', label: 'not seen lately', tone: 'grey' };
  return { key: 'ok', label: 'fine', tone: 'green' };
}

async function releaseLists() {
  const lists = {};
  for (const a of VERSION_APPS.filter((x) => x.key !== 'loyalty')) lists[a.key] = await releases.list({ app: a.key });
  return lists;
}

// The server itself: address, resources and what runs on it (src/server_stats.js).
const serverWindow = (req) => {
  const minutes = Number(req.query.minutes);
  return [15, 60, 360, 1440].includes(minutes) ? minutes : 60;
};

router.get('/server', signedIn, allow('versions.manage', 'epos'), async (req, res, next) => {
  try {
    const minutes = serverWindow(req);
    page(req, res, 'server', { title: 'Server', s: await serverStats.snapshot(minutes), minutes });
  } catch (e) { next(e); }
});

router.get('/server/live', signedIn, allow('versions.manage', 'epos'), async (req, res, next) => {
  try {
    const s = await serverStats.snapshot(serverWindow(req));
    res.json({ latest: s.latest, points: s.points, alerts: s.alerts });
  } catch (e) { next(e); }
});

router.post('/server/alerts', signedIn, csrf, allow('versions.manage', 'epos'), async (req, res, next) => {
  try {
    const levels = await serverStats.setAlertLevels(req.body || {});
    await audit.record({ actor: req.me.email, action: 'server.alerts', detail: JSON.stringify(levels) });
    res.redirect(303, '/server');
  } catch (e) { next(e); }
});

router.get('/fleet', signedIn, allow('versions.manage', 'epos'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const show = String(req.query.show || 'all');
    let data = { venues: [], defaults: [], updates_on: false };
    let error = null;
    try { data = await epos.fleet(null, req.me.email); } catch (e) { error = e.message; }
    let venues = data.venues.map((v) => {
      const states = v.devices.map(deviceState);
      return {
        ...v,
        count: v.devices.length,
        errors: v.errors_day,
        warnings: v.devices.reduce((s, d) => s + ((d.health && d.health.warnings) || 0), 0),
        offline: states.filter((s) => s.key === 'off').length,
        versions: [...new Set(v.devices.flatMap((d) => d.apps.map((a) => `${a.app} ${a.version}`)))].sort(),
      };
    });
    if (show !== 'all') venues = venues.filter((v) => v.count > 0);
    if (q) venues = venues.filter((v) => `${v.name} ${v.office} ${v.office_id}`.toLowerCase().includes(q));
    if (show === 'problems') venues = venues.filter((v) => v.errors || v.warnings);
    if (show === 'offline') venues = venues.filter((v) => v.offline);
    venues.sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || (b.count - a.count) || String(a.name).localeCompare(String(b.name)));
    const totals = {
      venues: venues.length,
      devices: venues.reduce((s, v) => s + v.count, 0),
      errors: venues.reduce((s, v) => s + v.errors, 0),
      warnings: venues.reduce((s, v) => s + v.warnings, 0),
      offline: venues.reduce((s, v) => s + v.offline, 0),
    };
    page(req, res, 'fleet', {
      title: 'Fleet', venues, totals, q, show, error, updatesOn: data.updates_on, reach: releases.reach,
      apps: VERSION_APPS.filter((x) => x.key !== 'loyalty'), lists: await releaseLists(),
    });
  } catch (e) { next(e); }
});

router.get('/fleet/:id', signedIn, allow('versions.manage', 'epos'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.redirect(303, '/fleet');
    let venue = null;
    let error = null;
    let logs = [];
    try {
      const data = await epos.fleet(id, req.me.email);
      venue = data.venues[0] || null;
      logs = (await epos.fleetLogs({ office_id: id, days: 7 }, req.me.email)).events || [];
    } catch (e) { error = e.message; }
    if (!venue && !error) return res.redirect(303, '/fleet');
    const devices = venue ? venue.devices.map((d) => ({ ...d, state: deviceState(d) })) : [];
    page(req, res, 'fleet_venue', {
      title: venue ? venue.name : 'Venue', venue, devices, logs, error, reach: releases.reach,
      apps: VERSION_APPS.filter((x) => x.key !== 'loyalty'), lists: await releaseLists(),
    });
  } catch (e) { next(e); }
});

router.get('/fleet/:id/logs', signedIn, allow('versions.manage', 'epos'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.redirect(303, '/fleet');
    const device = String(req.query.device || '').slice(0, 64);
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const level = req.query.level === 'all' ? 'all' : 'errors';
    let events = [];
    let error = null;
    let venue = null;
    try {
      const [l, f] = await Promise.all([
        epos.fleetLogs({ office_id: id, days, level, ...(device ? { device_id: device } : {}) }, req.me.email),
        epos.fleet(id, req.me.email),
      ]);
      events = l.events || [];
      venue = f.venues[0] || null;
    } catch (e) { error = e.message; }
    const named = venue && device ? (venue.devices.find((d) => d.device_id === device) || {}).name : null;
    if (req.query.format === 'csv') {
      const cell = (v) => `"${String(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replace(/"/g, '""')}"`;
      res.type('text/csv').set('Content-Disposition', `attachment; filename="logs-${id}${device ? '-' + device.slice(0, 12) : ''}.csv"`);
      return res.send(['at,app,version,device,action,target,status,detail', ...events.map((e) =>
        [e.at, e.app, e.app_version, e.device_name, e.action, e.target, e.status, e.detail].map(cell).join(','))].join('\n'));
    }
    page(req, res, 'fleet_logs', { title: `Logs${named ? ' · ' + named : ''}`, venue, events, error, device, named, days, level, id });
  } catch (e) { next(e); }
});

router.post('/fleet/self-updates', signedIn, csrf, allow('versions.manage', 'epos'), async (req, res) => {
  const b = req.body || {};
  const ids = [].concat(b.ids || []).map(Number).filter(Boolean);
  const on = b.on === '1';
  const back = /^\/fleet(\/\d+)?$/.test(String(b.back || '')) ? b.back : '/fleet';
  try {
    if (!ids.length) throw new Error('Tick at least one venue first.');
    await epos.setVenueSelfUpdates(ids, on, req.me.email);
    await audit.record({ actor: req.me.email, action: 'versions.venue_self', app: 'epos', detail: { venues: ids, on } });
    flash(res, 'ok', on
      ? `${ids.length} venue${ids.length === 1 ? '' : 's'} may now move their own tills to Vesopa's approved version from their back office (Devices).`
      : `${ids.length} venue${ids.length === 1 ? '' : 's'}: updates are set by Vesopa only.`);
  } catch (e) { flash(res, 'bad', e.message); }
  res.redirect(303, back);
});

router.post('/versions/default', signedIn, csrf, allow('versions.manage', 'epos'), async (req, res) => {
  const b = req.body || {};
  const app = VERSION_APPS.find((a) => a.key === b.app);
  if (!app) return res.redirect(303, '/versions');
  try {
    const body = b.choice === 'none' ? { clear: true } : await pinBody(app.key, String(b.choice));
    await epos.setAppVersion(app.key, { offices: 'default', ...body }, req.me.email);
    await audit.record({ actor: req.me.email, action: 'versions.default', app: 'epos', item: app.key, detail: { version: body.version || 'no auto updates' } });
    flash(res, 'ok', `${app.short}: the default is now ${body.version || 'No auto updates'}.`);
  } catch (e) { flash(res, 'bad', e.message); }
  res.redirect(303, `/versions?app=${app.key}`);
});

router.post('/versions/updates', signedIn, csrf, allow('versions.manage', 'epos'), async (req, res) => {
  const on = req.body.enabled === '1';
  try {
    await epos.setAppUpdates(on, req.me.email);
    await audit.record({ actor: req.me.email, action: 'versions.updates', app: 'epos', detail: { enabled: on } });
    flash(res, 'ok', on
      ? 'Update prompts are on. Devices installed from our own installer offer their venue\'s version within five minutes.'
      : 'Update prompts are off. No device is told to change version.');
  } catch (e) { flash(res, 'bad', e.message); }
  res.redirect(303, `/versions?app=${encodeURIComponent(req.body.app || 'till')}`);
});

module.exports = { router, oidc };
