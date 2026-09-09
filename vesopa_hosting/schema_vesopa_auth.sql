-- ---------------------------------------------------------------------------
-- Phase 6, migration three: the hosting panel signs customers in with a Vesopa
-- account.
--
-- Two columns, and no more. The identity provider never writes to this
-- database — rule 1 of the migration plan — and the panel keeps its own
-- customers, its own billing, its own Hestia accounts and its own signed
-- cookie. What is added is a link: "this customer IS that Vesopa person".
--
-- Idempotent, and it defines its own guard procedure and drops it again, the
-- way every schema file in this repository does — a file that merely CALLS the
-- procedure works when run alone and fails the moment it runs after one that
-- dropped it, which is every real deploy.
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

/*
 * The Vesopa `sub` for this customer.
 *
 * Stored rather than matched on the address each time, because an address can
 * change and a subject cannot. The panel is a first-party application, so the
 * subject is the person's own public id — the same value the back office and
 * the till see, which is what lets one human being be one person across all of
 * them.
 */
CALL vesopa_add_column('customers', 'vesopa_sub',
  "VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL");

CALL vesopa_add_column('customers', 'vesopa_linked_at', 'DATETIME NULL DEFAULT NULL');

/*
 * UNIQUE. Without it two customer rows could link to one Vesopa account, and
 * somebody signing in would land in whichever the query returned first — a
 * different person's hosting, their sites and their invoices. NULLs are
 * distinct in a MySQL unique index, so every customer who has not migrated is
 * untouched.
 */
CALL vesopa_add_index('customers', 'uq_customers_vesopa_sub',
  'UNIQUE KEY uq_customers_vesopa_sub (vesopa_sub)');

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
