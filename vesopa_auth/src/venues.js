/**
 * A venue, as auth.vesopa.com holds it: an organisation, its people, and what
 * it pays for.
 *
 * WHY THIS EXISTS
 *
 * The back office already reads a venue's licences from here
 * (`/api/app/entitlements`, keyed by organisation) and already has a column,
 * `offices.auth_organisation_id`, to say which organisation a venue is. What
 * never existed was a way to MAKE those organisations: auth held exactly one,
 * Vesopa's own, so every venue took the unlinked path. This is that way.
 *
 * WHO MAY CALL IT
 *
 * Only the applications named in PROVISIONERS — first-party, confidential, and
 * run by Vesopa Software. Creating an organisation makes somebody its owner and
 * writes what a customer pays; neither is a thing a venue's own till, or any
 * third party, should be able to do.
 *
 * WHAT IT WILL AND WILL NOT DO
 *
 *   It only ADDS. A person is never removed, a role never lowered, a quantity
 *   never reduced. Taking something away from a venue is a commercial act with a
 *   person behind it, and a sync that did it would be doing it silently —
 *   because somebody's spreadsheet was a row short.
 *
 *   It never EMAILS. Accounts it creates are silent and their address is
 *   UNVERIFIED, exactly as scripts/provision-venues.js does and for the same
 *   reason: we have read an address out of a database, which is not proof that
 *   anybody owns it. The one-time code they ask for at their first sign-in is
 *   the proof, and the back office will not link a staff row until it has it.
 *
 *   It is IDEMPOTENT. The organisation is found by `external_ref` — the
 *   caller's own stable name for the venue — so a second run changes nothing.
 *
 *   It can DRY-RUN through the very same code path: the work runs inside a
 *   transaction that is rolled back, so what a dry run reports is what a real
 *   run would do, not a second implementation of it that has drifted.
 *
 * Rule 1 of the migration plan holds: nothing here writes to a product's
 * database. The caller stores the organisation id on its own side.
 */

const crypto = require('crypto');

const db = require('./db');
const { newId } = require('./crypto');
const { normaliseEmail } = require('./normalise');

/** Applications allowed to provision venues, by slug. */
const PROVISIONERS = new Set(['vesopa-epos-admin']);

/**
 * The applications a venue's staff may be let into, and the products a venue
 * may be sold, through this route. The EPOS family only: hosting and domains
 * are bought by a person at cloud.vesopa.com, not assigned by an admin.
 */
const VENUE_APPLICATIONS = new Set([
  'vesopa-epos',
  'vesopa-backoffice',
  'vesopa-kitchen',
  'vesopa-display',
  'vesopa-express',
]);
const VENUE_PRODUCTS = new Set(['epos', 'kitchen', 'display', 'express']);
const ORG_ROLES = ['viewer', 'developer', 'admin', 'owner']; // lowest to highest
const SUB_STATUSES = new Set(['active', 'cancelled', 'expired', 'paused', 'trialling']);

class DryRun extends Error {}

class InvalidVenue extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidVenue';
  }
}

const isDate = (v) => v == null || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(v));
const dateOrNull = (v) => (v == null || v === '' ? null : String(v).slice(0, 10));

