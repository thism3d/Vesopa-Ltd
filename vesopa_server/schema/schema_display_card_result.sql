-- ---------------------------------------------------------------------------
-- Whether the customer display shows the card payment's result (2026-10-15)
-- ---------------------------------------------------------------------------
--
-- Nicki at Pontardawe RFC: a big red "Payment declined" on the screen facing
-- the queue is embarrassing for the customer -- "or a setting to turn on and
-- off". On (1) shows the card's progress and a neutral result on the customer
-- display; off (0) leaves the bill on screen and keeps the card's outcome
-- between the clerk and the customer.

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

CALL vesopa_add_column('epos_tender_settings', 'allow_display_card_result', 'TINYINT(1) NOT NULL DEFAULT 1');

DROP PROCEDURE IF EXISTS vesopa_add_column;
