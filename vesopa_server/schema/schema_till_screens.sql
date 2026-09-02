-- Which screen a venue's tills open on.
--
-- One column on the till-settings row, and it is in its own file rather than in
-- schema_screens.sql for a reason worth stating plainly, because getting it
-- wrong has cost this platform a venue's printer names once already.
--
-- `deploy.sh` applies schema_*.sql in `sort` order:
--
--     schema_screens.sql        's' + 'c'
--     schema_staff_idle.sql     's' + 't'   <- epos_till_settings created HERE
--     schema_till_screens.sql   this file
--
-- So schema_screens.sql runs BEFORE the table this column belongs to exists. An
-- ALTER there would fail with "table doesn't exist" on a fresh database and
-- succeed on every server that already had the table — invisible in testing,
-- and discovered by the first new venue. That is exactly the failure documented
-- in vesopa_epos_kitchen/docs/architecture.md under "The migration rename".
--
-- This file sorts after schema_staff_idle.sql, alongside the four other
-- migrations that extend the same row (change_window, kitchen, printer_names,
-- receipt_buttons). Adding another column to epos_till_settings? Put it in a
-- file named `schema_till_*.sql` and it is safe by construction.
--
-- Target is MySQL 5.7, which has no `ADD COLUMN IF NOT EXISTS`, so this goes
-- through a guard procedure that checks information_schema first. Safe to
-- re-run.

DROP PROCEDURE IF EXISTS vesopa_add_till_screen_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_till_screen_column(
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

-- The screen a till opens on. NULL means the built-in Default, which is
-- synthesised from the catalogue rather than stored — so a venue that has
-- programmed nothing, or has deleted everything it programmed, still gets a
-- working sale screen. See vesopa_epos/docs/screen-programming.md §2.
--
-- No foreign key, deliberately. A screen deleted in the back office must leave
-- this pointing at nothing and the till falling back to Default, rather than
-- either refusing the delete or silently cascading a venue's home screen away.
-- The read resolves it and treats "no such screen" exactly like NULL.
CALL vesopa_add_till_screen_column('home_screen_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_till_screen_column;