/** Check and tidy a request before anything touches the database. */
function validate(body) {
  const ref = String(body.venue_ref || '').trim();
  if (!/^[a-z0-9][a-z0-9:._-]{1,63}$/i.test(ref)) {
    throw new InvalidVenue('venue_ref must be 2–64 characters of letters, digits and : . _ -');
  }
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw new InvalidVenue('A venue name is required.');

  const ownerEmail = normaliseEmail(String(body.owner?.email || ''));
  if (!ownerEmail) throw new InvalidVenue('The owner needs a valid email address.');

  const people = new Map();
  const addPerson = (p, orgRole) => {
    const email = normaliseEmail(String(p?.email || ''));
    if (!email) throw new InvalidVenue(`Not a valid email address: ${p?.email}`);
    if (email.endsWith('.invalid')) {
      // RFC 2606: can never receive a code, so the account could never be used.
      throw new InvalidVenue(`${email} can never receive a sign-in code.`);
    }
    if (!ORG_ROLES.includes(orgRole)) throw new InvalidVenue(`Unknown organisation role ${orgRole}.`);
    const apps = [];
    for (const a of Array.isArray(p.apps) ? p.apps : []) {
      const slug = String(a?.slug || '');
      if (!VENUE_APPLICATIONS.has(slug)) throw new InvalidVenue(`${slug} is not a venue application.`);
      apps.push({ slug, roles: (Array.isArray(a.roles) ? a.roles : []).map((r) => String(r).slice(0, 64)) });
    }
    const existing = people.get(email);
    if (existing) {
      // The same person twice — keep the higher role and every app.
      if (ORG_ROLES.indexOf(orgRole) > ORG_ROLES.indexOf(existing.orgRole)) existing.orgRole = orgRole;
      existing.apps.push(...apps);
      return;
    }
    people.set(email, {
      email,
      display: String(p.email).trim().slice(0, 255),
      name: String(p.name || '').trim().slice(0, 120),
      orgRole,
      apps,
    });
  };

  addPerson(body.owner, 'owner');
  for (const m of Array.isArray(body.members) ? body.members : []) {
    const role = m.org_role || 'viewer';
    if (role === 'owner') throw new InvalidVenue('A venue has one owner; name them as `owner`.');
    addPerson(m, role);
  }

  const subscriptions = [];
  for (const s of Array.isArray(body.subscriptions) ? body.subscriptions : []) {
    const product = String(s?.product || '');
    if (!VENUE_PRODUCTS.has(product)) throw new InvalidVenue(`${product} is not sold per venue.`);
    const quantity = Number(s.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      throw new InvalidVenue(`Quantity for ${product} must be a whole number from 1 to 500.`);
    }
    const status = String(s.status || 'active');
    if (!SUB_STATUSES.has(status)) throw new InvalidVenue(`Unknown subscription status ${status}.`);
    if (!isDate(s.renews_at) || !isDate(s.started_at) || !isDate(s.ends_at)) {
      throw new InvalidVenue(`Dates for ${product} must be YYYY-MM-DD.`);
    }
    subscriptions.push({
      product,
      quantity,
      status,
      planLabel: String(s.plan_label || '').slice(0, 120),
      renewsAt: dateOrNull(s.renews_at),
      startedAt: dateOrNull(s.started_at),
      endsAt: dateOrNull(s.ends_at),
    });
  }

  // Optional. A caller that believes this venue is ALREADY a given organisation
  // says so, and a mismatch is refused rather than papered over by creating a
  // second one. See provision().
  let expectId = null;
  if (body.expect_organisation_id != null && body.expect_organisation_id !== '') {
    expectId = Number(body.expect_organisation_id);
    if (!Number.isInteger(expectId) || expectId <= 0) throw new InvalidVenue('expect_organisation_id must be an id.');
  }

  return { ref, name, ownerEmail, people: [...people.values()], subscriptions, expectId };
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'venue';
}

/** A person by email, creating them silently and unverified if needed. */
async function findOrCreateUser(tx, person, actions) {
  const existing = await tx.one(
    `SELECT u.id FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL
      LIMIT 1`,
    [person.email]
  );
  if (existing) return existing.id;

  const result = await tx.execute(
    'INSERT INTO users (public_id, display_name, webauthn_handle) VALUES (?, ?, ?)',
    [newId(), person.name, crypto.randomBytes(32)]
  );
  const userId = result.insertId;
  // verified_at left NULL on purpose — see the header.
  const identity = await tx.execute(
    `INSERT INTO user_identities (user_id, type, identifier, identifier_norm)
     VALUES (?, 'email', ?, ?)`,
    [userId, person.display, person.email]
  );
  await tx.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [identity.insertId, userId]);
  actions.push({ do: 'create_account', email: person.email, user_id: userId });
  return userId;
}

/** Let a person into an application with roles, never removing any. */
async function enrol(tx, userId, email, app, actions) {
  const application = await tx.one('SELECT id FROM applications WHERE slug = ? AND deleted_at IS NULL', [app.slug]);
  if (!application) {
    actions.push({ do: 'skip_app', email, app: app.slug, why: 'no such application' });
    return;
  }
  const before = await tx.one(
    'SELECT id, status FROM application_members WHERE application_id = ? AND user_id = ?',
    [application.id, userId]
  );
  await tx.execute(
    `INSERT INTO application_members (application_id, user_id, status)
     VALUES (?, ?, 'active')
     ON DUPLICATE KEY UPDATE status = IF(status = 'removed', 'active', status)`,
    [application.id, userId]
  );
  const member = await tx.one(
    'SELECT id FROM application_members WHERE application_id = ? AND user_id = ?',
    [application.id, userId]
  );
  if (!before) actions.push({ do: 'enrol', email, app: app.slug });

  await tx.execute(
    `INSERT IGNORE INTO application_member_roles (member_id, role_id)
     SELECT ?, r.id FROM application_roles r WHERE r.application_id = ? AND r.is_default = 1`,
    [member.id, application.id]
  );
  for (const key of app.roles) {
    const role = await tx.one(
      'SELECT id FROM application_roles WHERE application_id = ? AND role_key = ?',
      [application.id, key]
    );
    if (!role) {
      actions.push({ do: 'skip_role', email, app: app.slug, role: key, why: 'not defined by that application' });
      continue;
    }
    const granted = await tx.execute(
      'INSERT IGNORE INTO application_member_roles (member_id, role_id) VALUES (?, ?)',
      [member.id, role.id]
    );
    if (granted.affectedRows) actions.push({ do: 'grant_role', email, app: app.slug, role: key });
  }
}

/**
 * Create or top up a venue. Returns
 * `{ organisation_id, public_id, created, dry_run, actions }`.
 */
