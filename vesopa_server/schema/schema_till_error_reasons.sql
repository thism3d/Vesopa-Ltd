-- A reason for each thing that needs explaining, not one list shared by two.
--
-- "In Error Reasons, Can we have reasons for No Sale, Refunds, Voids and
-- Cancel (Void and Cancel is already done just need to split them off."
--
-- `bo_error_reasons.applies_to` has existed since `schema_layout.sql` and the
-- back office already offers three values — void, refund, discount. What was
-- missing is the two the venue names: **no_sale**, which nothing captured at
-- all, and **cancel**, which the till has been borrowing the void list for.
-- Borrowing is why they asked: "rung up in error" explains a line taken off a
-- bill and says nothing about why a whole check was abandoned, and a manager
-- reading the Z report cannot tell the two apart.
--
-- WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT
--
-- It seeds. It does not migrate: every existing void, refund and discount row
-- is left exactly where it is, because they are the venue's own words and this
-- is not the place to reword them.
--
--   * Cancel starts as a COPY of that office's void reasons. An empty list on
--     upgrade morning would mean a clerk cancelling a check is asked for a
--     reason and offered none — which on this till is a dialog that will not
--     let them past. Copying gives every venue a working list on day one and
--     leaves them free to edit it into something sharper, which is what
--     "split them off" means.
--   * No Sale gets two defaults, because no venue has ever had any.
--
-- ---------------------------------------------------------------------------
-- Per office, and after the tenancy migration
-- ---------------------------------------------------------------------------
-- Rows are seeded against each office rather than as unowned rows, and this
-- file is named to sort AFTER `schema_tenant_programming.sql`:
--
--     schema_layout.sql              'la'  <- creates bo_error_reasons
--     schema_tenant_programming.sql  'te'  <- copies unowned rows out, per office,
--                                             then DELETEs the unowned originals
--     schema_till_error_reasons.sql  'ti'  <- this file
--
-- Seeding with `office_id NULL` would work by accident on the deploy that ran
-- both, and then be a trap: this file would re-seed the unowned row on the
-- next deploy, the tenancy file would copy it out again, and a venue that
-- deleted a reason it did not want would find it back every time anybody
-- deployed. That is the exact fault the venue reported — the same reasons
-- listed over and over — and the reason `schema_layout.sql` now guards its own
-- seeds. So: owned rows, guarded on what that office already has.
--
-- Safe to re-run: every insert is `INSERT ... SELECT ... WHERE NOT EXISTS`,
-- and a venue that deletes a seeded reason keeps it deleted, because the guard
-- is per office and per action rather than per row.
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- `sort_order` is read by /till/void-reasons and has been on the live table
-- for some time; declared here so a database restored from an older dump gets
-- it rather than failing the ORDER BY.
CALL vesopa_add_column(
  'bo_error_reasons', 'sort_order', 'INT NOT NULL DEFAULT 0');

-- The index the till's read actually uses. Every /till/error-reasons request
-- is (office, action), and without this it is a scan of the whole table for
-- every void dialog on the platform.
--
-- Guarded the same way the columns are: MariaDB has no CREATE INDEX IF NOT
-- EXISTS that is safe to lean on across versions, and this file runs on every
-- deploy.
DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD ', spec);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index('bo_error_reasons', 'ix_error_reasons_office_action',
  'INDEX ix_error_reasons_office_action (office_id, applies_to)');

-- ---------------------------------------------------------------------------
-- Cancel: a copy of each office's void reasons, once
-- ---------------------------------------------------------------------------
-- Guarded on the office having NO cancel rows at all, not on each row being
-- absent. A venue that trims its cancel list down to two must keep it at two;
-- a per-row guard would put the other five back on the next deploy.
INSERT INTO bo_error_reasons (office_id, reason, applies_to, sort_order)
SELECT v.office_id, v.reason, 'cancel', v.sort_order
  FROM bo_error_reasons v
 WHERE v.applies_to = 'void'
   AND v.office_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM bo_error_reasons c
      WHERE c.office_id = v.office_id
        AND c.applies_to = 'cancel'
   );

-- ---------------------------------------------------------------------------
-- No Sale: two defaults per office, once
-- ---------------------------------------------------------------------------
-- The two reasons a drawer is opened with nothing to sell. Same guard, same
-- reason: a venue that deletes one keeps it deleted.
--
-- CROSS JOIN against `offices` rather than against the reasons table, because
-- an office may have no reasons of any kind and still needs these.
INSERT INTO bo_error_reasons (office_id, reason, applies_to, sort_order)
SELECT o.id, seed.reason, 'no_sale', seed.sort_order
  FROM offices o
 CROSS JOIN (
       SELECT 'Change for a customer' AS reason, 1 AS sort_order
 UNION ALL SELECT 'Opened in error', 2
 ) AS seed
 WHERE NOT EXISTS (
   SELECT 1 FROM bo_error_reasons n
    WHERE n.office_id = o.id
      AND n.applies_to = 'no_sale'
 );

DROP PROCEDURE IF EXISTS vesopa_add_index;
DROP PROCEDURE IF EXISTS vesopa_add_column;
