-- ---------------------------------------------------------------------------
-- The screen each member of staff starts on (2026-10-15)
-- ---------------------------------------------------------------------------
--
-- Nicki at Pontardawe RFC: "Default Page needs to be a setting for each staff
-- member, e.g. Carys, set to Draughts, she will always go to the draught page
-- when she signs on, Abi is a waiter she is set to go straight to the food
-- page." An epos_screens id, or NULL for wherever the till already is.
-- Set on the back office's staff form; sent to the tills with the staff list.

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

CALL vesopa_add_column('bo_clarks', 'default_screen_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
