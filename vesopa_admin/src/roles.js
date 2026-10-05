/**
 * Who may do what, in which apps (2026-10-05).
 *
 * The owner chose roles that are ALSO limited to chosen apps ("Per app roles"),
 * so a person can be Support for Gift alone, or Billing for Hosting alone.
 * A permission is granted when the role has it AND the admin's apps include the
 * app it is asked about.
 *
 * The owner (config.OWNER_EMAIL) is Owner of everything, always. Their row,
 * if anybody makes one, is ignored.
 */
const APPS = {
  epos: 'Vesopa EPOS',
  loyalty: 'Loyalty',
  gift: 'Gift',
  hosting: 'Cloud hosting',
  auth: 'Vesopa Auth',
  web: 'vesopaepos.com',
  software: 'vesopasoftware.com',
};

/**
 *   licences.view    see venues, what they have and what they use
 *   licences.run     pause and resume (an operational call, no money moves)
 *   licences.sell    add, remove, change seats and prices (money moves)
 *   admins.manage    add, change and remove admins
 *   venues.signin    open a venue's back office as its manager (Stage 2)
 *   audit.view       read the audit log
 */
const PERMISSIONS = ['licences.view', 'licences.run', 'licences.sell', 'admins.manage', 'venues.signin', 'audit.view'];

const ROLES = {
  owner: { label: 'Owner', summary: 'Everything, in every app.', can: PERMISSIONS },
  support: {
    label: 'Support',
    summary: 'Venues and people: see everything, pause and resume, sign in as a venue. No money.',
    can: ['licences.view', 'licences.run', 'venues.signin', 'audit.view'],
  },
  billing: {
    label: 'Billing',
    summary: 'Licences, prices and invoices: add, remove, pause and resume.',
    can: ['licences.view', 'licences.run', 'licences.sell', 'audit.view'],
  },
  content: { label: 'Content', summary: 'Websites, blog and Store text.', can: ['licences.view'] },
  readonly: { label: 'Read only', summary: 'Sees everything it is given, changes nothing.', can: ['licences.view', 'audit.view'] },
};

function parseApps(raw) {
  const s = String(raw == null ? '*' : raw).trim();
  if (s === '*' || s === '') return '*';
  const list = s.split(',').map((x) => x.trim()).filter((x) => APPS[x]);
  return list.length ? list : [];
}

function cleanApps(input) {
  if (input === '*' || (Array.isArray(input) && input.includes('*'))) return '*';
  const list = (Array.isArray(input) ? input : String(input || '').split(','))
    .map((x) => String(x).trim()).filter((x) => APPS[x]);
  return list.length ? [...new Set(list)].join(',') : '';
}

/** What one signed-in admin is, from their row (or the owner's address). */
function principal({ email, name, row, ownerEmail }) {
  const isOwner = String(email || '').toLowerCase() === ownerEmail;
  const role = isOwner ? 'owner' : row && ROLES[row.role] ? row.role : null;
  const apps = isOwner ? '*' : parseApps(row && row.apps);
  return {
    email,
    name: name || (row && row.name) || email,
    role,
    roleLabel: role ? ROLES[role].label : 'No access',
    apps,
    isOwner,
    active: isOwner || !!(row && row.status === 'active' && role),
  };
}

/** Whether `who` may do `permission`, in `app` when one is named. */
function can(who, permission, app) {
  if (!who || !who.active || !who.role) return false;
  if (!ROLES[who.role].can.includes(permission)) return false;
  if (!app || who.apps === '*') return true;
  return Array.isArray(who.apps) && who.apps.includes(app);
}

/** Whether `who` sees `app` at all. */
function sees(who, app) {
  return can(who, 'licences.view', app);
}

module.exports = { APPS, PERMISSIONS, ROLES, parseApps, cleanApps, principal, can, sees };
