-- Explicit display order for the programming tables the back office lets you
-- drag to reorder. bo_finalise_keys already has sort_order; the rest gain one
-- here. Seeded from the current id order so existing rows keep their order the
-- first time the screen loads.
--
-- Guarded per table, and this file is why the guard matters most. Six ALTERs
-- followed by six backfills: on a database that already had the first column,
-- the file stopped on line one and the other five tables were left with no
-- sort_order and no backfill — drag-to-reorder quietly broken on five
-- programming pages, on a database that had "run all the migrations".
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

CALL vesopa_add_column('bo_tax_rates', 'sort_order', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_error_reasons', 'sort_order', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_vouchers', 'sort_order', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_mix_match', 'sort_order', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_product_departments', 'sort_order', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_product_groups', 'sort_order', 'INT NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- Seed each row's order from its id so nothing jumps around on first paint.
UPDATE bo_tax_rates           SET sort_order = id WHERE sort_order = 0;
UPDATE bo_error_reasons       SET sort_order = id WHERE sort_order = 0;
UPDATE bo_vouchers            SET sort_order = id WHERE sort_order = 0;
UPDATE bo_mix_match           SET sort_order = id WHERE sort_order = 0;
UPDATE bo_product_departments SET sort_order = id WHERE sort_order = 0;
UPDATE bo_product_groups      SET sort_order = id WHERE sort_order = 0;
