-- ---------------------------------------------------------------------------
-- Phase 5, the last two pieces: inviting somebody in, and helping somebody who
-- has lost the thing that proves they are them.
--
-- Idempotent, and every string column pins its collation. New columns go here
-- AND in the CREATE TABLE they belong to — `CREATE TABLE IF NOT EXISTS` does
-- nothing to a table that already exists, so a column added only there never
-- reaches this database.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

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


-- ===========================================================================
-- Invitations
-- ===========================================================================

-- Staff access, which the original table could not express: it could grant
-- developer access and an application role, but not "make this person an
-- administrator" — and the seed was the only way anybody became one.
CALL vesopa_add_column('invitations', 'grants_staff',
  'TINYINT(1) NOT NULL DEFAULT 0 AFTER grants_developer');

-- Which organisation's portal they join as a developer, and in what capacity.
CALL vesopa_add_column('invitations', 'organisation_role',
  "VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'developer' AFTER organisation_id");

-- Shown in the admin list without exposing the token, and used by the accept
-- page to find the invitation from a link that carries the secret separately.
CALL vesopa_add_column('invitations', 'public_id',
  "CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER id");

-- How many times it has been sent. An invitation resent four times usually
-- means the address is wrong, not that the person is ignoring it.
CALL vesopa_add_column('invitations', 'sent_count',
  'SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER message');
CALL vesopa_add_column('invitations', 'last_sent_at',
  'DATETIME NULL AFTER sent_count');

-- Backfill a public id for anything already there, then make it unique.
UPDATE invitations
   SET public_id = CONCAT('INV', LPAD(HEX(id), 10, '0'), SUBSTRING(SHA2(CONCAT(id, token_hash), 256), 1, 13))
 WHERE public_id = '';

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

CALL vesopa_add_index('invitations', 'uq_invitation_public',
  'UNIQUE KEY uq_invitation_public (public_id)');


-- ===========================================================================
-- Getting back in after losing a second factor
-- ===========================================================================

/*
 * WHY THERE IS A DELAY, AND WHY THE PASSWORD IS PAUSED.
 *
 * The attack this exists to survive is not technical. Somebody telephones,
 * says they have lost their phone, is convincing, and an administrator removes
 * their second factor. If that were all, an attacker holding a stolen password
 * would now be inside — and the reset would have been the easiest way in, which
 * is how recovery undoes every other control in an MFA system.
 *
 * Two things stop it, and they are cheap:
 *
 *   `password_paused_until` — after a reset, a password alone will not sign
 *   anybody in. They must prove they can RECEIVE at the address or number on
 *   the account, which is exactly what an attacker with only a password cannot
 *   do. The real owner is barely inconvenienced: they type a code.
 *
 *   `mfa_reset_at` — the moment it happened, so the person's own sign-in
 *   history shows it. A reset nobody did is the one thing they must be able to
 *   see, and the email we send is not enough on its own.
 */
CALL vesopa_add_column('users', 'mfa_reset_at', 'DATETIME NULL AFTER last_login_at');
CALL vesopa_add_column('users', 'mfa_reset_by', 'INT UNSIGNED NULL AFTER mfa_reset_at');
CALL vesopa_add_column('users', 'password_paused_until', 'DATETIME NULL AFTER mfa_reset_by');


-- ---------------------------------------------------------------------------
-- account_recoveries — every time somebody was helped back in.
--
-- A separate table rather than only an audit line, because this is the one
-- action in the system that deliberately weakens an account, and it needs to be
-- answerable as a list: who was helped, by whom, why, and what was removed.
-- "Show me every MFA reset this month" should be one query, not a grep.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_recoveries (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id     CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  user_id       INT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED NULL,

  -- What was taken away. Recorded separately from the reason, because "we
  -- removed the authenticator" and "we removed every passkey" are different
  -- amounts of damage to undo.
  removed_totp     TINYINT(1) NOT NULL DEFAULT 0,
  removed_passkeys SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  reissued_codes   TINYINT(1) NOT NULL DEFAULT 0,

  -- Required, and free text. An administrator who has to write down why is an
  -- administrator who has thought about it, and a reason nobody can read six
  -- months later is worth as little as no reason at all.
  reason        VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- How they were satisfied it was really the person. Not free text: a short
  -- list is answerable, and "how do we usually check?" should have an answer.
  verified_by   ENUM('email_code','sms_code','known_in_person','manager_confirmed','other') NOT NULL,

  notified_at   DATETIME NULL,
  ip            VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_recovery_public (public_id),
  KEY idx_recovery_user (user_id, created_at),
  KEY idx_recovery_actor (actor_user_id, created_at),
  /*
   * `fk_account_recovery_user`, not `fk_recovery_user`.
   *
   * Foreign key constraint names are unique across the WHOLE database in
   * MariaDB, not per table — and `fk_recovery_user` is already taken by
   * `user_recovery_codes`. The collision reports itself as errno 121,
   * "Duplicate key on write or update", on a CREATE TABLE with no data in it,
   * which points at everything except the real cause.
   */
  CONSTRAINT fk_account_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
