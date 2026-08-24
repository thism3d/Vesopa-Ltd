-- ---------------------------------------------------------------------------
-- Per-item progress on a kitchen ticket.
-- ---------------------------------------------------------------------------
-- Until now the only progress a ticket carried was per *station*: the grill is
-- done, the fryer is not. That is the right unit for deciding when a card
-- leaves the board, and the wrong unit for a chef working through a ticket —
-- there was no way to say "the eggs are plated, the toast is not", so a long
-- ticket had to be held in someone's head until every item was ready.
--
-- These two columns are that missing state. A line is either made or it is not;
-- crossing it off is a state assignment, not a counter, so a double tap on a
-- steamed-up screen is one tap and a retried request cannot half-finish a line.
--
-- Station progress is untouched and still decides which tab a card sits in.
-- Marking the last outstanding line simply lets the screen bump the stations it
-- watches, exactly as pressing the tick always did.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- NULL means "not made yet", which is what every existing line correctly is.
CALL vesopa_add_column('epos_kitchen_ticket_lines', 'made_at', 'DATETIME NULL');
CALL vesopa_add_column('epos_kitchen_ticket_lines', 'made_by', 'VARCHAR(120) NULL');
