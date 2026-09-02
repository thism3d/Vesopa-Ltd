-- Two things a venue kept having to decide at the counter, moved to a setting.
--
-- receipt_auto_print
--   The till used to ask "print receipt?" after every single sale. On a busy
--   counter that is a dialog between the clerk and the next customer, several
--   hundred times a day, and the answer is the same every time for any given
--   venue. So the venue answers it once here instead.
--
--   Defaults to 0 rather than 1. The prompt is gone either way, and a default
--   of 1 would mean every venue that upgrades quietly starts printing a
--   receipt for every sale — paper nobody asked for. A receipt is still always
--   reachable afterwards from the Receipts screen or the Last Bill key.
--
-- buttons_show_prices
--   Whether product buttons carry their price. On by default, which is the
--   behaviour every terminal has had until now, so upgrading changes nothing
--   unless the venue asks it to.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_column(
  'epos_till_settings', 'receipt_auto_print', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column(
  'epos_till_settings', 'buttons_show_prices', 'TINYINT(1) NOT NULL DEFAULT 1');

DROP PROCEDURE IF EXISTS vesopa_add_column;
