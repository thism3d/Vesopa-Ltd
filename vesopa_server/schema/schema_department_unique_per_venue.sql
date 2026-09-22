-- ===========================================================================
-- A department name belongs to a venue, not to the platform.
-- ===========================================================================
--
-- THE FAULT
--
-- `bo_product_groups` and `bo_product_departments` each carried a UNIQUE index
-- on the name alone — `group_name`, `department_name` — inherited from the
-- original single-tenant database, where there was only ever one venue and the
-- constraint was correct.
--
-- On a platform it means a department name can exist exactly once in the
-- country. The Vesopa Kitchen has had a sub department called "Soft Drinks"
-- since July, so no other venue on the system could ever create one. A new
-- venue importing an ordinary catalogue hit:
--
--     Duplicate entry 'Soft Drinks' for key 'group_name'
--
-- which reached the browser as "internal error" and stopped the import dead.
-- That is a venue unable to open its doors because a different venue, which it
-- has never heard of, sells lemonade.
--
-- schema_department_tenancy.sql added an index on `email` for lookups but left
-- these two constraints in place, so the tenancy work was only half done.
--
-- THE FIX
--
-- The name is unique within a venue, which is what was always meant: two
-- departments called "Drinks" in one venue is a catalogue nobody can read, and
-- two in different venues is a Tuesday.
--
-- RE-RUNNABLE. Every deploy replays every file here and swallows failures, so
-- each step checks the catalogue first rather than relying on an error.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Drop an index, if it is there
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_drop_index;
DELIMITER //
CREATE PROCEDURE vesopa_drop_index(IN tbl VARCHAR(64), IN idx VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = tbl
       AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('DROP INDEX `', idx, '` ON `', tbl, '`');
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Add a unique index, if it is not
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_unique;
DELIMITER //
CREATE PROCEDURE vesopa_add_unique(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = tbl
       AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('CREATE UNIQUE INDEX `', idx, '` ON `', tbl, '` (', cols, ')');
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Sub departments
-- ---------------------------------------------------------------------------
--
-- The old index is named after its column, which is what MySQL does when a
-- UNIQUE is declared inline. Dropped first: leaving it would keep the fault
-- exactly as it is, since the narrower constraint is the one that refuses.
CALL vesopa_drop_index('bo_product_groups', 'group_name');
CALL vesopa_add_unique(
  'bo_product_groups', 'uq_bo_groups_venue_name', '`email`, `group_name`');

-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------
CALL vesopa_drop_index('bo_product_departments', 'department_name');
CALL vesopa_add_unique(
  'bo_product_departments',
  'uq_bo_departments_venue_name',
  '`email`, `department_name`');

-- ---------------------------------------------------------------------------
-- Products: a PLU is unique within a venue, and was not enforced at all
-- ---------------------------------------------------------------------------
--
-- Found while auditing the rest of the schema for the same class of fault.
-- `bo_products` had no unique key beyond its own id, so two rows with the same
-- (email, pluid) were possible — and a PLU is precisely how a till asks for a
-- product, so a second row for one is a product the till cannot resolve and a
-- sale that rings up the wrong thing.
--
-- It has been held off by application logic alone: the importer keeps a map so
-- that a repeated PLU in one file updates rather than inserts. That is one code
-- path among several that can write here, and the database was not backing it
-- up.
--
-- Safe to add: checked on the live data first — 124 products, no NULL or zero
-- PLUs, and no duplicate pair anywhere.
CALL vesopa_add_unique(
  'bo_products', 'uq_bo_products_venue_plu', '`email`, `pluid`');

DROP PROCEDURE IF EXISTS vesopa_drop_index;
DROP PROCEDURE IF EXISTS vesopa_add_unique;
