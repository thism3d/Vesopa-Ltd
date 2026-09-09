-- ---------------------------------------------------------------------------
-- Columns added after the tables already existed.
--
-- WHY THIS FILE HAS TO EXIST AT ALL, because it is the trap this schema layout
-- sets for anybody editing it:
--
--   `CREATE TABLE IF NOT EXISTS` does NOTHING to a table that is already there.
--   Adding a column to the CREATE statement in schema.sql therefore changes
--   nothing on any database that has been created once — and reports success.
--   The schema on disk and the schema in the database drift apart silently, and
--   the first symptom is `Unknown column` from a query that works locally.
--
-- That is exactly what happened here: `users.webauthn_handle` was added to
-- schema.sql, the deploy re-applied every file, every file said "ok", and the
-- first person to create an account got a 500.
--
-- So: a new column goes in schema.sql (for a fresh database) AND in a numbered
-- file here (for the ones that exist). Both, every time.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- A guard for widening a column, alongside `vesopa_add_column`.
--
-- Needed because ALTER … MODIFY is not free: it rebuilds the table. Running it
-- on every deploy of a large table is a lock nobody asked for, so this only
-- acts when the column is genuinely narrower than it should be.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_widen_column;
DELIMITER //
CREATE PROCEDURE vesopa_widen_column(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_length INT,
  IN p_ddl    TEXT)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_column
       AND COALESCE(CHARACTER_MAXIMUM_LENGTH, 0) < p_length)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` MODIFY COLUMN `', p_column, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- users.webauthn_handle
--
-- The `user.id` an authenticator stores and hands back on a usernameless
-- sign-in. Opaque random bytes: it ends up on the person's phone and in their
-- iCloud Keychain, so it must carry no personal data and must not be the ULID
-- public_id, which encodes a creation timestamp.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('users', 'webauthn_handle', 'VARBINARY(64) NULL AFTER is_developer');

-- ---------------------------------------------------------------------------
-- Passkey credentials.
--
-- The spec permits a credential id up to 1023 bytes, and a public key large
-- enough for an RSA authenticator. Truncating either makes that one passkey
-- unrecognisable at sign-in — for that person, on that key, with no error
-- anywhere to explain it.
-- ---------------------------------------------------------------------------
CALL vesopa_widen_column('user_passkeys', 'credential_id', 1023, 'VARBINARY(1023) NOT NULL');
CALL vesopa_widen_column('user_passkeys', 'public_key', 2048, 'VARBINARY(2048) NOT NULL');
CALL vesopa_add_column('user_passkeys', 'user_verified', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER sign_count');


-- ---------------------------------------------------------------------------
-- Backfill: give every existing account a handle.
--
-- RANDOM_BYTES exists on this MariaDB. Without a handle a person cannot enrol a
-- passkey, and the failure would appear months from now on an account made
-- today.
-- ---------------------------------------------------------------------------
UPDATE users SET webauthn_handle = RANDOM_BYTES(32) WHERE webauthn_handle IS NULL;
