-- ---------------------------------------------------------------------------
-- Signing in to a menu with a Vesopa account.
--
-- ONE NULLABLE COLUMN AND ONE INDEX. Nothing here changes the behaviour of a
-- database that never turns the feature on: `vesopa_sub` stays NULL on every
-- existing row and on every diner who signs in with a code, exactly as they do
-- today. Guest ordering does not touch this table at all.
--
-- The guard procedure is `vesopa_add_column`, defined in schema_branding.sql
-- and used by every migration here. MySQL 5.7 has no `ADD COLUMN IF NOT
-- EXISTS`, and the deploy applies every file on every run — so an unguarded
-- ALTER either fails the whole file on the second deploy or, worse, succeeds at
-- something nobody meant.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Which Vesopa account this diner is, at this venue.
--
-- The `sub` claim from an ID token: opaque, stable for this application, and
-- meaningless to any other. It is NOT the email address — an address changes,
-- and two people can share one — so this is what a returning diner is matched
-- on first.
--
-- 64 characters is generous. Vesopa's own products get a `public` subject,
-- which is a 26-character ULID; a pairwise one is a 43-character base64url
-- hash. Both fit with room to spare, and this is one row per diner per venue,
-- so the width costs nothing.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('dinein_diners', 'vesopa_sub', 'VARCHAR(64) NULL');


-- ---------------------------------------------------------------------------
-- One Vesopa account to one diner row, per venue.
--
-- UNIQUE rather than a plain index, and that is the point of it. Without the
-- constraint, two requests arriving in the same second for the same person —
-- a double-tapped button on a slow connection, which is the normal case at a
-- table — both find no row and both insert one. The venue then has two diner
-- records for one customer and their order history is split between them.
--
-- MySQL treats every NULL in a unique index as distinct, so the millions of
-- rows with no Vesopa account coexist happily: the constraint binds only the
-- rows that actually have a subject.
--
-- Guarded the same way as the column: `information_schema` is asked whether the
-- index is already there, because `ADD INDEX` on a table that has it is an
-- error and this file runs on every deploy.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_index_once;
DELIMITER //
CREATE PROCEDURE vesopa_add_index_once(
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

CALL vesopa_add_index_once(
  'dinein_diners',
  'uq_dinein_diner_vesopa',
  'UNIQUE KEY `uq_dinein_diner_vesopa` (office_id, vesopa_sub)'
);
