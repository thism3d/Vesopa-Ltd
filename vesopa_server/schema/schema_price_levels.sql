-- Six prices per product.
--
-- "Each product should have 6 price levels. Price 1, Price 2 etc. This can be
-- used for a loyalty scheme or a setting on the till in functions to swap price
-- levels."
--
-- WHY THE EXISTING COLUMN IS LEVEL ONE
--
-- `bo_products.price` stays exactly where it is and becomes Price 1. Renaming
-- it would mean touching the till's sync, the import, the screen editor, three
-- reports and every venue's data in one migration — to gain nothing, because
-- the first of six prices is the price a venue has always had.
--
-- WHY THE OTHER FIVE ARE NULL AND NOT ZERO
--
-- NULL means "this level is not set for this product, use Price 1". A default
-- of 0 would mean a venue that switched the till to Price 2 started giving
-- everything away — and it would do it silently, at the counter, on every
-- product nobody had got round to filling in.
--
-- So an unset level is not a price of nothing; it is the absence of a special
-- price, and the till falls back. A venue can put a happy-hour price on the six
-- drinks it applies to and leave the other four hundred products alone.
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

CALL vesopa_add_column('bo_products', 'price_2', 'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'price_3', 'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'price_4', 'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'price_5', 'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'price_6', 'DOUBLE NULL');

-- What each level is called at this venue.
--
-- A venue's second price is "Happy Hour" or "Staff" or "Function Room", and a
-- till key labelled "Price 2" tells a clerk nothing. One row per office holding
-- five names; Price 1 is always "Price 1" and needs no row.
CALL vesopa_add_column('epos_till_settings', 'price_level_names', 'VARCHAR(500) NULL');

-- Which level a member of this tier is charged at.
--
-- The other half of what was asked for — "used for a loyalty scheme". NULL is
-- the ordinary answer and means the till's current level, whatever it is; a
-- tier with a level set overrides it for that customer's bill only.
CALL vesopa_add_column('epos_loyalty_tiers', 'price_level', 'TINYINT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- The till reads every level in one go with the rest of the catalogue, so there
-- is no new index: these are columns on a row it was already fetching.
