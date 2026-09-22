/**
 * Each venue as an organisation on auth.vesopa.com.
 *
 * The owner's decision (2026-09-22): a venue is an organisation, its owner owns
 * it, its staff are members, and what it pays for is a subscription on the
 * organisation — the model auth.vesopa.com was built for, and the one the back
 * office's entitlements already read (`offices.auth_organisation_id`).
 *
 * This file decides WHAT a venue should look like there, from what this
 * database knows, and asks auth to make it so through
 * /api/app/venues/provision. Auth only ever adds; it never removes a person,
 * lowers a role or reduces a quantity, so running this is safe to repeat.
 *
 * Rule 1 of the migration plan — the identity provider never writes to a
 * product's database — holds: auth returns an organisation id and THIS side
 * stores it in offices.auth_organisation_id.
 *
 * WHAT A VENUE IS SOLD, and why these numbers
 *
 * Every plan includes one till and one customer display (config.PLAN_INCLUDES);
 * Kitchen and Express are add-ons. So a venue gets epos = 1 and display = 1 —
 * or MORE if it already has more signed in, because a subscription below what a
 * venue is running today would, the day licence locking is switched on for it,
 * refuse a till that is working now. Kitchen and Express appear only where they
 * are actually in use or already have a limit.
 */

const { pool } = require('./db');

const AUTH_BASE = String(process.env.VESOPA_AUTH_ISSUER || 'https://auth.vesopa.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.VESOPA_AUTH_ADMIN_CLIENT_ID || '';
const CLIENT_SECRET = process.env.VESOPA_AUTH_ADMIN_CLIENT_SECRET || '';

const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

/** The applications every venue user is let into, with the roles they get. */
const STAFF_APPS = [
  { slug: 'vesopa-backoffice', roles: ['backoffice.admin'] },
  { slug: 'vesopa-epos', roles: ['till.manager'] },
];

const ymd = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const x = new Date(d);
  return Number.isFinite(x.valueOf()) ? x.toISOString().slice(0, 10) : null;
};

/**
 * Why a venue should NOT become an organisation, or '' if it should.
 * Every reason is one somebody should be able to read in the script's output.
 */
function skipReason({ office, users }) {
  if (office.auth_organisation_id) return `already linked to organisation ${office.auth_organisation_id}`;
  if (office.is_demo || office.demo_of) return 'a demo venue';
  if (office.status === 'archived') return 'archived';
  if (/\.invalid$/i.test(office.contact_email || '')) return 'its address can never receive a sign-in code (.invalid)';
  if (!users.length) return 'no back-office users';
  // Vesopa Software's own console account sits on an office row too; it is the
  // platform, not a customer, and belongs to Vesopa's own organisation.
  if (users.every((u) => u.role === 'admin')) return 'platform staff only, not a customer venue';
  return '';
}

/**
 * The request body for one venue. Pure: everything it needs is passed in, so
 * the rules above are tested without a database.
 *
 * @param office  the offices row
 * @param users   its backoffice_users rows (id, email, name, role, approved)
 * @param seats   { till, kitchen, display, express } — devices signed in now
 * @param limits  { kind: seats } already recorded for the venue
 * @param planName  web_plans.name for office.plan, if any
 */
