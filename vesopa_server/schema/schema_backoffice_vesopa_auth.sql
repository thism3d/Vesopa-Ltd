-- ---------------------------------------------------------------------------
-- Phase 6, the second migration: the back office signs staff in with a Vesopa
-- account.
--
-- ONE COLUMN. That is the whole schema change, and it is the point.
--
-- The identity provider never writes to this database — rule 1 of the migration
-- plan — and the back office keeps its own users, its own roles, its own office
-- scoping and its own JWT. What is added is a link: "this local user IS that
-- Vesopa person". Everything downstream of sign-in is untouched, which is what
-- makes rolling the migration back a flag rather than a rescue.
--
-- Idempotent, like every file here: it defines `vesopa_add_column` at the top
-- and drops it at the end, because the deploy applies every schema file every
-- time and a file that merely CALLS the procedure works alone and fails the
-- moment it runs after one that dropped it.
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
 * The Vesopa `sub` for this member of staff.
 *
 * Stored rather than matched on the email every time, because an address can
 * change and a `sub` cannot: once somebody has signed in with Vesopa, this is
 * how they are recognised afterwards even if they later change the address on
 * either side.
 *
 * The back office is registered as a FIRST-PARTY application, so the subject it
 * receives is the person's own public id — the same value the till and the
 * hosting panel see. That is deliberate: the three of them are talking about
 * one member of staff and must agree who that is.
 */
CALL vesopa_add_column('backoffice_users', 'vesopa_sub',
  "VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL");

/* When they first signed in this way — so the soak can be measured rather than
   guessed at, and "how many staff have moved over?" is one query. */
CALL vesopa_add_column('backoffice_users', 'vesopa_linked_at', 'DATETIME NULL DEFAULT NULL');

/*
 * UNIQUE, and that matters more than it looks.
 *
 * Without it, two back-office users could end up linked to one Vesopa account —
 * which would mean one person signing in and landing in whichever row the query
 * happened to return first, possibly in a different office with different
 * permissions. NULLs are distinct in a MySQL unique index, so every user who
 * has not migrated is unaffected.
 */
CALL vesopa_add_index('backoffice_users', 'uq_backoffice_users_vesopa_sub',
  'UNIQUE KEY uq_backoffice_users_vesopa_sub (vesopa_sub)');

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
