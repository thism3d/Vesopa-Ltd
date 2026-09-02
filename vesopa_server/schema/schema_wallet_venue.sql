-- Two things a venue needs that neither wallet platform supplies: the word in
-- its public enrolment URL, and where it actually is.
--
-- WHY THIS EXISTS
--
-- /wallet/join/ was keyed by the office's contact email, so the poster on the
-- table read
--
--     backoffice.vesopaepos.com/wallet/join/manager%40vesopa.co.uk
--
-- which publishes the venue's own email address to every customer who joins and
-- to every browser history it lands in, and reads as a mistake on a table card.
-- A code is what a venue would have been asked for in the first place.
--
-- Sorts after schema_wallet.sql (which creates epos_wallet_settings) and after
-- schema_wallet_apple.sql, because a full stop sorts before an underscore and
-- `apple` before `join`. See schema_till_change_window.sql for why the filename
-- carries the ordering.
--
-- Target is MySQL 5.7 / MariaDB. Guarded, and safe to re-run.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- NULL rather than '' when unset, and that is the whole reason the unique index
-- below can exist: MySQL and MariaDB allow any number of rows to share a NULL
-- in a unique index, but only one to hold the empty string. A venue that has
-- never chosen a code must not collide with the next venue that has not either.
CALL vesopa_add_column(
  'epos_wallet_settings', 'join_slug',
  'VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL');



-- ---------------------------------------------------------------------------
-- Where the venue is.
-- ---------------------------------------------------------------------------
-- Apple puts a pass on the lock screen when the phone is near a location the
-- pass names, which is the one feature that turns a card somebody installed
-- once into a card they use every visit. Nothing else in this schema knows
-- where a venue is -- epos_branding has an address, and an address is not a
-- coordinate -- so the two numbers live here.
--
-- DECIMAL rather than DOUBLE: these are typed in by a person from a maps app,
-- six decimal places is around a tenth of a metre, and exact decimal arithmetic
-- means the value read back is the value that was entered.
--
-- NULL means "not set", and the pass simply omits the key. Zero would be a
-- point in the Atlantic, so it cannot be the default.
CALL vesopa_add_column('epos_wallet_settings', 'latitude',  'DECIMAL(9,6) NULL DEFAULT NULL');
CALL vesopa_add_column('epos_wallet_settings', 'longitude', 'DECIMAL(9,6) NULL DEFAULT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;


DROP PROCEDURE IF EXISTS vesopa_add_unique;
DELIMITER //
CREATE PROCEDURE vesopa_add_unique(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD UNIQUE INDEX `', idx, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- Unique, and enforced by the database rather than by the code that writes it.
-- A code that resolved to two venues would hand one venue's customer the other
-- venue's loyalty card, which is the kind of bug that is only ever found by the
-- customer.
CALL vesopa_add_unique(
  'epos_wallet_settings', 'uq_wallet_join_slug', '`join_slug`');

DROP PROCEDURE IF EXISTS vesopa_add_unique;
