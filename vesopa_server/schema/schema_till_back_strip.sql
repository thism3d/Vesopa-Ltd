-- The till's "Back to <home>" strip (2026-10-08): the venue chooses when it
-- shows, in Screen Programming › Page highlight.
--
--   NULL / 'auto'  only on a page with no key back to the home screen (the
--                  page, its top bar and its bottom bar all checked). What
--                  EPOS 1.14.1 did for everybody.
--   'always'       on every page but the home screen, as before 1.14.1.
--   'never'        never. For a venue whose page keys always lead home.
--
-- A till older than the release that reads this ignores it and keeps 'auto'.
-- Named schema_till_*.sql so it sorts after schema_staff_idle.sql, where
-- epos_till_settings is created. Safe to re-run.

DROP PROCEDURE IF EXISTS vesopa_add_back_strip_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_back_strip_column()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'epos_till_settings'
      AND COLUMN_NAME = 'nav_back_strip'
  ) THEN
    ALTER TABLE epos_till_settings ADD COLUMN nav_back_strip VARCHAR(8) NULL;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_back_strip_column();
DROP PROCEDURE IF EXISTS vesopa_add_back_strip_column;
