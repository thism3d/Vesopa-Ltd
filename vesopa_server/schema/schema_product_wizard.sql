-- The step-by-step product form (2026-10-01).
--
-- "When creating a product can we copy Newbridge where it is in stages."
-- The stages carry a few things a product could not hold before:
--
--   short_description  a one-line subtitle, for the kiosk, QR menu and labels
--   description        the Information step: formatted text, cleaned on the
--                      server to a small set of tags (src/product_info.js)
--   calories           kcal per portion, NULL when nobody has said
--   may_contain        "may contain traces of", the same 14 codes as allergens
--                      and the same NULL / '[]' rule
--   dietary            vegetarian, vegan, gluten free, dairy free, halal
--   is_weighted        sold by weight: the price is per kg and the till asks
--                      for the weight when it is rung
--   manual_weight      the weight is typed rather than read from a scale
--
-- supplier_code, min_stock and max_stock already exist (schema_stock.sql).
-- Every column is nullable or defaulted, so a till or an import that knows
-- nothing about them keeps working.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN t VARCHAR(64), IN c VARCHAR(64), IN spec VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD COLUMN `', c, '` ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_column('bo_products', 'short_description', 'VARCHAR(160) NULL');
CALL vesopa_add_column('bo_products', 'description', 'TEXT NULL');
CALL vesopa_add_column('bo_products', 'calories', 'INT NULL');
CALL vesopa_add_column('bo_products', 'may_contain', 'TEXT NULL');
CALL vesopa_add_column('bo_products', 'dietary', 'TEXT NULL');
CALL vesopa_add_column('bo_products', 'is_weighted', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_products', 'manual_weight', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
