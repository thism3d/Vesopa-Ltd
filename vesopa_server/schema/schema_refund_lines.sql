-- Refunds joined to the sale they came off (EPOS 1.17, 2026-10-12).
--
-- "Why can I refund the same order again and again?" A refund off a receipt
-- was a till event with the receipt id inside its note and nothing else, so
-- neither the till nor the back office could tell a bill had been refunded.
-- epos_till_events.order_id has been there since schema_till_events.sql and
-- the till never filled it; from 1.17 it does, with the receipt lines that
-- went back:
--
--   epos_till_events.line_nos   "0,1,4": positions on the receipt, the same
--                               index the refund screen picks by
--   idx_till_events_order       for the receipt list's per-bill lookup
--
-- RE-RUNNABLE. Every deploy replays every file here.

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

CALL vesopa_add_column('epos_till_events', 'line_nos', 'VARCHAR(255) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(IN t VARCHAR(64), IN i VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND INDEX_NAME = i
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD INDEX `', i, '` ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index('epos_till_events', 'idx_till_events_order', '(office, order_id)');

DROP PROCEDURE IF EXISTS vesopa_add_index;
