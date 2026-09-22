-- ===========================================================================
-- Stock: non-stock items, linked products, recipes, and a target GP.
-- ===========================================================================
--
-- Asked for by the venue that came off Newbridge (2026-09-22), each one a
-- thing Newbridge did:
--
--   * bo_products.non_stock        -- "we don't want all products showing on
--                                     the stocktake". A product marked non-stock
--                                     is never counted; a stocktake offers only
--                                     products with a case size (pack size) that
--                                     are not marked non-stock.
--   * bo_products.stock_parent_pluid / stock_ratio
--                                  -- linked products: a half pint sells 0.5 of
--                                     the pint, a 175ml glass sells 175/750 of
--                                     the bottle. Selling or wasting the child
--                                     moves the PARENT's stock by quantity x
--                                     ratio; the child itself is never counted.
--   * bo_recipe_lines              -- a cocktail made of other products. Selling
--                                     or wasting it moves each ingredient by its
--                                     quantity. Its unit cost is the recipe's.
--   * bo_products.target_gp        -- the GP% the calculator recommends a price
--                                     for. Per product; blank uses the default.
--
-- SORT ORDER. Runs after schema_stock.sql ('.' < '_'), which adds the stock
-- columns to bo_products this builds on.
--
-- RE-RUNNABLE, like every file here: IF NOT EXISTS and vesopa_add_column,
-- defined here and dropped at the end.
-- ===========================================================================

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

CALL vesopa_add_column('bo_products', 'non_stock',          'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_products', 'stock_parent_pluid', 'INT NULL');
CALL vesopa_add_column('bo_products', 'stock_ratio',        'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'target_gp',          'DOUBLE NULL');

-- ---------------------------------------------------------------------------
-- Recipes: one row per ingredient of a product that is made of others.
-- Keyed by PLU within the venue, like the stock documents: `pluid` is unique
-- inside an office and not across the platform.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bo_recipe_lines (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  office           VARCHAR(190) NOT NULL,
  recipe_pluid     INT          NOT NULL,
  ingredient_pluid INT          NOT NULL,
  quantity         DOUBLE       NOT NULL,
  sort_order       INT          NOT NULL DEFAULT 0,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recipe_line (office, recipe_pluid, ingredient_pluid),
  INDEX idx_recipe_lines_recipe (office, recipe_pluid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS vesopa_add_column;
