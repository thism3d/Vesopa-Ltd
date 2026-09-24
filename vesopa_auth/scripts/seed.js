/**
 * Put Vesopa's own organisation, applications, roles and administrator into a
 * fresh database.
 *
 *     node scripts/seed.js
 *
 * IDEMPOTENT, like everything else that touches this database. It is run by the
 * deploy, so it must be safe on the hundredth time as well as the first: every
 * insert is an upsert keyed on something stable, and nothing is ever deleted.
 * In particular it never resets the administrator's password — that would undo
 * a change made by hand the next time anybody deploys.
 *
 * WHY THE EPOS PRODUCTS ARE ONE APPLICATION AND THE MENU IS ANOTHER
 *
 * The owner asked whether "Vesopa EPOS" should be one application with till,
 * menu and back-office users separated inside it, or three applications. The
 * answer here is one application for the STAFF-facing products, with roles, and
 * a separate one for the customer-facing menu.
 *
 * The reason is who the people are. A manager who also works the till is one
 * human being and must be one account — three applications would mean three,
 * and she would have to remember which one she used. But a diner scanning a QR
 * code at a table is not staff, will never hold a staff role, and should not
 * appear in the same membership list as the people who can open the safe.
 * Roles separate colleagues; applications separate audiences.
 */

const crypto = require('crypto');

const db = require('../src/db');
const config = require('../src/config');
const { hashPassword, newId } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');

/*
 * The scopes an application may ask for, with the sentence shown on the consent
 * screen. Written for the person being asked — "See your name and profile
 * picture", not "profile" — because a consent screen nobody can read is a
 * consent screen nobody has read.
 */
const SCOPES = [
  ['openid', 'Confirm who you are', 'Confirm that you are signed in to Vesopa.', 1, 0],
  ['profile', 'See your basic profile', 'Your name, profile picture and date of birth.', 1, 0],
  ['email', 'See your email address', 'The email address on your Vesopa account, and whether it is confirmed.', 1, 0],
  ['phone', 'See your phone number', 'The mobile number on your Vesopa account.', 0, 1],
  ['offline_access', 'Stay signed in', 'Keep you signed in without asking again every few minutes.', 0, 0],
  ['roles', 'See what you are allowed to do', 'The roles you hold in this application.', 0, 0],

  /*
   * The QR menu's own scopes.
   *
   * `orders.claim` is the one that needs explaining. A diner orders as a guest,
   * waits, and only then decides to make an account — at which point the orders
   * they placed are known to their phone and to nobody else. Without a way to
   * attach them, signing in LOSES the meal they are in the middle of, which is
   * the worst possible moment to ask somebody to register. It is separate from
   * `orders.read` because it is a different act: reading is passive, claiming
   * writes a person's id onto rows that had none.
   */
  ['orders.read', 'See your orders', 'The orders you have placed with this venue, and what is in them.', 0, 0],
  ['orders.write', 'Order for you', 'Place orders from this menu on your behalf.', 0, 0],
  ['orders.claim', 'Keep the orders you placed as a guest', 'Attach orders you placed on this phone before signing in, so you do not lose track of a meal in progress.', 0, 0],
];

