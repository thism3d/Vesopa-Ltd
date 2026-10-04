-- Memberships on Vesopa Express (2026-10-04): joining and renewing at the kiosk.
--
-- A membership bought at the kiosk is an ordinary kiosk order with one line
-- ("Membership: Gold renewal"), priced by the server and paid on the card
-- machine like any other. What the order is FOR is kept on the order itself,
-- so the paid transition (finalise() in src/express_kiosk.js) can apply it in
-- the same transaction that writes the sale -- and only then.
--
--   membership_json        what to apply once the money is in: join or renew,
--                          the plan, the customer (or the new member's name and
--                          contact details), the amount; and afterwards what
--                          happened. NULL on every food order.
--   membership_applied_at  set in the same statement that claims the order for
--                          applying, guarded by IS NULL, so a webhook and a
--                          poll arriving together renew once, never twice.
--
-- Both nullable, so every kiosk order before this reads exactly as it did.
--
-- SORT ORDER: deploy.sh applies schema_*.sql sorted by name, and this file
-- sorts BEFORE schema_till_express.sql, which creates epos_express_orders. On
-- an existing database the table is already there and this applies at once.
-- On a brand-new database the guard below skips a table that does not exist
-- yet (rather than failing), and the next `deploy.sh --schema` adds the
-- columns -- the kiosk refuses membership orders until it has.
--
-- MySQL 5.7 has no ADD COLUMN IF NOT EXISTS, so this goes through the guard
-- procedure every other schema file uses. Safe to re-run.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
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

CALL vesopa_add_column('epos_express_orders', 'membership_json', 'TEXT NULL');
CALL vesopa_add_column('epos_express_orders', 'membership_applied_at', 'DATETIME NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
