-- Venue-wide names for the printer slots.
--
-- The *hardware* stays on the terminal — which IP, which USB device, which COM
-- port — because that is physical to a counter and two tills in the same room
-- have different printers plugged into them. What the venue owns is the
-- vocabulary: "KP 3" is the fryer in every room, on every till, and in the
-- product editor, or it is nothing anybody can route food to with confidence.
--
-- So this is naming only. A blank name falls back to the built-in label, which
-- is what every existing venue keeps until somebody types something here.
--
-- Stored as columns on the existing till-settings row rather than a new table:
-- the till already fetches that row on startup and re-polls it, so the names
-- reach every terminal through a path that is already built and already
-- cache-busted by the till-settings broadcast. A new table would need its own
-- sync for seven short strings.
--
-- Guarded with the same helper the other migrations use, so deploy.sh can run
-- the whole schema_*.sql set on every deploy without this failing the second
-- time.

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

CALL vesopa_add_column('epos_till_settings', 'printer_name_kp1', 'VARCHAR(40) NULL');
CALL vesopa_add_column('epos_till_settings', 'printer_name_kp2', 'VARCHAR(40) NULL');
CALL vesopa_add_column('epos_till_settings', 'printer_name_kp3', 'VARCHAR(40) NULL');
CALL vesopa_add_column('epos_till_settings', 'printer_name_kp4', 'VARCHAR(40) NULL');
CALL vesopa_add_column('epos_till_settings', 'printer_name_kp5', 'VARCHAR(40) NULL');
CALL vesopa_add_column('epos_till_settings', 'printer_name_kp6', 'VARCHAR(40) NULL');
CALL vesopa_add_column('epos_till_settings', 'printer_name_receipt', 'VARCHAR(40) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
