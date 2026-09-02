-- The font a venue's tills letter everything in.
--
-- One column on the till-settings row. Named `schema_till_*.sql` so it sorts
-- after schema_staff_idle.sql, which is where epos_till_settings is created —
-- see the header of schema_till_screens.sql for why that matters and what
-- ignoring it cost.
--
-- NULL means the app's own typeface, which is what every till has today.

DROP PROCEDURE IF EXISTS vesopa_add_till_font_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_till_font_column(
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

-- The slug of a built-in family or of a row in epos_fonts. A key with its own
-- font_family overrides this; a key without one inherits it.
CALL vesopa_add_till_font_column('font_family', 'VARCHAR(64) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_till_font_column;
