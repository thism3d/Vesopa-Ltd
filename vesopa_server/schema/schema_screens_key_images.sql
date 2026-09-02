-- How a picture sits on a programmed key, and whether the key's name is drawn
-- over it.
--
-- The problem this solves: a venue lays its screen out in whatever sizes suit
-- it — a 2x2 for the house burger, a 1x3 strip for the wine list — and one
-- photograph has to look right in all of them. Until now a picture was drawn
-- one way and one way only, so a tall bottle shot on a wide key was a label of
-- glass with the bottle cropped out of frame, and there was nothing anybody
-- could do about it from the back office.
--
-- Non-destructive, and that is the point. The uploaded file is left exactly as
-- it is and these four numbers say how to *look* at it, so the same picture can
-- be framed differently on two keys — the FOOD key on the home page and the
-- same product on the burgers page — without a second upload and without the
-- product catalogue changing underneath either of them.
--
-- The model, which public/screens.js and vesopa_epos both implement and must
-- keep implementing identically:
--
--   1. lay the picture into the key with `cover` (fill it, crop the overflow)
--      or `contain` (fit the whole picture inside it);
--   2. scale that by image_scale about the key's centre;
--   3. shift it by image_x / image_y, as a percentage of the key's own width
--      and height.
--
-- Which is exactly `object-fit` plus `transform: translate(x%, y%) scale(s)` in
-- the browser, and BoxFit plus Transform.translate/Transform.scale on the till.
-- Two implementations of one arithmetic; keeping them in that order is what
-- stops the editor's preview lying about what a clerk will see.
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

-- 'cover' or 'contain'. Stored as a string rather than a flag because there is
-- a third answer coming the first time somebody asks for a picture that tiles
-- or sits at its own size, and a boolean called `image_contain` would have to
-- be migrated to make room for it.
--
-- NULL means cover, which is what every key drew before this column existed.
CALL vesopa_add_column('epos_screen_buttons', 'image_fit', 'VARCHAR(12) NULL');

-- Percent, so this is an integer column and not a float: 100 is the picture
-- laid in exactly as the fit says, 250 is two and a half times that. Bounded
-- 20..400 by the server. A float here would round differently in MySQL, in
-- JSON and in Dart, and a picture that drifts by a pixel every save is a bug
-- report nobody can reproduce.
CALL vesopa_add_column(
  'epos_screen_buttons', 'image_scale', 'SMALLINT UNSIGNED NULL');

-- Percent of the key's own width and height, signed, -100..100. Zero is
-- centred, which is where everything already is.
CALL vesopa_add_column('epos_screen_buttons', 'image_x', 'SMALLINT NULL');
CALL vesopa_add_column('epos_screen_buttons', 'image_y', 'SMALLINT NULL');

-- Whether the key's name is drawn as well as its picture.
--
-- Nought — the picture on its own — is the default, and it is deliberately the
-- default for keys that already exist: "if there is an image on the button the
-- button doesn't show the product name, just the image" is what was asked for,
-- and a picture of a burger is a better burger key than the word BURGER over a
-- sliver of one. A venue that wants the name back ticks it on, per key, which
-- is the case this column exists to carry.
CALL vesopa_add_column(
  'epos_screen_buttons', 'show_label', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
