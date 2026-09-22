-- Which bars a venue's tills wear.
--
-- Two columns on the till-settings row, in a `schema_till_*.sql` file, and that
-- file name is the whole point of this comment.
--
-- `deploy.sh` applies schema_*.sql in `sort` order:
--
--     schema_screens.sql        'sc'
--     schema_screens_bars.sql   'sc'  <- the button and screen columns
--     schema_staff_idle.sql     'st'  <- epos_till_settings created HERE
--     schema_till_bars.sql      'ti'  <- this file
--
-- So schema_screens_bars.sql, where these two columns naturally belong, runs
-- BEFORE the table they go on exists. An ALTER there would fail with "table
-- doesn't exist" on a fresh database and succeed on every server that already
-- had one — green in testing, discovered by the first new venue. That is
-- exactly the failure documented in vesopa_epos_kitchen/docs/architecture.md
-- under "The migration rename", which cost a venue its printer names, and it is
-- the second time this feature has had to be split across two files to avoid
-- it. See the header of schema_screens.sql for the first.
--
-- Safe to re-run.

DROP PROCEDURE IF EXISTS vesopa_add_till_bar_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_till_bar_column(
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

-- NULL means the till's built-in bar: the live strip of open bills along the
-- top, and Void / Cancel / Save Table / … / Pay along the bottom. That default
-- is not a placeholder to be replaced later — it is what every venue that never
-- opens this page keeps having, for ever, and it is what a venue gets back the
-- moment it deletes the bar it programmed.
--
-- No foreign keys, deliberately: see schema_till_screens.sql.
CALL vesopa_add_till_bar_column('top_bar_screen_id', 'INT NULL');
CALL vesopa_add_till_bar_column('bottom_bar_screen_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_till_bar_column;
