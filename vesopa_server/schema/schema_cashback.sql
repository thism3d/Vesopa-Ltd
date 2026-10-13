-- The till's Cashback key (2026-10-13).
--
-- Nicki Tidbell, Pontardawe RFC: "are we able to offer cashback integrated to
-- dojo?" Card stays the default and goes straight to the card machine; a venue
-- that offers cashback turns this on to get a Cashback key beside it, which
-- asks how much and sends it to the machine with the sale. Off by default.
--
--   epos_tender_settings.allow_cashback   show the Cashback key on the till

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

CALL vesopa_add_column('epos_tender_settings', 'allow_cashback', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
