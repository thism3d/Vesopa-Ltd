-- Manual card without Dojo (2026-10-12).
--
-- Nicki Tidbell, Pontardawe going live: "the manual card button needs to take
-- card payment without going through dojo". By default the till's Manual card
-- key now records a card payment taken on a separate card machine: the amount
-- keyed is saved as card, nothing is sent to Dojo. This switch puts it back on
-- Dojo's keyed card payment for a venue that wants that.
--
--   epos_tender_settings.allow_manual_dojo   Manual card goes through Dojo

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

CALL vesopa_add_column('epos_tender_settings', 'allow_manual_dojo', 'TINYINT(1) NOT NULL DEFAULT 0');

-- 2026-10-26, Nicki: "when they click manual card can we remove this
-- confirmation box". Manual card on a separate machine saves at once; this
-- switch brings the confirmation back. Off for every venue.
CALL vesopa_add_column('epos_tender_settings', 'allow_manual_confirm', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
