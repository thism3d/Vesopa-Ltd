-- Pictures on category buttons.
--
-- Products have had `emoji` / `image_url` since schema_product_media.sql; the
-- departments that drive the till's right-hand category rail never did, so a
-- category could only ever be a word. A clerk finds "Coffee" by its picture far
-- faster than by reading a column of similar-length words mid-service.
--
-- `button_color` lets the office override the till's built-in per-category
-- colour, which until now was hardcoded by name and so only worked for the
-- handful of names the till happened to know.
-- `emoji` is explicitly utf8mb4. The table's own default is 3-byte utf8, which
-- cannot hold an emoji at all — MySQL rejects the write with
-- ER_TRUNCATED_WRONG_VALUE_FOR_FIELD rather than storing it. bo_products.emoji
-- is already utf8mb4 for the same reason; this matches it.
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

CALL vesopa_add_column('bo_product_departments', 'emoji',
  'VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL');
CALL vesopa_add_column('bo_product_departments', 'image_url', 'VARCHAR(500) NULL');
CALL vesopa_add_column('bo_product_departments', 'button_color', 'VARCHAR(16) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
