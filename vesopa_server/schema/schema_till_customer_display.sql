-- What the screen facing the customer says above their name.
--
-- "Can we add the customer's name and points to the customer display screen.
-- Maybe a custom field above it so we can change it to like Welcome… etc."
--
-- A venue setting rather than a setting on the display application itself, and
-- that is the point of putting it here: a venue with four counters has four
-- customer displays, and a greeting somebody has to type into each of them is
-- a greeting that ends up different on all four. It is set once in the back
-- office, reaches the till with the rest of `epos_till_settings`, and the till
-- publishes it to whatever display is plugged into it.
--
-- NULL means "Welcome", resolved when the screen draws rather than stored. A
-- venue that clears the box gets the default back; storing the default instead
-- would leave them with a field they cannot empty.
--
-- 120 characters. Long enough for "Croeso i'r Bont / Welcome to The Bridge" and
-- short enough that it cannot push the customer's own name off a pole display.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- Files apply in filename sort order, all of them, on every deploy, and
-- `epos_till_settings` is created by `schema_staff_idle.sql`:
--
--     schema_screens.sql               'sc'
--     schema_staff_idle.sql            'st'  <- the table is created HERE
--     schema_till_bars.sql             'ti'
--     schema_till_customer_display.sql 'ti'  <- this file
--
-- So this cannot live in a file that sorts before "st". That is not a
-- hypothetical: `schema_till_bars.sql` and `schema_till_pay_bars.sql` were
-- both split out for exactly this reason, and their headers record the venue
-- that lost its printer names to an ALTER that ran before its table existed —
-- green on every server that already had the table, broken on the first new
-- venue.
--
-- Safe to re-run. Every file here is replayed on every deploy.
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_column(
  'epos_till_settings', 'customer_display_greeting', 'VARCHAR(120) NULL');

-- Whether the customer's name and points are shown at all.
--
-- Separate from the greeting, and on by default only where there is something
-- to show: a bill with nobody attached draws neither. A venue that would
-- rather not put a customer's name on a screen the next person in the queue
-- can read turns this off and keeps the greeting.
--
-- That is a real objection rather than an invented one — the screen faces a
-- room, and "Welcome Mrs Protheroe — 1,240 points" is a sentence a stranger
-- can read from the other side of the counter.
CALL vesopa_add_column(
  'epos_till_settings', 'customer_display_show_member', 'TINYINT(1) NOT NULL DEFAULT 1');

DROP PROCEDURE IF EXISTS vesopa_add_column;
