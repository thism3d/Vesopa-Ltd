/**
 * Give each venue's back-office user a Vesopa account, and let them into the
 * applications they need.
 *
 *     node scripts/provision-venues.js            # say what it would do
 *     node scripts/provision-venues.js --apply    # do it
 *
 * WHY THIS EXISTS
 *
 * The back office and the till are moving to "Continue with Vesopa", and there
 * is no self-registration anywhere in Vesopa — the owner creates the accounts.
 * `vesopa-epos` and `vesopa-backoffice` both have `allow_self_enroll = 0`, so a
 * person with no membership row is turned away at the authorize step however
 * well they sign in. Until every venue has an account AND a membership, turning
 * the exclusive-mode flags on would lock those venues out of their own tills.
 *
 * HOW A VENUE ENDS UP SIGNED IN
 *
 * They press Continue with Vesopa, type their address, and Vesopa emails them a
 * one-time code. That code is what proves they own the address, and the back
 * office links its own staff row to the Vesopa account by VERIFIED EMAIL on
 * their first sign-in. Nothing here needs a password and nothing here sets one.
 *
 * THE ADDRESSES ARE CREATED UNVERIFIED, DELIBERATELY
 *
 * `seed.js` marks the platform administrator's address verified because the
 * person running the seed is that administrator. Nobody here has proved they
 * own these addresses — we have only read them out of a database — and marking
 * them verified would launder an assumption into a proof. The emailed code does
 * the proving, sets `verified_at`, and only then does the back office accept
 * the link (it requires `email_verified` on the token). The cost of getting
 * this wrong is somebody signing in as a venue they do not own.
 *
 * NOTHING IS EMAILED BY THIS SCRIPT. Creating the account is silent; the code
 * goes out when the person themselves asks for one. That matters on this
 * platform — a previous run of a sign-in form against real addresses filled a
 * real mailbox with codes nobody asked for.
 *
 * IDEMPOTENT, like everything else here: every insert is guarded on something
 * stable and nothing is ever deleted. Run it twice and the second run reports
 * that there was nothing to do.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { newId } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');

/*
 * The venues, as `backoffice_users` on backoffice.vesopaepos.com has them.
 *
 * The address is what matters: the back office links its staff row to a Vesopa
 * account by matching this exactly, so a typo here is a venue that signs in
 * successfully and is then told there is no back-office user for them.
 *
 * `roles` are Vesopa roles, not the back office's own — the back office reads
 * its own `role` column and is not governed by these. They are set so that the
 * developer console shows something true about who these people are, and so
 * that anything which later asks Vesopa "what may this person do" gets the
 * right answer rather than the default.
 */
const VENUES = [
  {
    email: 'nha@arpi.site',
    name: 'Nasiria Haque',
    venue: 'Nasiria Haque',
    roles: ['backoffice.admin', 'till.manager'],
  },
  {
    email: 'p@gmail.com',
    name: 'Porash Kumar Kabiraj',
    venue: 'Porash Kumar Kabiraj',
    roles: ['backoffice.admin', 'till.manager'],
  },
  {
    email: 'inashaque@gmail.com',
    name: 'Nasiria Hoque',
    venue: 'Onzep International Limited',
    roles: ['backoffice.admin', 'till.manager'],
  },
  {
    email: 'ntidball@hotmail.co.uk',
    name: 'The Blaen',
    venue: 'The Blaen',
    roles: ['backoffice.admin', 'till.manager'],
  },
  {
    email: 'info@vesopa.com',
    name: 'Carys',
    venue: 'Pontardawe RFC',
    roles: ['backoffice.admin', 'till.manager'],
  },
  /*
   * Two venues are deliberately NOT in this list.
   *
   * `manager@vesopa.co.uk` and `muzahid@onzep.uk` already have Vesopa accounts
   * — the first is the test venue and is already linked. They still need their
   * membership rows, which the membership pass below gives them by looking the
   * addresses up rather than creating anything.
   *
   * `isolation@vesopa.invalid` is not a venue. `.invalid` is reserved by
   * RFC 2606 precisely so that it can never resolve, so an emailed code could
   * never arrive and the account could never be signed into. Creating one would
   * be a row that looks like access and is not.
   */
];

/** Accounts that already exist and only need letting into the applications. */
const EXISTING = ['manager@vesopa.co.uk', 'muzahid@onzep.uk'];

/** Both staff-facing applications refuse anybody without a membership row. */
const APPLICATIONS = ['vesopa-epos', 'vesopa-backoffice'];

const APPLY = process.argv.includes('--apply');

function say(line) {
  console.log(line);
}

