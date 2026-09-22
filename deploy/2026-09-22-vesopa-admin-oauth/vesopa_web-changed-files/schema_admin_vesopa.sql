-- "Continue with Vesopa" for /admin — see src/admin/vesopa-auth.js.
--
-- Guarded throughout, so re-running is safe. Run against the same database as
-- schema_admin.sql:
--
--     mysql vesopa_eposdb < schema_admin_vesopa.sql
--
-- WHAT IT ADDS
--
--   admin_table.vesopa_sub        the Vesopa subject an admin is linked to. Set
--                                 on their first Vesopa sign-in, matched by
--                                 verified email; after that the subject alone
--                                 identifies them.
--   admin_table.vesopa_linked_at  when that happened.
--
-- `vesopa_sub` is utf8mb4_bin, not the table's unicode_ci. A subject is an
-- opaque case-SENSITIVE string, and under a case-insensitive collation two
-- different subjects differing only in case would collide on the unique key —
-- the same trap auth.vesopa.com's plan records for identifier_norm.
--
-- WHO GETS AN ADDRESS
--
-- The two legacy full-admin logins have no email, so no Vesopa account can ever
-- match them. The owner's decision (2026-09-22): Vesopa sign-in for admin goes
-- to info@vesopasoftware.com. `email` is UNIQUE, so it can sit on one row only;
-- it goes on `vesopaepos` (id 7). `vesopa2024` (id 6) keeps its password for the
-- soak and should be disabled when VESOPA_AUTH_ADMIN_ONLY is switched on.
-- The UPDATE is guarded on the row still having no address and nobody else
-- holding this one, so it can never overwrite anything.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER $$
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = tbl AND column_name = col) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER $$
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE()
                   AND table_name = tbl AND index_name = idx) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD ', spec);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL vesopa_add_column('admin_table', 'vesopa_sub',
  'VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL');
CALL vesopa_add_column('admin_table', 'vesopa_linked_at', 'DATETIME NULL DEFAULT NULL');
CALL vesopa_add_index('admin_table', 'uq_admin_table_vesopa_sub',
  'UNIQUE KEY `uq_admin_table_vesopa_sub` (`vesopa_sub`)');

UPDATE admin_table
   SET email = 'info@vesopasoftware.com'
 WHERE id = 7
   AND username = 'vesopaepos'
   AND email IS NULL
   AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM admin_table
                                   WHERE email = 'info@vesopasoftware.com') AS taken);

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