const APPLICATIONS = [
  {
    slug: 'vesopa-epos',
    name: 'Vesopa EPOS',
    description: 'The till, the kitchen screen, the customer display and the back office.',
    clientType: 'native',
    allowSelfEnroll: 0,
    redirects: [
      // RFC 8252 loopback. The port is chosen at runtime by the operating
      // system, so only the path is registered — see clients.matchRedirect.
      'http://127.0.0.1:0/callback',
      'https://backoffice.vesopaepos.com/auth/callback',
    ],
    logoutRedirects: ['https://backoffice.vesopaepos.com/'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'roles'],
    roles: [
      ['till.operator', 'Till operator', 'Can take orders and payments.', 1],
      ['till.manager', 'Till manager', 'Can refund, void and open the drawer without a sale.', 0],
      ['kitchen.staff', 'Kitchen', 'Can see and complete kitchen tickets.', 0],
      ['backoffice.admin', 'Back office administrator', 'Can change products, prices, staff and settings.', 0],
      ['backoffice.reports', 'Reports only', 'Can read reports but change nothing.', 0],
    ],
    permissions: [
      ['epos.sale', 'Take a sale'],
      ['epos.refund', 'Refund a sale'],
      ['epos.void', 'Void a line or a sale'],
      ['epos.drawer', 'Open the cash drawer without a sale'],
      ['epos.products.write', 'Change products and prices'],
      ['epos.staff.write', 'Add and remove staff'],
      ['epos.reports.read', 'Read reports'],
    ],
    rolePermissions: {
      'till.operator': ['epos.sale'],
      'till.manager': ['epos.sale', 'epos.refund', 'epos.void', 'epos.drawer', 'epos.reports.read'],
      'kitchen.staff': [],
      'backoffice.admin': [
        'epos.products.write', 'epos.staff.write', 'epos.reports.read',
        'epos.refund', 'epos.void', 'epos.drawer',
      ],
      'backoffice.reports': ['epos.reports.read'],
    },
  },
  {
    slug: 'vesopa-menu',
    name: 'Vesopa Menu',
    description: 'The QR dine-in menu customers order from at the table.',
    clientType: 'web',
    // A diner scanning a code at a table has never been enrolled by anybody,
    // and asking a venue to add every customer by hand is not a product.
    allowSelfEnroll: 1,
    // AND MOST OF THEM NEVER SIGN IN AT ALL. Guest ordering is the default on
    // that page and stays the default; an account buys the orders you placed,
    // on whatever phone you are holding, and nothing else.
    guestAllowed: 1,
    /*
     * BOTH DOMAINS, AND menu.vesopaepos.com IS THE ONE THAT EXISTS.
     *
     * The plan calls the QR menu `menu.vesopa.com` throughout, and that
     * hostname does not resolve — the live menu real venues are trading on is
     * served from `menu.vesopaepos.com`, on the EPOS box. Registering only the
     * aspirational name would mean the very first sign-in attempt failed with
     * `invalid_request`, from a domain that answers nothing, which is a
     * miserable thing to debug.
     *
     * Both are registered because redirect matching is exact string equality —
     * there is no wildcard to lean on — and because the menu is expected to
     * move to the vesopa.com name eventually. Two exact strings cost nothing
     * and mean the move is a DNS change rather than a coordinated deploy.
     */
    redirects: [
      'https://menu.vesopaepos.com/auth/callback',
      'https://menu.vesopa.com/auth/callback',
    ],
    logoutRedirects: [
      'https://menu.vesopaepos.com/',
      'https://menu.vesopa.com/',
    ],
    grants: ['authorization_code', 'refresh_token'],
    scopes: [
      'openid', 'profile', 'email', 'phone', 'offline_access',
      'orders.read', 'orders.write', 'orders.claim',
    ],
    roles: [['menu.customer', 'Customer', 'Can order from the menu and see their own orders.', 1]],
    permissions: [],
    rolePermissions: {},
  },
  {
    slug: 'vesopa-cloud',
    name: 'Vesopa Cloud',
    description: 'The hosting control panel at cloud.vesopa.com.',
    clientType: 'web',
    allowSelfEnroll: 0,
    redirects: ['https://cloud.vesopa.com/auth/callback'],
    logoutRedirects: ['https://cloud.vesopa.com/'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'roles'],
    roles: [
      ['cloud.customer', 'Customer', 'Can manage their own hosting.', 1],
      ['cloud.admin', 'Administrator', 'Can manage every customer.', 0],
    ],
    permissions: [],
    rolePermissions: {},
  },
];

