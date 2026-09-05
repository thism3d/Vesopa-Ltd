-- Item-level voids.
--
-- The till used to void a whole sale, so "£12.40, wrong item rung up" told the
-- manager everything there was to know. It now voids selected lines, and an
-- amount on its own stops being an audit trail: two voids of £4.50 could be a
-- mis-keyed coffee or a bottle of wine walking out of the door.
--
-- `items` is a short human summary written by the till ("2x Flat White,
-- 1x Brownie"); `scope` distinguishes a part-void from cancelling the check.
--
-- Each column is added on its own and only if it is absent, because
-- deploy.sh --schema re-runs every migration and promises that is safe. As one
-- multi-column ALTER this aborted on the first column that already existed and
-- rolled the rest back with it — so a half-migrated database stayed half
-- migrated for ever. See schema_order_cols.sql for what that cost.
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

CALL vesopa_add_column('epos_void_log', 'items', 'VARCHAR(500) NULL AFTER reason');
CALL vesopa_add_column('epos_void_log', 'scope',
  'VARCHAR(16) NOT NULL DEFAULT ''sale'' AFTER items');

DROP PROCEDURE IF EXISTS vesopa_add_column;
