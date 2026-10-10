-- ===========================================================================
-- Dine-in: orders for collection, placed from a venue's own website.
-- ===========================================================================
--
-- Pontardawe RFC (2026-10-10): "Dine in and online orders, menu and connected
-- with Vesopa EPOS" on pontardawerfc.com. Dine-in already orders to a table.
-- Somebody at home has no table, so until now the venue address
-- (/api/public/dinein/venue/:slug) showed the menu and took nothing.
--
-- `collection_open` lets a venue take those orders too: name and phone, no
-- table, paid at the bar when collected. The order is written into
-- dinein_orders with no table exactly as a Vesopa Express "pay at the counter"
-- order is (src/express_kiosk.js, sendToCounter), so every till that already
-- accepts a kiosk order accepts this one. No till release is needed.
--
-- Off by default: a venue that has published a menu has not thereby agreed
-- to cook for people who are not in the building.
--
-- SORT ORDER. Alters dinein_venue, which schema_menu_dinein.sql creates;
-- "_c" sorts after "." so this runs after it. RE-RUNNABLE.
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

CALL vesopa_add_column('dinein_venue', 'collection_open', 'TINYINT(1) NOT NULL DEFAULT 0');
-- Minutes from ordering to ready, shown to the customer. NULL: eta_minutes.
CALL vesopa_add_column('dinein_venue', 'collection_minutes', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
