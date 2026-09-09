-- ---------------------------------------------------------------------------
-- vesopasoftware_authdb — auth.vesopa.com, the Vesopa identity provider.
--
-- COLLATION IS PINNED ON EVERY STRING COLUMN, DELIBERATELY.
-- On the live MariaDB a bare `utf8mb4` resolves to `uca1400_ai_ci`, which does
-- not compare against `general_ci`. An email column left bare joins fine on a
-- dev machine and silently matches nothing in production — which in an identity
-- provider means "no such account" for a person who has one. Never write a bare
-- VARCHAR in this file.
--
-- IDEMPOTENT. The deploy applies every schema file every time, so each one must
-- survive being run twice. CREATE TABLE IF NOT EXISTS everywhere, and
-- `vesopa_add_column` guards the ALTERs.
--
-- THE ONE IDEA THAT SHAPES THE WHOLE THING
-- A person is a `user`. Everything they can prove they own — an email address,
-- a phone number, a Google account — is a row in `user_identities`. Everything
-- they can prove they know or hold — a password, a TOTP secret, a passkey — is
-- a credential. Identifiers and credentials are different things, and merging
-- them is why so many systems cannot answer "sign me in with Google, then let
-- me add a password later".
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Guard procedure: add a column only if it is missing.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_ddl    TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_column)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Guard procedure: add an index only if it is missing.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_ddl   TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND INDEX_NAME   = p_index)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- PEOPLE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- identity_providers — the list of ways an identity can be named.
--
-- This is a table and not an ENUM because the owner expects to add providers,
-- and an ENUM turns "support Facebook sign-in" into an ALTER on the largest
-- table in the system. A row here is cheap; a schema migration on a live
-- identity table at 8pm on a Friday is not.
--
-- `kind` separates the two things that behave differently everywhere in the
-- code: an identifier we can send a code to, and an account at somebody else's
-- identity provider.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity_providers (
  provider_key VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  kind         ENUM('contact','social') NOT NULL,
  name         VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- Whether an email address this provider asserts may be trusted as proof of
  -- ownership without us sending our own code. Google with email_verified,
  -- Apple and Microsoft: yes. GitHub: only after checking /user/emails.
  trusts_email TINYINT(1) NOT NULL DEFAULT 0,
  is_enabled   TINYINT(1) NOT NULL DEFAULT 1,
  sort_order   SMALLINT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO identity_providers (provider_key, kind, name, trusts_email, sort_order) VALUES
  ('email',     'contact', 'Email address',    1, 10),
  ('phone',     'contact', 'Phone number',     0, 20),
  ('google',    'social',  'Google',           1, 30),
  ('apple',     'social',  'Apple',            1, 40),
  ('microsoft', 'social',  'Microsoft',        1, 50),
  ('github',    'social',  'GitHub',           0, 60)
ON DUPLICATE KEY UPDATE name = VALUES(name), kind = VALUES(kind);

-- ---------------------------------------------------------------------------
-- users — one row per human being, for ever.
--
-- `public_id` is what leaves this server. The auto-increment `id` is a foreign
-- key and nothing else: exposing it tells every client how many people Vesopa
-- has and lets them walk the list by adding one.
--
-- There is no email column here and that is the point. An address lives in
-- user_identities, because a person may have several, may change them, and may
-- have arrived with none at all (phone-only, or a private Apple relay).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id         CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  display_name      VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  given_name        VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  family_name       VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  date_of_birth     DATE NULL,
  avatar_path       VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  locale            VARCHAR(12)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'en-GB',
  timezone          VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Europe/London',

  -- Which identity is "the" address and "the" number for this person. Nullable
  -- because a brand-new phone-only account has no email at all.
  primary_email_id  INT UNSIGNED NULL,
  primary_phone_id  INT UNSIGNED NULL,

  status            ENUM('active','suspended','merged','deleted') NOT NULL DEFAULT 'active',
  suspended_reason  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- People end up with two accounts. When they are merged the loser is kept as
  -- a tombstone pointing at the survivor, never deleted: anything that recorded
  -- the old id — an order, an audit line — must still resolve to a person.
  merged_into_user_id INT UNSIGNED NULL,

  -- Set when the person asks for deletion. The row survives the request so that
  -- an identifier cannot be recycled the same afternoon by whoever asked, and
  -- so that a mistaken deletion is recoverable inside the grace period.
  deletion_requested_at DATETIME NULL,
  deleted_at        DATETIME NULL,

  is_staff          TINYINT(1) NOT NULL DEFAULT 0,   -- may reach the admin console
  is_developer      TINYINT(1) NOT NULL DEFAULT 0,   -- may create applications

  -- The `user.id` handed to an authenticator during a passkey ceremony, and
  -- handed back to us on a usernameless sign-in.
  --
  -- Opaque random bytes, never the email address and never `public_id`. It is
  -- stored on the authenticator — on the person's phone, in their iCloud
  -- Keychain — so anything meaningful in it is personal data we have written
  -- onto hardware we do not control and cannot erase. `public_id` is a ULID and
  -- carries a creation timestamp, which is exactly the sort of thing that
  -- should not leak into somebody's password manager.
  webauthn_handle   VARBINARY(64) NULL,

  last_login_at     DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_users_public_id (public_id),
  KEY idx_users_status (status),
  KEY idx_users_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- user_identities — every way a person is *named*: addresses, numbers, and the
-- accounts they hold at Google, Apple, Microsoft and GitHub.
--
-- THE UNIQUENESS RULE, WHICH IS THE WHOLE REASON THIS TABLE LOOKS LIKE THIS
--
-- The owner's rule: one Google account (or address, or number) belongs to
-- exactly one Vesopa account *while it is active*; unlink it and it becomes
-- free for somebody else; the history is never thrown away.
--
-- MySQL has no partial indexes, so "unique only among the live rows" cannot be
-- written as a WHERE clause on an index. It can be written as a generated
-- column: `active_flag` is 1 while the row is live and NULL once it is revoked,
-- and a UNIQUE index treats every NULL as distinct. So
-- (type, identifier_norm, active_flag) permits any number of revoked rows for
-- the same address and exactly one live one.
--
-- This matters more than it looks. Enforcing it in application code means a
-- SELECT then an INSERT, and two people registering the same address in the
-- same second both see "free" and both insert. The index is what actually
-- closes that race; the code just has to catch ER_DUP_ENTRY (1062) and say
-- "that address is already in use" instead of a 500.
--
-- `identifier_norm` is the comparison key and `identifier` is what the person
-- typed. Both are kept: normalising away the difference between Bob@… and
-- bob@… is right for matching and wrong for the From: line of an email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_identities (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,

  -- VARCHAR and not ENUM: the owner expects to add providers, and an ENUM makes
  -- "support Facebook" an ALTER TABLE on a live table. Referential integrity
  -- comes from identity_providers instead.
  type            VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- As given: the address with its original case, the number as dialled.
  identifier      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- The comparison key: lower-cased email, E.164 phone, provider `sub` claim.
  --
  -- utf8mb4_bin, NOT general_ci, and this is not a style choice. A provider's
  -- subject id is an opaque case-SENSITIVE string — GitHub node ids and
  -- Microsoft object ids both mix case. Under general_ci, `AbC` and `abc` are
  -- equal, so two different people's provider accounts collide on the unique
  -- index: the second one to sign in is either refused or, worse, handed the
  -- first one's account. Case-folding is this application's job at write time
  -- (emails are lower-cased before they get here) and must never be delegated
  -- to a collation that also folds things we need kept apart.
  identifier_norm VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  -- For a social identity, the address the provider told us about — shown in
  -- the UI as "Google (bob@gmail.com)". Never used for matching.
  display         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  verified_at     DATETIME NULL,
  -- HOW it was proved: 'otp', 'email_code', 'google', 'apple', … Provenance
  -- matters because the strength of the proof differs, and a merge must never
  -- launder a weak proof into a strong one.
  verified_via    VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- What the provider CLAIMED this account's email is, and whether it said it
  -- had verified it. Kept apart from `identifier` because a claim is not a
  -- proof: GitHub will hand over an unverified address, and treating that as
  -- evidence of ownership is how an account gets taken over. Used to offer a
  -- link, never to perform one.
  asserted_email          VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  asserted_email_verified TINYINT(1) NULL,

  -- A recovery address or number: usable to get back in, not to sign in with.
  is_recovery     TINYINT(1) NOT NULL DEFAULT 0,

  -- Apple hands out per-application relay addresses. They are real, they
  -- forward, and they are NOT the person's own address — so they must never be
  -- treated as evidence that this is the same human as a matching @icloud.com.
  is_private_relay TINYINT(1) NOT NULL DEFAULT 0,

  revoked_at      DATETIME NULL,
  revoked_reason  VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- 1 while live, NULL once revoked. See the note above: this column is the
  -- uniqueness rule, and it is generated so that no code path can forget it.
  active_flag     TINYINT(1) GENERATED ALWAYS AS (IF(revoked_at IS NULL, 1, NULL)) STORED,

  profile         JSON NULL,          -- raw claims from the provider, as received
  last_used_at    DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_identity_active (type, identifier_norm, active_flag),
  KEY idx_identity_user (user_id, type),
  KEY idx_identity_lookup (identifier_norm, type),
  CONSTRAINT fk_identity_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_identity_provider FOREIGN KEY (type) REFERENCES identity_providers (provider_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- user_passwords — optional, and separate from `users` on purpose.
--
-- Most accounts here will not have one. A person who signs in with Google, or
-- with a code to their phone, never needs a password, and a NULL password_hash
-- column on `users` is how "no password set" and "password not loaded" become
-- the same value in a query result and somebody is signed in without one.
--
-- One live row per user; the history rows keep old hashes so a password cannot
-- be re-used, and carry `retired_at` to say when each stopped being current.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_passwords (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  password_hash  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  algorithm      VARCHAR(32)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'bcrypt',
  must_change    TINYINT(1) NOT NULL DEFAULT 0,
  retired_at     DATETIME NULL,
  active_flag    TINYINT(1) GENERATED ALWAYS AS (IF(retired_at IS NULL, 1, NULL)) STORED,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_password_active (user_id, active_flag),
  KEY idx_password_user (user_id, created_at),
  CONSTRAINT fk_password_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- SECOND FACTORS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- user_totp — authenticator apps.
--
-- The secret is stored encrypted, not hashed: TOTP has to recompute the code,
-- so the server must be able to read it back. The key comes from the
-- application environment (MFA_SECRET_KEY) and never from this database, so a
-- dumped table alone does not produce working codes.
--
-- `last_step` is replay defence: a code is valid for a 30-second step, and
-- without recording the step used, the same six digits shoulder-surfed from a
-- phone work again for the rest of that window.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_totp (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  label          VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Authenticator',
  secret_cipher  VARBINARY(512) NOT NULL,
  digits         TINYINT UNSIGNED NOT NULL DEFAULT 6,
  period_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  confirmed_at   DATETIME NULL,          -- enrolment is not complete until a code proves it
  last_step      BIGINT UNSIGNED NULL,   -- replay defence
  last_used_at   DATETIME NULL,
  revoked_at     DATETIME NULL,
  active_flag    TINYINT(1) GENERATED ALWAYS AS (IF(revoked_at IS NULL, 1, NULL)) STORED,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_totp_user (user_id, active_flag),
  CONSTRAINT fk_totp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- user_passkeys — WebAuthn credentials.
--
-- `credential_id` is binary and globally unique, so it is the natural key and
-- also the lookup for a discoverable ("usernameless") sign-in: the browser
-- hands back an id and this table says whose it is.
--
-- `sign_count` is kept but treated gently. In 2026 most passkeys are synced
-- across a person's devices and report a counter of zero for ever; refusing a
-- login because the counter did not increase locks out the ordinary case. It is
-- recorded, and a *decrease* from a non-zero counter is worth an alert, not a
-- refusal.
--
-- `backup_eligible` / `backup_state` are what tell the user "this passkey is in
-- your iCloud Keychain" rather than "this passkey only exists on that laptop" —
-- which is the difference between a safe recovery story and a lockout.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_passkeys (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NOT NULL,
  -- The spec allows a credential id of up to 1023 bytes, and a security key
  -- that uses long ids is not exotic. Truncating one silently makes that
  -- passkey unrecognisable at sign-in — for that person, on that key, only.
  credential_id    VARBINARY(1023) NOT NULL,
  -- A COSE public key: small for the EC keys nearly everything uses, several
  -- hundred bytes for an RSA authenticator. 2048 leaves room for both.
  public_key       VARBINARY(2048) NOT NULL,
  sign_count       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- Whether the authenticator actually verified the human (a PIN, a face, a
  -- fingerprint) rather than merely being present. This is what makes a passkey
  -- worth two factors instead of one, so it is recorded per credential.
  user_verified    TINYINT(1) NOT NULL DEFAULT 0,
  transports       VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  aaguid           CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  name             VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Passkey',
  backup_eligible  TINYINT(1) NOT NULL DEFAULT 0,
  backup_state     TINYINT(1) NOT NULL DEFAULT 0,
  device_type      VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  last_used_at     DATETIME NULL,
  revoked_at       DATETIME NULL,
  active_flag      TINYINT(1) GENERATED ALWAYS AS (IF(revoked_at IS NULL, 1, NULL)) STORED,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_passkey_credential (credential_id),
  KEY idx_passkey_user (user_id, active_flag),
  CONSTRAINT fk_passkey_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- user_recovery_codes — the way back in when the phone is gone.
--
-- Hashed like passwords, because they are passwords. Single use: `used_at`
-- rather than a delete, so "you have three left" is answerable and so that a
-- support call can see one was spent last Tuesday.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  code_hash   VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  used_at     DATETIME NULL,
  used_ip     VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  batch_id    CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_recovery_user (user_id, used_at),
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- ORGANISATIONS AND APPLICATIONS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- organisations — who owns a set of applications.
--
-- This exists so that "these two apps may share a user" has something to be
-- true *of*. Sharing is scoped to an organisation and consented to by the
-- person; two apps in different organisations can never see each other's users,
-- however friendly their owners are.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisations (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id     CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  name          VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  slug          VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  owner_user_id INT UNSIGNED NOT NULL,
  is_first_party TINYINT(1) NOT NULL DEFAULT 0,  -- Vesopa's own
  status        ENUM('active','suspended') NOT NULL DEFAULT 'active',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_org_public_id (public_id),
  UNIQUE KEY uq_org_slug (slug),
  KEY idx_org_owner (owner_user_id),
  CONSTRAINT fk_org_owner FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- organisation_members — developers who can administer an organisation's apps.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisation_members (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id  INT UNSIGNED NOT NULL,
  user_id          INT UNSIGNED NOT NULL,
  role             ENUM('owner','admin','developer','viewer') NOT NULL DEFAULT 'developer',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_org_member (organisation_id, user_id),
  KEY idx_org_member_user (user_id),
  CONSTRAINT fk_org_member_org  FOREIGN KEY (organisation_id) REFERENCES organisations (id) ON DELETE CASCADE,
  CONSTRAINT fk_org_member_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- applications — an OAuth client. The till, the menu, the back office, the
-- hosting panel, and whatever a developer registers later.
--
-- `client_id` is public and appears in URLs. Secrets are NOT here: they live in
-- application_secrets, hashed, because a client secret is a password and a
-- table you can SELECT * from in front of a customer should not contain one.
--
-- `client_type` decides what the authorisation endpoint will allow. A `spa` or
-- a `native` client is public — it cannot keep a secret, so PKCE is mandatory
-- and no secret is issued. Getting this wrong in the other direction, and
-- trusting a secret shipped inside an Electron app, is the classic hole.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id   INT UNSIGNED NOT NULL,
  client_id         CHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  name              VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  slug              VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  description       VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  client_type       ENUM('web','spa','native','service') NOT NULL DEFAULT 'web',
  is_first_party    TINYINT(1) NOT NULL DEFAULT 0,  -- Vesopa's own: consent screen skipped

  -- Shown on the consent screen and in the user's "connected apps" list. A
  -- consent screen with no logo and no links is the one people click through
  -- without reading.
  logo_path         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  homepage_url      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  privacy_url       VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  terms_url         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  support_email     VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- Whether this app's users may be seen by sibling apps in the same
  -- organisation. Off by default: sharing is a decision, never an accident.
  shares_directory  TINYINT(1) NOT NULL DEFAULT 0,

  -- The assurance level this app insists on, over and above the user's own
  -- choice: '' means "whatever the user has set up", 'aal2' means "a second
  -- factor, every time". A back office can demand more than a QR menu.
  min_acr           VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- May a person who has never used this app sign into it, or must somebody
  -- add them first? A QR menu says yes; a back office says no.
  allow_self_enroll TINYINT(1) NOT NULL DEFAULT 1,

  -- Does this application serve people who are NOT SIGNED IN AT ALL?
  --
  -- The QR menu does: guest ordering is the default and every part of that page
  -- works without an account. Recording it here is what stops the next person
  -- putting the sign-in check one layer too high and asking a diner with food
  -- coming to register before they can read a menu — a failure nobody catches
  -- in testing, because everybody testing it has an account.
  guest_allowed     TINYINT(1) NOT NULL DEFAULT 0,

  -- WHAT `sub` THIS APP SEES FOR A GIVEN PERSON.
  --
  -- `public`  — the person's own stable id, the same across every app that
  --             gets `public`. Vesopa's own products use this: the till and the
  --             back office are talking about the same staff member and must
  --             agree on who that is.
  -- `pairwise`— an id derived from (user, this app). A third-party developer
  --             gets a subject that is stable for them and useless to anybody
  --             else, so two unrelated apps cannot compare notes to work out
  --             that their users are the same person.
  --
  -- Default pairwise, because the safe default for a stranger's app is the
  -- private one, and first-party apps are the exception we set deliberately.
  subject_type      ENUM('public','pairwise') NOT NULL DEFAULT 'pairwise',
  -- Salt for the pairwise derivation. Keyed to the application, never to its
  -- redirect URI host: loopback ports move and URIs get added, and a subject
  -- that changes when a developer edits a setting orphans every row they have
  -- stored against it.
  sector_salt       CHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  access_token_ttl  INT UNSIGNED NOT NULL DEFAULT 900,      -- 15 minutes
  refresh_token_ttl INT UNSIGNED NOT NULL DEFAULT 2592000,  -- 30 days

  status            ENUM('active','suspended','pending') NOT NULL DEFAULT 'active',

  -- ARCHIVED, NOT DELETED. Removing an application's row takes its members, its
  -- consents and its refresh tokens with it, so a developer who presses Delete
  -- on the wrong line has ended every session their customers hold. This stops
  -- it working and keeps the evidence.
  deleted_at        DATETIME NULL,
  archived_by       INT UNSIGNED NULL,

  created_by        INT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_app_client_id (client_id),
  UNIQUE KEY uq_app_slug (slug),
  KEY idx_app_org (organisation_id),
  CONSTRAINT fk_app_org FOREIGN KEY (organisation_id) REFERENCES organisations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- application_secrets — hashed, rotatable, and several at once.
--
-- Several at once is the point: rotating a secret means adding the new one,
-- deploying, then revoking the old one. One column on `applications` would mean
-- every rotation is an outage.
--
-- `hint` is the last four characters, so a developer can tell two secrets apart
-- in a list without the list containing either of them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_secrets (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  secret_hash    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  hint           CHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  label          VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  last_used_at   DATETIME NULL,
  expires_at     DATETIME NULL,
  revoked_at     DATETIME NULL,
  created_by     INT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_secret_app (application_id, revoked_at),
  CONSTRAINT fk_secret_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- application_redirect_uris — where an authorisation code may be sent.
--
-- Exact string match, no wildcards, no prefix matching. Every open-redirect
-- hole in an OAuth server has started with somebody being helpful about
-- matching, and "https://app.example.com/cb" vs "https://app.example.com/cb/"
-- being close enough. The only concession is the loopback rule for native
-- clients, where the port is chosen at runtime and cannot be registered — that
-- is handled in code, for `native` clients only, and nowhere else.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_redirect_uris (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  uri            VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  kind           ENUM('login','logout') NOT NULL DEFAULT 'login',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_redirect (application_id, kind, uri),
  CONSTRAINT fk_redirect_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- application_grants — which OAuth grant types this client may use.
-- Written as rows rather than a JSON blob so that "which of our apps still use
-- the password grant" is a query and not a scan.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_grants (
  application_id INT UNSIGNED NOT NULL,
  grant_type     ENUM('authorization_code','refresh_token','client_credentials','device_code') NOT NULL,
  PRIMARY KEY (application_id, grant_type),
  CONSTRAINT fk_grant_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- scopes and application_scopes — what an application may ask for.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scopes (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  title        VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- The sentence shown on the consent screen. Written for the person being
  -- asked, not for the developer asking: "See your name and profile picture".
  description  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  is_default   TINYINT(1) NOT NULL DEFAULT 0,
  is_sensitive TINYINT(1) NOT NULL DEFAULT 0,   -- needs review before an app may ask
  -- Some scopes are worth more than others. A scope that moves money can demand
  -- a second factor on its own, without the whole application having to.
  min_acr      VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_scope_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS application_scopes (
  application_id INT UNSIGNED NOT NULL,
  scope_id       INT UNSIGNED NOT NULL,
  PRIMARY KEY (application_id, scope_id),
  CONSTRAINT fk_appscope_app   FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_appscope_scope FOREIGN KEY (scope_id) REFERENCES scopes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- WHO MAY DO WHAT, INSIDE AN APPLICATION
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- application_roles — the answer to the owner's EPOS question.
--
-- The owner asked whether "Vesopa EPOS" should be one application whose users
-- are separated into till, menu and back-office people, or three applications.
-- It is ONE application with ROLES, and the reason is the failure mode of the
-- alternative: three applications means one human being holds three accounts,
-- and the manager who is also a till operator has to remember which one she
-- used. Roles keep one person, one account, and let the app ask "may this
-- person open the back office?".
--
-- A role belongs to an application, so `till.operator` in the EPOS app and
-- `till.operator` in somebody else's app are unrelated strings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_roles (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  role_key       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  name           VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  description    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  is_default     TINYINT(1) NOT NULL DEFAULT 0,   -- given to every new member
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_role (application_id, role_key),
  CONSTRAINT fk_role_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- application_members — this person is a user of that application.
--
-- The isolation the owner asked for lives here, and it is worth being precise
-- about what it means. There is ONE pool of people: a person who already has a
-- Vesopa account does not make a second one to use another Vesopa app. What is
-- isolated is *visibility* — an application may only see the people who have a
-- membership row for it, and may only see the profile fields its scopes cover.
--
-- The alternative, a separate user pool per application, was rejected because
-- it makes single sign-on impossible, which is the entire point of building
-- this.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_members (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  user_id        INT UNSIGNED NOT NULL,

  -- An application's own id for this person, if it has one — the EPOS staff id,
  -- the menu customer id. Lets an existing app map its rows onto an identity
  -- without changing its own primary keys.
  external_ref   VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  status         ENUM('active','invited','suspended','removed') NOT NULL DEFAULT 'active',
  first_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_member (application_id, user_id),
  KEY idx_member_user (user_id),
  KEY idx_member_status (application_id, status),
  CONSTRAINT fk_member_app  FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


CREATE TABLE IF NOT EXISTS application_member_roles (
  member_id  INT UNSIGNED NOT NULL,
  role_id    INT UNSIGNED NOT NULL,
  granted_by INT UNSIGNED NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id, role_id),
  CONSTRAINT fk_mr_member FOREIGN KEY (member_id) REFERENCES application_members (id) ON DELETE CASCADE,
  CONSTRAINT fk_mr_role   FOREIGN KEY (role_id)   REFERENCES application_roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- permissions / role_permissions — what a role is allowed to DO.
--
-- Roles are names; permissions are the things code checks. Keeping them apart
-- means an application can rename "Supervisor" to "Duty Manager", or split one
-- role into two, without hunting for every `if (role === 'supervisor')` in a
-- till, a menu and a back office.
--
-- Only role KEYS travel in a token. Permissions are resolved by the resource
-- server from a cached per-application pull, because a token carrying forty
-- permission strings is a token nobody wants to put in a header.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  permission_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  description    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_permission (application_id, permission_key),
  CONSTRAINT fk_perm_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INT UNSIGNED NOT NULL,
  permission_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id)       REFERENCES application_roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- data_share_groups — the owner's "apps in the same account may share data".
--
-- A developer puts two or more of THEIR OWN applications into a group, and the
-- person signing in is told, in the consent screen, in one sentence naming both
-- apps: "Vesopa EPOS and Vesopa Back Office share your profile and email."
--
-- Two constraints make this safe rather than a hole. A group may only contain
-- applications of one organisation, so friendliness between two developers can
-- never become a data flow. And sharing is carried out server-side against the
-- internal user id — never by handing both apps the same `sub` — so a group
-- being disbanded does not leave two apps holding a shared correlation key for
-- ever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_share_groups (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  organisation_id INT UNSIGNED NOT NULL,
  name            VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  description     VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_share_public (public_id),
  KEY idx_share_org (organisation_id),
  CONSTRAINT fk_share_org FOREIGN KEY (organisation_id) REFERENCES organisations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS data_share_group_apps (
  group_id       INT UNSIGNED NOT NULL,
  application_id INT UNSIGNED NOT NULL,
  added_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, application_id),
  CONSTRAINT fk_sga_group FOREIGN KEY (group_id)       REFERENCES data_share_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_sga_app   FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