async function main() {
  console.log('▶ scopes');
  for (const [name, title, description, isDefault, isSensitive] of SCOPES) {
    await db.execute(
      `INSERT INTO scopes (name, title, description, is_default, is_sensitive)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), description = VALUES(description)`,
      [name, title, description, isDefault, isSensitive],
    );
  }
  console.log(`  ✓ ${SCOPES.length}`);

  // ---------------------------------------------------------------------
  // The administrator, and the organisation they own
  // ---------------------------------------------------------------------
  console.log('▶ administrator');
  const adminEmail = normaliseEmail(config.admin.email);
  let admin = await db.one(
    `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [adminEmail],
  );

  if (!admin) {
    const publicId = newId();
    const result = await db.execute(
      `INSERT INTO users (public_id, display_name, is_staff, is_developer, webauthn_handle)
       VALUES (?, 'Vesopa Administrator', 1, 1, ?)`,
      [publicId, crypto.randomBytes(32)],
    );
    const userId = result.insertId;
    const identityResult = await db.execute(
      `INSERT INTO user_identities
         (user_id, type, identifier, identifier_norm, verified_at, verified_via)
       VALUES (?, 'email', ?, ?, NOW(), 'seed')`,
      [userId, config.admin.email, adminEmail],
    );
    await db.execute('UPDATE users SET primary_email_id = ? WHERE id = ?', [
      identityResult.insertId,
      userId,
    ]);

    if (config.admin.password) {
      await db.execute(
        'INSERT INTO user_passwords (user_id, password_hash, algorithm) VALUES (?, ?, ?)',
        [
          userId,
          await hashPassword(config.admin.password, config.secrets.passwordPepper),
          'argon2id',
        ],
      );
    }
    admin = await db.one('SELECT * FROM users WHERE id = ?', [userId]);
    console.log(`  ✓ created ${config.admin.email}`);
  } else {
    // Never re-hash the password here: an administrator who changed it by hand
    // would have it silently reset on the next deploy.
    await db.execute('UPDATE users SET is_staff = 1, is_developer = 1 WHERE id = ?', [admin.id]);
    console.log(`  ✓ ${config.admin.email} already exists`);
  }

  console.log('▶ organisation');
  let organisation = await db.one("SELECT * FROM organisations WHERE slug = 'vesopa'");
  if (!organisation) {
    const result = await db.execute(
      `INSERT INTO organisations (public_id, name, slug, owner_user_id, is_first_party)
       VALUES (?, 'Vesopa Software Ltd', 'vesopa', ?, 1)`,
      [newId(), admin.id],
    );
    organisation = await db.one('SELECT * FROM organisations WHERE id = ?', [result.insertId]);
  }
  await db.execute(
    `INSERT INTO organisation_members (organisation_id, user_id, role)
     VALUES (?, ?, 'owner')
     ON DUPLICATE KEY UPDATE role = 'owner'`,
    [organisation.id, admin.id],
  );
  console.log('  ✓ Vesopa Software Ltd');

  // ---------------------------------------------------------------------
  // Applications
  // ---------------------------------------------------------------------
  for (const spec of APPLICATIONS) {
    console.log(`▶ ${spec.name}`);
    let application = await db.one('SELECT * FROM applications WHERE slug = ?', [spec.slug]);

    if (!application) {
      const result = await db.execute(
        `INSERT INTO applications
           (organisation_id, client_id, name, slug, description, client_type,
            is_first_party, allow_self_enroll, guest_allowed, subject_type, sector_salt)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'public', ?)`,
        [
          organisation.id,
          crypto.randomBytes(16).toString('hex'),
          spec.name,
          spec.slug,
          spec.description,
          spec.clientType,
          spec.allowSelfEnroll,
          spec.guestAllowed ? 1 : 0,
          crypto.randomBytes(16).toString('hex'),
        ],
      );
      application = await db.one('SELECT * FROM applications WHERE id = ?', [result.insertId]);
      console.log(`  ✓ created, client_id ${application.client_id}`);
    } else {
      console.log(`  ✓ exists, client_id ${application.client_id}`);
    }

    for (const grant of spec.grants) {
      await db.execute(
        'INSERT IGNORE INTO application_grants (application_id, grant_type) VALUES (?, ?)',
        [application.id, grant],
      );
    }

    for (const scope of spec.scopes) {
      await db.execute(
        `INSERT IGNORE INTO application_scopes (application_id, scope_id)
         SELECT ?, id FROM scopes WHERE name = ?`,
        [application.id, scope],
      );
    }

    for (const uri of spec.redirects) {
      await db.execute(
        `INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
         VALUES (?, ?, 'login')`,
        [application.id, uri],
      );
    }
    for (const uri of spec.logoutRedirects || []) {
      await db.execute(
        `INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
         VALUES (?, ?, 'logout')`,
        [application.id, uri],
      );
    }

    for (const [key, name, description, isDefault] of spec.roles) {
      await db.execute(
        `INSERT INTO application_roles (application_id, role_key, name, description, is_default)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
        [application.id, key, name, description, isDefault],
      );
    }

    for (const [key, description] of spec.permissions) {
      await db.execute(
        `INSERT INTO permissions (application_id, permission_key, description)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE description = VALUES(description)`,
        [application.id, key, description],
      );
    }

    for (const [roleKey, permissionKeys] of Object.entries(spec.rolePermissions || {})) {
      for (const permissionKey of permissionKeys) {
        await db.execute(
          `INSERT IGNORE INTO role_permissions (role_id, permission_id)
           SELECT r.id, p.id
             FROM application_roles r
             JOIN permissions p ON p.application_id = r.application_id
            WHERE r.application_id = ? AND r.role_key = ? AND p.permission_key = ?`,
          [application.id, roleKey, permissionKey],
        );
      }
    }

    // The administrator is a member of everything Vesopa owns, with the
    // strongest role each application defines.
    await db.execute(
      `INSERT INTO application_members (application_id, user_id, status)
       VALUES (?, ?, 'active')
       ON DUPLICATE KEY UPDATE status = 'active'`,
      [application.id, admin.id],
    );
    await db.execute(
      `INSERT IGNORE INTO application_member_roles (member_id, role_id)
       SELECT m.id, r.id
         FROM application_members m
         JOIN application_roles r ON r.application_id = m.application_id
        WHERE m.application_id = ? AND m.user_id = ?`,
      [application.id, admin.id],
    );
  }

  console.log('\nseeded. Client ids above go into each product\'s configuration.');
  console.log('Client secrets are NOT created here — mint them in the developer');
  console.log('portal so the plaintext is shown once and never stored.');

  await db.close();
}

main().catch((error) => {
  console.error('seed failed:', error);
  process.exit(1);
});
