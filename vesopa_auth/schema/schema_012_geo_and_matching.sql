-- ---------------------------------------------------------------------------
-- Two small things the account pages and the sign-in path were missing.
--
-- 1. `geo_cache` — the country an address is in, remembered.
--
--    `sso_sessions.country`, `devices.last_country` and `login_events.country`
--    have existed since schema_002 and have never been written to, so "Where
--    you are signed in now" shows a bare IPv4 address and nothing else. The
--    lookup itself is the one vesopa_hosting/src/geo.js already does; this is
--    the table it caches into, so a person's own devices page does not cost a
--    third-party request per row.
--
--    ADDRESSES ARE STORED HASHED, with a per-install salt. We need to recognise
--    an address we have already looked up. We do not need to be able to read
--    back a list of every address that has ever reached this server — and a
--    table that cannot be read back is a table that cannot leak. On an identity
--    provider that distinction is worth the one-line cost.
--
-- 2. `user_identities.asserted_email_norm`.
--
--    Every identifier in this system is stored twice — once as written, once
--    normalised — because that is the only way `Sam@example.com` and
--    `sam@example.com` are one account. `asserted_email`, the address Google or
--    GitHub told us about, was the one exception, and the exception is exactly
--    what let one person end up with two accounts: signing in with GitHub made
--    an account holding `muzahid@onzep.uk`, and typing that address on the
--    sign-in page made a second one, because nothing could match them.
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

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN p_table VARCHAR(64),
  IN p_name  VARCHAR(64),
  IN p_ddl   TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND INDEX_NAME   = p_name)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Where an address is
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS geo_cache (
  ip_hash    CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  country    CHAR(2)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ip_hash),
  KEY idx_geo_age (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- When this session last proved, again, that it is the account's owner
-- ---------------------------------------------------------------------------
--
-- Changing a recovery address is the one setting that decides who gets the
-- account back after everything else has been lost, so it is the one setting an
-- attacker with a borrowed session wants most. `reauth_at` is what lets that
-- edit demand a password or a second factor without signing anybody out — a
-- step-up in the ordinary sense, but one that a person with no second factor
-- enrolled can also pass, which `sso_sessions.acr` cannot express.
CALL vesopa_add_column('sso_sessions', 'reauth_at', 'DATETIME NULL AFTER acr');

-- ---------------------------------------------------------------------------
-- The address a provider asserted, in the form we compare against
-- ---------------------------------------------------------------------------

CALL vesopa_add_column(
  'user_identities',
  'asserted_email_norm',
  "VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' AFTER asserted_email");

CALL vesopa_add_index(
  'user_identities',
  'idx_identity_asserted',
  'KEY idx_identity_asserted (asserted_email_norm, asserted_email_verified)');

-- Backfill. This mirrors src/normalise.js: lower-case everything, and for
-- Gmail only, drop the dots and the +tag — Google states those are one mailbox,
-- and treating them as three is how one person mints three accounts.
--
-- Guarded by the WHERE, so re-running the deploy does not rewrite rows the
-- application has since written correctly.
UPDATE user_identities
   SET asserted_email_norm = CASE
     WHEN LOWER(SUBSTRING_INDEX(asserted_email, '@', -1)) IN ('gmail.com', 'googlemail.com')
       THEN CONCAT(
              REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(LOWER(asserted_email), '@', 1), '+', 1), '.', ''),
              '@gmail.com')
     ELSE LOWER(asserted_email)
   END
 WHERE asserted_email <> ''
   AND asserted_email LIKE '%@%.%'
   AND asserted_email_norm = '';