async function findUserByEmail(norm) {
  return db.one(
    `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [norm],
  );
}

/** Create the person and their address. Returns the user row. */
async function createAccount(venue) {
  const norm = normaliseEmail(venue.email);

  if (!APPLY) {
    say(`  would create  ${venue.email.padEnd(26)} ${venue.name}`);
    // A stand-in, so the dry run goes on to report the memberships this
    // account would get. A dry run that stopped at "would create" would be
    // hiding the half of the job that decides whether they can actually get
    // in — which is the half that has been wrong before.
    return { id: null };
  }

  const result = await db.execute(
    `INSERT INTO users (public_id, display_name, webauthn_handle)
     VALUES (?, ?, ?)`,
    [newId(), venue.name, crypto.randomBytes(32)],
  );
  const userId = result.insertId;

  // Unverified. The emailed code is what proves it — see the header.
  const identity = await db.execute(
    `INSERT INTO user_identities (user_id, type, identifier, identifier_norm)
     VALUES (?, 'email', ?, ?)`,
    [userId, venue.email, norm],
  );
  await db.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [
    identity.insertId,
    userId,
  ]);

  say(`  created       ${venue.email.padEnd(26)} user ${userId}`);
  return db.one('SELECT * FROM users WHERE id = ?', [userId]);
}

/** Let this person into an application, with the roles named. */
async function enrol(user, slug, roles) {
  const application = await db.one('SELECT * FROM applications WHERE slug = ?', [slug]);
  if (!application) {
    say(`  ! no application "${slug}" — skipped`);
    return;
  }

  const existing = user.id
    ? await db.one(
        'SELECT * FROM application_members WHERE application_id = ? AND user_id = ?',
        [application.id, user.id],
      )
    : null;

  if (!APPLY) {
    say(
      `  would ${existing ? 'keep  ' : 'enrol '} ${slug.padEnd(18)} ` +
        `roles: ${roles.join(', ') || '(default only)'}`,
    );
    return;
  }

  await db.execute(
    `INSERT INTO application_members (application_id, user_id, status)
     VALUES (?, ?, 'active')
     ON DUPLICATE KEY UPDATE status = IF(status = 'removed', 'active', status)`,
    [application.id, user.id],
  );
  const member = await db.one(
    'SELECT * FROM application_members WHERE application_id = ? AND user_id = ?',
    [application.id, user.id],
  );

  // Whatever this application gives every member, plus what was asked for.
  await db.execute(
    `INSERT IGNORE INTO application_member_roles (member_id, role_id)
     SELECT ?, r.id FROM application_roles r
      WHERE r.application_id = ? AND r.is_default = 1`,
    [member.id, application.id],
  );
  for (const key of roles) {
    const role = await db.one(
      'SELECT * FROM application_roles WHERE application_id = ? AND role_key = ?',
      [application.id, key],
    );
    // Named rather than silently skipped: a role that does not exist means
    // this list and the application have drifted, and the person ends up with
    // less access than somebody intended.
    if (!role) {
      say(`  ! ${slug} has no role "${key}" — not granted`);
      continue;
    }
    await db.execute(
      'INSERT IGNORE INTO application_member_roles (member_id, role_id) VALUES (?, ?)',
      [member.id, role.id],
    );
  }
  say(`  enrolled      ${slug.padEnd(18)} roles: ${roles.join(', ')}`);
}

async function main() {
  say(APPLY ? 'Provisioning venues.\n' : 'Dry run — nothing will be written. Add --apply.\n');

  for (const venue of VENUES) {
    say(`${venue.venue} <${venue.email}>`);
    const norm = normaliseEmail(venue.email);
    let user = await findUserByEmail(norm);

    if (user) {
      say(`  already has a Vesopa account (user ${user.id}) — leaving it alone`);
    } else {
      user = await createAccount(venue);
    }

    if (user) {
      for (const slug of APPLICATIONS) await enrol(user, slug, venue.roles);
    }
    say('');
  }

  say('Accounts that already existed, membership only:');
  for (const email of EXISTING) {
    const user = await findUserByEmail(normaliseEmail(email));
    if (!user) {
      say(`  ! ${email} has no Vesopa account after all — check before relying on it`);
      continue;
    }
    say(`${email} (user ${user.id})`);
    for (const slug of APPLICATIONS) {
      await enrol(user, slug, ['backoffice.admin', 'till.manager']);
    }
    say('');
  }

  say(
    APPLY
      ? 'Done. Nothing was emailed: each person gets a code when they press ' +
          'Continue with Vesopa themselves.'
      : 'Dry run finished.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
