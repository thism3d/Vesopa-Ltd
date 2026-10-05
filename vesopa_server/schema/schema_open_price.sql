-- Open price products and paying an empty check (2026-10-05).
--
-- Nicki Tidbell: "A product setting to enable price input box. For example
-- Open Food, a box pops up asking how much to sell for and staff will leave a
-- note for what it's for." And: "Ability to go to the payment screen even if
-- there is nothing in the check view."
--
--   bo_products.open_price         the till asks what to charge when it is rung
--   bo_products.open_price_note    and asks what it was for (kept on the line)
--   epos_tender_settings.allow_empty_pay
--                                  Pay opens the payment screen on an empty
--                                  check; an amount keyed there is rung up as
--                                  a "Quick sale" before it is taken
--
-- Every column is defaulted off, so nothing changes for a venue until it ticks
-- the box.

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

CALL vesopa_add_column('bo_products', 'open_price', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_products', 'open_price_note', 'TINYINT(1) NOT NULL DEFAULT 1');
CALL vesopa_add_column('epos_tender_settings', 'allow_empty_pay', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
