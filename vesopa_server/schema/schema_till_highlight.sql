-- Page highlight (2026-10-01): the navigation key for the page a till is on
-- lights up by itself, in a style the venue chooses in screen programming.
--
-- Named schema_till_*.sql so it sorts after schema_staff_idle.sql, which is
-- where epos_till_settings is created (see schema_till_screens.sql for why
-- that matters). epos_screen_buttons exists by then too.
--
-- Every column is NULL by default, and NULL means the Vesopa default: a white
-- key with a lime bar along its foot. A till older than EPOS 1.11 ignores all
-- of them and keeps its thin lime outline.
--
-- MySQL 5.7 has no ADD COLUMN IF NOT EXISTS, so this goes through a guard
-- procedure. Safe to re-run.

DROP PROCEDURE IF EXISTS vesopa_add_highlight_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_highlight_column(
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

-- The venue's choice. Style: fill | bar | outline | off.
CALL vesopa_add_highlight_column('epos_till_settings', 'nav_here_style', 'VARCHAR(8) NULL');
-- #rrggbb. The key's colour while its page is open (style = fill).
CALL vesopa_add_highlight_column('epos_till_settings', 'nav_here_fill', 'VARCHAR(7) NULL');
-- 'brand' (Vesopa lime), 'key' (each key's own colour) or #rrggbb.
CALL vesopa_add_highlight_column('epos_till_settings', 'nav_here_bar', 'VARCHAR(7) NULL');

-- One navigation key's own highlight, over the venue's. Same values as above;
-- NULL follows the venue.
CALL vesopa_add_highlight_column('epos_screen_buttons', 'here_fill', 'VARCHAR(7) NULL');
CALL vesopa_add_highlight_column('epos_screen_buttons', 'here_bar', 'VARCHAR(7) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_highlight_column;
