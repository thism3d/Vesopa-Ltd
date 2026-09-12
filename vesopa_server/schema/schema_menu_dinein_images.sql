-- Where a dish's picture comes from: Products, or this menu's own.
--
-- A venue could set a picture on a product in Products and find the dish still
-- blank on menu.vesopaepos.com and on a Vesopa Express kiosk, because the two
-- were separate pictures and only one of them was ever read:
--
--   bo_products.image_url   the product's own picture  (back office, till)
--   dinein_items.image_url  the menu item's picture    (QR menu, Express)
--
-- `menuSections` read `dinein_items.image_url` and nothing else, so a venue had
-- to set every picture twice and got no image at all if they only set it once.
-- The meal builder already did the sensible thing (product first, then the
-- menu's, then by name -- see `mealsFor`), which is the shape copied here.
--
-- ---------------------------------------------------------------------------
-- Why a setting and not simply "product wins"
-- ---------------------------------------------------------------------------
-- Both pictures are legitimate and they are not the same picture. A product's
-- picture is the thing on a shelf; a menu item's is the plate as it is served,
-- often shot for the menu. A venue that has carefully photographed its menu
-- must not have it replaced by a stock product shot on upgrade.
--
-- So it is a choice, venue-wide, and it is 'menu' by default -- which is what
-- every venue has today.
--
--   'menu'     the menu's own picture, falling back to the product's
--   'product'  the product's picture, falling back to the menu's
--
-- EITHER WAY IT FALLS BACK, and that is the part that fixes the complaint. A
-- dish that is blank today because the picture was only ever set in Products
-- starts showing it, without anybody finding this setting. Nobody loses a
-- picture they chose; a dish only changes if it had none.
--
-- It is one setting for the QR menu AND the kiosk on purpose: they are the same
-- menu, read on two screens, and `menuSections` serves both. A venue told that
-- a dish has a picture should not have to ask which screen.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- Files apply in filename sort order on every deploy, and `dinein_venue` is
-- created by `schema_menu_dinein.sql`. "." sorts before "_", so this lands
-- after the table exists:
--
--     schema_menu_dinein.sql              <- creates dinein_venue
--     schema_menu_dinein_auto_accept.sql
--     schema_menu_dinein_hours.sql
--     schema_menu_dinein_images.sql       <- this file
--
-- Safe to re-run.
--
-- The procedure is defined here rather than assumed: the file before this one
-- drops it on its way out, so a migration that does not define its own guard
-- fails on a deploy that runs them all in order.
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

-- VARCHAR rather than ENUM: a third source (a supplier's images, say) is a row
-- of code and a new value here, where an ENUM would be an ALTER on a live table.
CALL vesopa_add_column(
  'dinein_venue', 'image_source', "VARCHAR(16) NOT NULL DEFAULT 'menu'");

DROP PROCEDURE IF EXISTS vesopa_add_column;
