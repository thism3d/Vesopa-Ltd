-- ===========================================================================
-- The floor designer: colours, and a room drawn rather than chosen.
-- ===========================================================================
--
-- RE-RUNNABLE. Every deploy replays every file in this directory, in sorted
-- order, and swallows failures — so an unguarded ALTER does not fail loudly,
-- it silently stops adding the column and the feature quietly disappears on
-- the next deploy. Everything here goes through vesopa_add_column, which is a
-- no-op when the column is already there.
--
-- WHAT THIS ADDS
--
-- A venue lays out its own room and then wants it to look like its own room.
-- Until now every floor was the same grey and every table the same outline, so
-- the plan on the screen was a diagram of the building rather than a picture of
-- it — and a member of staff looking for table nine on a busy Friday is
-- pattern-matching against a picture.
--
--   floor_rooms.floor_colour   the carpet, behind everything
--   floor_rooms.wall_colour    the outline drawn around it
--   floor_tables.colour        one table, when it should stand out
--
-- All three are nullable and all three mean "use the theme's own colour" when
-- unset, so a venue that never opens the colour picker sees exactly what it
-- sees today.
-- ===========================================================================

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

-- ---------------------------------------------------------------------------
-- The room
-- ---------------------------------------------------------------------------
--
-- Stored as the seven characters a colour input produces — "#1A2B3C" — rather
-- than as three numbers. It is written by a colour picker and read straight
-- into CSS, and splitting it into components here would mean reassembling it
-- at both ends for no gain.
CALL vesopa_add_column('floor_rooms', 'floor_colour', 'VARCHAR(9) NULL');
CALL vesopa_add_column('floor_rooms', 'wall_colour',  'VARCHAR(9) NULL');

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('floor_tables', 'colour', 'VARCHAR(9) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
