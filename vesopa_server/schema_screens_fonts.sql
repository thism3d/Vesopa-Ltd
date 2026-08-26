-- Lettering on a programmed key: which font, and how big.
--
-- Both null on every button that exists today, and null means what it has
-- always meant — the till decides. That is not a placeholder: it is the right
-- answer for most keys, because the till already sizes a label to the space the
-- key actually has, and a venue that has never opened the font picker should
-- keep getting a label that fits rather than one clipped at a size somebody set
-- on a 1920x1080 monitor and never checked on a 10-inch terminal.
--
-- Sorts after schema_screens.sql ('.' < '_'), which is where epos_screen_buttons
-- is created — so the table this alters exists by the time this runs. See the
-- header of schema_till_screens.sql for the migration-ordering trap this is
-- avoiding, and what it cost the one time it was not avoided.
--
-- MySQL 5.7 has no ADD COLUMN IF NOT EXISTS, so this goes through the usual
-- information_schema guard. Safe to re-run on every deploy.

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
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- The slug of a built-in family or of a row in epos_fonts. No foreign key, for
-- the same reason home_screen_id has none: a font deleted in the back office
-- must leave this pointing at nothing and the till falling back to its default
-- lettering, not refuse the delete and not cascade a venue's keys blank.
CALL vesopa_add_column('epos_screen_buttons', 'font_family', 'VARCHAR(64) NULL');

-- Points, as the till measures them — a wish rather than a promise, which is
-- the only honest thing a fixed size can be on a grid that is laid out into
-- whatever space the terminal has. The same layout is drawn on a 15-inch
-- counter panel and on a handheld, so the till caps this against the height of
-- the key it is drawing: 28pt is handsome on one and taller than the whole key
-- on the other. A label too long for the width still ellipsises, exactly as it
-- did before this column existed.
CALL vesopa_add_column('epos_screen_buttons', 'font_size', 'TINYINT UNSIGNED NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