function buildPayload({ office, users, seats = {}, limits = {}, planName = '' }) {
  const email = (s) => String(s || '').trim().toLowerCase();
  const approved = users.filter((u) => u.approved === 'Y' && u.role !== 'admin');

  // Owner: the venue's contact, if they are one of its users; otherwise its
  // first user. Somebody named on the billing record is who the owner decided
  // owns the venue.
  const owner = approved.find((u) => email(u.email) === email(office.contact_email)) || approved[0];
  if (!owner) return null;

  const members = approved
    .filter((u) => u.id !== owner.id)
    .map((u) => ({ email: u.email, name: u.name || '', org_role: 'admin', apps: STAFF_APPS }));

  const n = (k) => Math.max(Number(seats[k]) || 0, Number(limits[k]) || 0);
  const today = new Date().toISOString().slice(0, 10);
  const trialling = office.trial_ends_on && ymd(office.trial_ends_on) >= today;
  const status = office.status === 'paused' ? 'paused' : trialling ? 'trialling' : 'active';
  const plan = planName || office.plan || 'Vesopa EPOS';
  const base = {
    status,
    renews_at: ymd(office.next_due_on),
    started_at: ymd(office.created_at),
    ends_at: trialling ? ymd(office.trial_ends_on) : null,
  };

  const subscriptions = [
    { product: 'epos', quantity: Math.max(1, n('till')), plan_label: plan, ...base },
    { product: 'display', quantity: Math.max(1, n('display')), plan_label: 'Customer display', ...base },
  ];
  if (n('kitchen') > 0) subscriptions.push({ product: 'kitchen', quantity: n('kitchen'), plan_label: 'Vesopa Kitchen', ...base });
  if (n('express') > 0) subscriptions.push({ product: 'express', quantity: n('express'), plan_label: 'Vesopa Express', ...base });

  return {
    venue_ref: `epos-office:${office.id}`,
    name: String(office.name || office.contact_email).slice(0, 120),
    owner: { email: owner.email, name: owner.name || office.contact_name || '', apps: STAFF_APPS },
    members,
    subscriptions,
  };
}

/** Everything buildPayload needs for one office, from this database. */
async function loadOffice(officeId, db = pool) {
  const [[office]] = await db.query('SELECT * FROM offices WHERE id = ?', [officeId]);
  if (!office) return null;
  const [users] = await db.query(
    'SELECT id, email, name, role, approved FROM backoffice_users WHERE office_id = ? ORDER BY id',
    [officeId]
  );
  const [seatRows] = await db.query(
    `SELECT kind, COUNT(*) AS n FROM bo_till_seats
      WHERE office = ? AND released_at IS NULL GROUP BY kind`,
    [office.contact_email]
  );
  const [limitRows] = await db.query('SELECT kind, seats FROM bo_licence_limits WHERE office = ?', [office.contact_email]);
  const [[plan]] = await db.query('SELECT name FROM web_plans WHERE slug = ? LIMIT 1', [office.plan || '']);

  const seats = Object.fromEntries(seatRows.map((r) => [r.kind, Number(r.n)]));
  const limits = Object.fromEntries(limitRows.map((r) => [r.kind, Number(r.seats)]));
  return { office, users, seats, limits, planName: plan ? plan.name : '' };
}

/** Ask auth to make (or top up) a venue. Throws with auth's own words on refusal. */
async function provision(payload, { dryRun = true } = {}) {
  if (!configured()) throw new Error('Vesopa admin client credentials are not set.');
  const response = await fetch(`${AUTH_BASE}/api/app/venues/provision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization:
        'Basic ' + Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64'),
    },
    body: JSON.stringify({ ...payload, dry_run: dryRun }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error || `auth answered ${response.status}`);
  return body;
}

/**
 * Store the link on this side. Conditional: a venue already linked to some
 * organisation is never silently re-pointed by a sync.
 */
async function link(officeId, organisationId, db = pool) {
  const [result] = await db.query(
    'UPDATE offices SET auth_organisation_id = ? WHERE id = ? AND auth_organisation_id IS NULL',
    [organisationId, officeId]
  );
  return result.affectedRows === 1;
}

/**
 * After a user is added in /admin: if their venue is already an organisation,
 * top it up so the new person is a member. NEVER throws at the caller — a
 * failure here must not undo the user who was just added; it is logged, and
 * the next run of the script picks the person up.
 */
async function syncOfficeQuietly(officeId) {
  try {
    if (!configured() || !officeId) return;
    const data = await loadOffice(officeId);
    if (!data || !data.office.auth_organisation_id) return; // not an organisation yet
    const payload = buildPayload(data);
    if (!payload) return;
    // Auth refuses — and changes nothing — if this venue's ref is not that
    // organisation, e.g. a venue linked by hand to Vesopa's own. Without this a
    // top-up would create a second organisation beside the one it is linked to.
    payload.expect_organisation_id = data.office.auth_organisation_id;
    await provision(payload, { dryRun: false });
  } catch (error) {
    console.warn(`[venues] office ${officeId} not synced to Vesopa:`, error.message);
  }
}

module.exports = { buildPayload, skipReason, loadOffice, provision, link, syncOfficeQuietly, configured, STAFF_APPS };
