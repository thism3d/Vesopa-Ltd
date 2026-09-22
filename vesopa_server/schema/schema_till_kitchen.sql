-- Where each kitchen station's tickets come out: a printer, a screen, or both.
--
-- Split out of schema_kitchen.sql, which creates the kitchen's own tables, and
-- named `schema_till_*` for a reason that is easy to miss: deploy.sh applies
-- these files in `sort` order, and this one alters `epos_till_settings`, which
-- schema_staff_idle.sql creates. As `schema_kitchen.sql` it sorted *before*
-- that file and would have found no table on a fresh database. The two other
-- migrations that extend the same row — schema_till_change_window.sql and
-- schema_till_receipt_buttons.sql — are named the same way for the same reason.
--
-- Venue-wide, like the station *names* that sit next to it on the same row, and
-- for the same reason: "KP 3 is the fryer, and the fryer has a screen" is a
-- fact about the venue, not about one till. A per-terminal setting would let
-- two tills in one room disagree about whether the fryer prints.
--
--   printer : ESC/POS to whatever this terminal has plugged into that station.
--             The default, and what every venue does today.
--   screen  : every kitchen screen watching that station. No paper.
--   both    : belt and braces, for the fortnight a venue spends trusting the
--             screen enough to unplug the printer.
--
-- Defaulting to 'printer' is the whole compatibility story: a venue that
-- upgrades and never opens the kitchen app prints exactly as it did yesterday.
--
-- The receipt printer is a routing destination too, but it is not a kitchen
-- station — a product routed there prints at the counter, which is the point of
-- it — so it deliberately has no mode.

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
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- Quotes are doubled because the value reaches the procedure as a string
-- literal. Double quotes would be shorter and would break under ANSI_QUOTES,
-- where they are read as an identifier — the trap schema_staff_idle.sql notes.
SET @mode_ddl = 'VARCHAR(8) NOT NULL DEFAULT ''printer''';

CALL vesopa_add_column('epos_till_settings', 'kitchen_mode_kp1', @mode_ddl);
CALL vesopa_add_column('epos_till_settings', 'kitchen_mode_kp2', @mode_ddl);
CALL vesopa_add_column('epos_till_settings', 'kitchen_mode_kp3', @mode_ddl);
CALL vesopa_add_column('epos_till_settings', 'kitchen_mode_kp4', @mode_ddl);
CALL vesopa_add_column('epos_till_settings', 'kitchen_mode_kp5', @mode_ddl);
CALL vesopa_add_column('epos_till_settings', 'kitchen_mode_kp6', @mode_ddl);

DROP PROCEDURE IF EXISTS vesopa_add_column;
