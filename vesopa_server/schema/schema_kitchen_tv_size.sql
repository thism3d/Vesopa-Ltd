-- ---------------------------------------------------------------------------
-- Kitchen screens on big TVs (2026-10-17)
-- ---------------------------------------------------------------------------
--
-- Meirion: "Can we put the option of zooming in or the possibility of making
-- the kitchen screen larger please" -- and the screen is a TV, not a touch
-- screen, so the size is chosen from the back office or the till.
--
-- tv_size is a preset (auto, monitor, tv32, tv43, tv55, tv65, tv75, tv100) and
-- zoom_percent a fine adjustment on top of it. The venue's default lives with
-- the rest of the kitchen's look on epos_branding; a named screen may override
-- it (NULL on epos_kitchen_screens means "use the venue's").
--
-- touch: whether the screen is tapped. Off draws the board with no buttons on
-- it, and the till runs it (bump, recall, rush, size).

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

CALL vesopa_add_column('epos_branding', 'kitchen_tv_size', 'VARCHAR(12) NULL');
CALL vesopa_add_column('epos_branding', 'kitchen_zoom_percent', 'SMALLINT NULL');
CALL vesopa_add_column('epos_kitchen_screens', 'tv_size', 'VARCHAR(12) NULL');
CALL vesopa_add_column('epos_kitchen_screens', 'zoom_percent', 'SMALLINT NULL');
CALL vesopa_add_column('epos_kitchen_screens', 'touch', 'TINYINT(1) NULL');
CALL vesopa_add_column('epos_branding', 'kitchen_touch', 'TINYINT(1) NULL');
-- Kitchen widgets along the top of the board, comma separated, and the
-- "from the front" note. Empty: none, the default.
CALL vesopa_add_column('epos_branding', 'kitchen_tiles', 'VARCHAR(160) NULL');
CALL vesopa_add_column('epos_branding', 'kitchen_note', 'VARCHAR(160) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
