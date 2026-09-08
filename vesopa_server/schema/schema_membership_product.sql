-- Which product a membership fee is rung up as.
--
-- Split out from `schema_membership.sql` rather than added to it because that
-- file has already been applied to the live database, and a migration folder
-- where an applied file changes is a folder nobody can reason about: the guard
-- makes re-running safe, it does not make an edited file re-apply.
--
-- WHY A PRODUCT AND NOT JUST AN AMOUNT
--
-- Taking £10 at the till is not the hard part. Saying what the £10 *is* is: a
-- membership fee has a VAT treatment, a department, and a place in the Z
-- report, and none of those can be guessed from a number. A venue that points
-- this at a product it has already set up gets all three right; a venue that
-- leaves it blank gets a plain line at the configured fee and no VAT, which is
-- stated on the form rather than assumed.
--
-- Sorts after `schema_membership.sql` — same prefix, longer name — so the
-- settings row exists by the time this runs. Re-runnable, like everything
-- here: the deploy applies every file every time.
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

-- Nullable, and NOT a foreign key: `bo_products.pluid` is not unique across
-- the platform — it is unique per venue — so a constraint here would be
-- pointing at the wrong thing. The till resolves it against its own catalogue,
-- which is already scoped to the venue.
CALL vesopa_add_column(
  'epos_loyalty_settings', 'membership_plu', 'INT NULL');
