-- An emoji and/or an uploaded image per product, shown on the till button.
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

CALL vesopa_add_column('bo_products', 'emoji', 'VARCHAR(16) NULL');
CALL vesopa_add_column('bo_products', 'image_url', 'VARCHAR(500) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