async function provision(body, { applicationId = null, dryRun = false, database = db } = {}) {
  const venue = validate(body);
  let outcome;

  try {
    await database.transaction(async (tx) => {
      const actions = [];

      // Owner first: an organisation cannot exist without one (FK, NOT NULL).
      const owner = venue.people.find((p) => p.orgRole === 'owner');
      const ownerId = await findOrCreateUser(tx, owner, actions);

      let org = await tx.one(
        'SELECT id, public_id, owner_user_id, name FROM organisations WHERE external_ref = ? FOR UPDATE',
        [venue.ref]
      );
      /*
       * A venue its application already links to some organisation, but which
       * does not resolve to THAT organisation by its ref — linked by hand, or to
       * Vesopa's own — is refused. Creating a fresh organisation here would
       * leave the venue pointing at one and its people in another.
       */
      if (venue.expectId && (!org || org.id !== venue.expectId)) {
        throw new InvalidVenue(
          `${venue.ref} is not organisation ${venue.expectId} here` +
            (org ? ` (it is ${org.id})` : ' (no organisation has that ref)') +
            '. Nothing was changed.'
        );
      }

      let created = false;
      if (!org) {
        let slug = slugify(venue.name);
        // eslint-disable-next-line no-await-in-loop -- a handful of tries at most
        while (await tx.one('SELECT id FROM organisations WHERE slug = ?', [slug])) {
          slug = `${slugify(venue.name).slice(0, 55)}-${crypto.randomBytes(2).toString('hex')}`;
        }
        const publicId = newId();
        const result = await tx.execute(
          `INSERT INTO organisations
             (public_id, name, slug, owner_user_id, is_first_party, external_ref, managed_by_application_id)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
          [publicId, venue.name, slug, ownerId, venue.ref, applicationId]
        );
        org = { id: result.insertId, public_id: publicId, owner_user_id: ownerId };
        created = true;
        actions.push({ do: 'create_organisation', ref: venue.ref, name: venue.name, organisation_id: org.id });
      } else if (org.owner_user_id !== ownerId) {
        // Never reassign ownership from a sync. Report it for a person to act on.
        actions.push({ do: 'owner_differs', organisation_id: org.id, keeps_user_id: org.owner_user_id, requested: venue.ownerEmail });
      }

      for (const person of venue.people) {
        // eslint-disable-next-line no-await-in-loop -- a venue has a few people
        const userId = person.orgRole === 'owner' ? ownerId : await findOrCreateUser(tx, person, actions);
        const current = await tx.one(
          'SELECT role FROM organisation_members WHERE organisation_id = ? AND user_id = ?',
          [org.id, userId]
        );
        if (!current) {
          await tx.execute(
            'INSERT INTO organisation_members (organisation_id, user_id, role) VALUES (?, ?, ?)',
            [org.id, userId, person.orgRole]
          );
          actions.push({ do: 'add_member', email: person.email, role: person.orgRole });
        } else if (ORG_ROLES.indexOf(person.orgRole) > ORG_ROLES.indexOf(current.role)) {
          await tx.execute(
            'UPDATE organisation_members SET role = ? WHERE organisation_id = ? AND user_id = ?',
            [person.orgRole, org.id, userId]
          );
          actions.push({ do: 'raise_role', email: person.email, from: current.role, to: person.orgRole });
        }
        for (const app of person.apps) {
          // eslint-disable-next-line no-await-in-loop
          await enrol(tx, userId, person.email, app, actions);
        }
      }

      for (const s of venue.subscriptions) {
        const product = await tx.one('SELECT id FROM products WHERE slug = ?', [s.product]);
        if (!product) {
          actions.push({ do: 'skip_subscription', product: s.product, why: 'not in the catalogue' });
          continue;
        }
        const existing = await tx.one(
          `SELECT id, quantity FROM subscriptions
            WHERE organisation_id = ? AND product_id = ? ORDER BY id LIMIT 1 FOR UPDATE`,
          [org.id, product.id]
        );
        if (!existing) {
          await tx.execute(
            `INSERT INTO subscriptions
               (public_id, user_id, product_id, organisation_id, plan_label, quantity, status,
                renews_at, started_at, ends_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId(), org.owner_user_id, product.id, org.id, s.planLabel, s.quantity, s.status,
              s.renewsAt, s.startedAt, s.endsAt]
          );
          actions.push({ do: 'add_subscription', product: s.product, quantity: s.quantity, status: s.status });
        } else if (s.quantity > existing.quantity) {
          const from = Number(existing.quantity);
          await tx.execute('UPDATE subscriptions SET quantity = ? WHERE id = ?', [s.quantity, existing.id]);
          actions.push({ do: 'raise_quantity', product: s.product, from, to: s.quantity });
        }
      }

      outcome = { organisation_id: org.id, public_id: org.public_id, created, dry_run: dryRun, actions };
      if (dryRun) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }
  return outcome;
}

module.exports = { provision, validate, InvalidVenue, PROVISIONERS, VENUE_APPLICATIONS, VENUE_PRODUCTS };
