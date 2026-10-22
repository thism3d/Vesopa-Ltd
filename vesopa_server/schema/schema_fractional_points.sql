-- ---------------------------------------------------------------------------
-- Points to 5 decimal places (2026-10-22, Meirion / Newbridge).
--
-- A whole point could only ever be worth a fixed number of pence, so a
-- redemption could not clear the exact price of a product -- a £4.10 item at
-- 7p a point left 6p to find. Carrying points to five decimals lets a
-- redemption clear any price exactly, and leaves the fractional remainder on
-- the card (e.g. 123.45660), as Newbridge does.
--
-- Widening INT to DECIMAL is lossless: every existing whole balance is kept.
-- Re-runnable: MODIFY to the same type is a no-op.
-- ---------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS vesopa_modify_column;
DELIMITER //
CREATE PROCEDURE vesopa_modify_column(
  IN t VARCHAR(64), IN c VARCHAR(64), IN spec VARCHAR(255)
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` MODIFY COLUMN `', c, '` ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_modify_column('epos_customers',    'points_balance', 'DECIMAL(16,5) NOT NULL DEFAULT 0');
CALL vesopa_modify_column('epos_loyalty_txns', 'points',         'DECIMAL(16,5) NOT NULL');
CALL vesopa_modify_column('epos_loyalty_txns', 'balance_after',  'DECIMAL(16,5) NOT NULL');
CALL vesopa_modify_column('epos_orders',       'points_earned',  'DECIMAL(16,5) NOT NULL DEFAULT 0');
CALL vesopa_modify_column('epos_orders',       'points_balance', 'DECIMAL(16,5) NULL');
CALL vesopa_modify_column('epos_orders',       'points_redeemed','DECIMAL(16,5) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_modify_column;
