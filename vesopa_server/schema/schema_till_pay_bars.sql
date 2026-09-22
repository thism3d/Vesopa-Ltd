-- The bars a venue's payment screen wears.
--
-- The sale screen has had programmable top and bottom bars since
-- schema_till_bars.sql. The payment screen has had neither, and it is the screen
-- a clerk is standing at when a customer is waiting — so the keys they reach for
-- most were the ones that were not there.
--
-- Two more columns on the same row, and deliberately *separate* from the sale
-- screen's pair rather than reusing it. A venue's sale bar carries Void, Save
-- Table and Covers; none of those mean anything once the bill is being settled,
-- and a bar that offered them on the payment screen would be a bar of keys that
-- do nothing. The two screens are different jobs and want different chrome.
--
-- NULL means the payment screen's built-in arrangement, which is what every
-- venue that never opens this page keeps having, and what a venue gets back the
-- moment it deletes the bar it programmed. That default is not a placeholder.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- deploy.sh applies schema_*.sql in `sort` order:
--
--     schema_screens.sql        'sc'
--     schema_screens_bars.sql   'sc'
--     schema_staff_idle.sql     'st'  <- epos_till_settings created HERE
--     schema_till_bars.sql      'ti'
--     schema_till_pay_bars.sql  'ti'  <- this file
--
-- So this cannot live in schema_screens_bars.sql, where it would otherwise
-- belong: that file runs before the table exists, and an ALTER there fails on a
-- fresh database while succeeding on every server that already had one — green
-- in testing, discovered by the first new venue. That is the same trap
-- schema_till_bars.sql was split out to avoid, and its header documents the
-- venue that lost its printer names to it.
--
-- No foreign keys, deliberately, for the reason given in schema_till_screens.sql
-- and honoured by the delete path in src/screens.js: a bar deleted in the back
-- office must leave the till falling back to its built-in bar, rather than
-- either refusing the delete or cascading a page away.
--
-- MySQL 5.7 / MariaDB have no ADD COLUMN IF NOT EXISTS, so this goes through the
-- usual information_schema guard and is safe to run on every deploy.

DROP PROCEDURE IF EXISTS vesopa_add_pay_bar_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_pay_bar_column(
  IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'epos_till_settings'
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `epos_till_settings` ADD COLUMN `', col,
                    '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_pay_bar_column('pay_top_bar_screen_id', 'INT NULL');
CALL vesopa_add_pay_bar_column('pay_bottom_bar_screen_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_pay_bar_column;
