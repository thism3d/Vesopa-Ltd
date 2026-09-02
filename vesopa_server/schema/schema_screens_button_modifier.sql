-- A programmed key that asks a modifier question.
--
-- Until now a modifier group could only be reached by ringing up a product
-- that carried one. That covers "which mixer with that gin?" and misses the
-- thing a bar actually wants: a MIXERS key on the screen, or on the top bar,
-- that a clerk presses against whatever is already on the bill.
--
-- So `kind = 'modifier'` joins product / page / function / blank, and it points
-- at a row in `epos_modifier_groups` — which already owns a screen of answers
-- (see schema_screens_modifiers.sql), so there is nothing new to lay out and
-- nothing new to sync. The till opens the same prompt it opens for a product.
--
-- Deliberately no foreign key, for the same reason `plu_id` has none: a group
-- deleted in the back office must leave a key that says it is unavailable, not
-- silently take a row out of a venue's layout. The till and the editor both
-- render an unresolvable key as broken, and Needs Attention lists it.
--
-- Sorts after schema_screens.sql ('.' < '_'), which creates the table this
-- alters. See schema_screens_key_images.sql for the ordering trap.
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

-- kind = 'modifier'. Which question this key asks.
CALL vesopa_add_column(
  'epos_screen_buttons', 'modifier_group_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
