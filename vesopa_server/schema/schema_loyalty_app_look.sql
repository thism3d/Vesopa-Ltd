-- ===========================================================================
-- The loyalty app: what the venue can change about how it reads, and how
-- long its news is kept.
-- ===========================================================================
--
-- WHAT THIS IS FOR
--
-- The owner's screenshots of The Vesopa Kitchen (2026-09-15): black text on
-- the dark grey surfaces Material derived from a #990000 background, Bebas
-- Neue too small to read at the counter, and a news page that will only ever
-- get longer. Three settings the venue can turn, and two for the news.
--
--   colour_icon   -- the icons: the tab bar, the card's facts, the account
--                    page. Was the main colour, which on the Kitchen is white
--                    on a white card.
--   font_scale    -- 0.80 to 1.60 of the app's normal type size. 1.00 is what
--                    it has always been.
--   inbox_mode    -- 'limit': keep the newest inbox_limit messages and let the
--                    rest go; 'scroll': keep everything, loaded as the page
--                    scrolls. Nothing is deleted either way: raising the
--                    limit brings older news back.
--   inbox_limit   -- how many, for 'limit'. Twelve was the owner's number.
--
-- colour_text already exists (schema_loyalty_app.sql) and is what these sit
-- beside; what changed for it is in the app, which now draws every surface
-- from the venue's background so the text colour reads everywhere.
--
-- SORT ORDER. After schema_loyalty_app.sql, which creates the table.
-- RE-RUNNABLE. Every deploy replays every file here.
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

CALL vesopa_add_column('epos_loyalty_app', 'colour_icon',  'VARCHAR(16) NULL');
CALL vesopa_add_column('epos_loyalty_app', 'font_scale',   'DECIMAL(3,2) NOT NULL DEFAULT 1.00');
CALL vesopa_add_column('epos_loyalty_app', 'inbox_mode',   "VARCHAR(8) NOT NULL DEFAULT 'limit'");
CALL vesopa_add_column('epos_loyalty_app', 'inbox_limit',  'INT NOT NULL DEFAULT 12');

DROP PROCEDURE IF EXISTS vesopa_add_column;
