-- ---------------------------------------------------------------------------
-- Phase 4 and Phase 5: the developer portal, and figures a dashboard can read.
--
-- Everything here is idempotent, like every other file in this directory, and
-- for the same reason: the deploy applies all of them on every deploy, so the
-- hundredth run has to be as safe as the first.
--
-- REMEMBER THE TRAP THIS LAYOUT SETS. `CREATE TABLE IF NOT EXISTS` does nothing
-- to a table that already exists, so a column added to schema.sql alone changes
-- nothing on a database that has been created once — and the deploy reports
-- "ok" for the file. New tables are safe in either place; new COLUMNS go in
-- schema.sql (for a fresh database) AND in a numbered file (for the ones that
-- exist). Both, every time.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;


-- ===========================================================================
-- WHO MAY ADMINISTER AN APPLICATION
-- ===========================================================================
--
-- `organisation_members` already answers "may this person work on anything this
-- organisation owns". That is the right grain for a customer's own developer
-- and the wrong grain for ours: Vesopa Software Ltd owns the till, the menu,
-- the hosting panel and everything next, and somebody brought in to wire up the
-- QR menu has no business rotating the till's client secret.
--
-- So access is grantable per application as well. A person reaches an
-- application if EITHER holds:
--
--   * they are a member of the organisation that owns it, or
--   * they have a row here for that one application.
--
-- The union is deliberate and the narrow half is the one to reach for. Granting
-- somebody the whole organisation because it was the only thing on the form is
-- how a contractor ends up holding the keys to the tills.
--
-- WHAT EACH ROLE MAY DO, and the one that matters:
--
--   admin      everything below, plus granting access to other people
--   developer  settings, redirect URIs, roles, AND minting client secrets
--   viewer     read only — no secret is ever minted or shown
--
-- `viewer` exists so that "let them look at the configuration" does not have to
-- mean "let them mint a credential". Those are different requests and every
-- portal that conflates them is one support ticket away from an extra secret in
-- somebody's inbox.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_developers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  user_id        INT UNSIGNED NOT NULL,
  role           ENUM('admin','developer','viewer') NOT NULL DEFAULT 'developer',
  granted_by     INT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_app_developer (application_id, user_id),
  KEY idx_app_developer_user (user_id),
  CONSTRAINT fk_appdev_app  FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_appdev_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- FIGURES A DASHBOARD MAY READ
-- ===========================================================================
--
-- The rule from the plan, in one sentence: a dashboard that runs a GROUP BY
-- over every raw event is the thing that falls over first on a busy Saturday,
-- and then the dashboard IS the outage.
--
-- `login_events` is kept for thirteen months because /account/history has to be
-- able to answer "was that me?". That is a lot of rows to scan to draw a bar
-- chart nobody is watching, so the chart reads these instead: one row per day
-- per method per outcome, written once and read for ever.
--
-- The day is a DATE and the primary key includes it, so recomputing a day is an
-- upsert rather than a delete-then-insert — which matters because a rollup that
-- deletes first has a window in which the dashboard shows zero.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_event_daily (
  day        DATE NOT NULL,
  method     VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  outcome    VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  total      INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (day, method, outcome),
  KEY idx_daily_day (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- New people, per day. A separate table rather than another dimension on the
-- one above, because "how many accounts were created" and "how many sign-in
-- attempts were made" are counted from different tables and joining them into
-- one shape would mean one of the two is always a lie about the other.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signup_daily (
  day        DATE NOT NULL,
  total      INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- When the rollup last ran, so that reading the dashboard can trigger it at
-- most once an hour rather than on every page load.
--
-- A row in `settings` would have done, but this is operational state and not a
-- setting an administrator should see in a form beside the sign-in layout.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rollup_state (
  name    VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  ran_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- applications.created_by was declared NULL from the start, but a fresh
-- database and an old one disagree about two columns the portal writes. Added
-- here for the databases that already exist; the CREATE in schema.sql covers
-- the ones that do not.
--
-- `deleted_at` rather than a DELETE. An application whose rows are removed
-- takes its `application_members`, its consents and its refresh tokens with it,
-- and a developer who presses Delete on the wrong line has ended every session
-- their customers hold. Archiving stops it working and keeps the evidence.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('applications', 'deleted_at', 'DATETIME NULL AFTER status');
CALL vesopa_add_column('applications', 'archived_by', 'INT UNSIGNED NULL AFTER deleted_at');


-- ---------------------------------------------------------------------------
-- login_events.method gains `tooling`.
--
-- WHY AN ENUM NEEDS ITS OWN GUARD. `vesopa_add_column` does nothing when the
-- column exists and `vesopa_widen_column` only compares lengths, so neither can
-- see that an ENUM is missing a value. Running the ALTER unguarded would rebuild
-- this table — the biggest one here — on every single deploy, taking a lock
-- nobody asked for. So it is conditional on the value genuinely being absent.
--
-- MariaDB stores the full definition in COLUMN_TYPE, so "does this enum already
-- have that value" is a LIKE against it. The quotes matter: without them a
-- column named `tooling_something` would match and the migration would decide
-- it had already run.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_enum_value;
DELIMITER //
CREATE PROCEDURE vesopa_add_enum_value(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_value  VARCHAR(64),
  IN p_ddl    TEXT)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_column
       AND COLUMN_TYPE NOT LIKE CONCAT('%'', p_value, ''%'))
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` MODIFY COLUMN `', p_column, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_enum_value('login_events', 'method', 'tooling', "ENUM('password','email_code','sms_otp','passkey','google','apple','microsoft','github','recovery_code','totp','device','refresh','tooling') NOT NULL");
