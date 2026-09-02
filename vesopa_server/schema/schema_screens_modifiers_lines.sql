-- An order line that is a modifier, rather than an item in its own right.
--
-- The till stores modifiers as real order lines pointing at their parent (see
-- vesopa_epos OrderLines.parentLineId), because that is what makes one price,
-- carry VAT, void and report as what it actually is. What the server needs is
-- less than that: a flag.
--
-- The reason is what a receipt is. Lines arrive in reading order and are
-- printed in reading order — a modifier always immediately follows the item it
-- belongs to — so "is this one hanging off the line above" is the whole of what
-- a reprint, the back office and the PDF receipt need in order to indent it.
-- Carrying the parent's identity as well would mean minting ids that survive
-- the trip from a till's local uuid to a server row, for no gain at the only
-- places that read it.
--
-- Without this, a receipt reprinted from history shows "Dash Coke" as a
-- separate item beneath the gin — which is the exact fault the note column
-- above was added to fix, where "the same sale printed two ways said two
-- different things".
--
-- Named to sort after schema_screens_modifiers.sql, which it belongs with.
-- Target is MySQL 5.7 / MariaDB, and re-running is a no-op.

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

-- 0 for every line that already exists, which is true: before modifiers, every
-- line was an item in its own right.
CALL vesopa_add_column('epos_order_lines', 'is_modifier',
                       'TINYINT(1) NOT NULL DEFAULT 0');

-- The position of this line on the bill.
--
-- Needed by the flag above, and overdue on its own account. `id` is a CHAR(36)
-- primary key filled with UUID(), the table has no other ordering column, and
-- the receipt reads select without an ORDER BY — so InnoDB hands lines back
-- clustered by a random uuid. Every receipt reprinted from history has been
-- coming back with its items shuffled.
--
-- Nobody noticed because a receipt is usually read as a set of prices that add
-- up, and it still adds up. A modifier is the case where order carries meaning:
-- "Dash Coke" three lines below the gin it belongs to is not the same ticket.
--
-- Existing rows all get 0 and stay in whatever order they were in — the past
-- cannot be reconstructed, and a stable wrong order is no worse than the
-- unstable one they have now.
CALL vesopa_add_column('epos_order_lines', 'line_no', 'INT NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- The same flag on the kitchen board's copy of a line.
--
-- A ticket on a screen is not built from epos_order_lines — it is its own row,
-- written when the line is fired (see epos_kitchen_ticket_lines) — so the flag
-- has to travel there separately. `seq` already holds the reading order, so
-- this is the only thing the board is missing in order to draw an answer under
-- the dish it belongs to rather than beside it.
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

CALL vesopa_add_column('epos_kitchen_ticket_lines', 'is_modifier',
                       'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- Which room a bill's table is in.
--
-- The floor plan has allowed a Table 1 on the Main Floor and a Table 1 on the
-- Terrace since schema_fix_table_uq.sql keyed floor_tables on (room_id,
-- table_number). The order never learned about rooms, so both of those tables
-- shared one bill: sitting a party at the second recalled the first one's food,
-- and a Terrace ticket printed "Main Floor" at the top of it.
--
-- Null for a counter sale, for a bill on no table, and for every order taken
-- before this existed. A venue with one room is unaffected either way.
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

CALL vesopa_add_column('epos_orders', 'room_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
