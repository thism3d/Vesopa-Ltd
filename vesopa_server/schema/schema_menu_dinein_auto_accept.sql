-- Accept orders from the table-ordering app without anybody pressing Accept.
--
-- "A setting to automatically accept Menu orders form table ordering app."
--
-- OFF BY DEFAULT, and that is not timidity. Accepting is a promise to somebody
-- sitting at a table: it starts their clock, it prints their food, and it can
-- no longer be refused. A venue that upgrades and never opens this page must
-- carry on being asked, because that is what it agreed to.
--
-- WHERE THE ACCEPTING ACTUALLY HAPPENS, AND WHY IT IS NOT HERE
--
-- The obvious reading of this setting is "the server accepts the order the
-- moment it is placed". That is wrong, and it would lose the venue money.
--
-- Accepting is what CREATES THE SALE. `vesopa_epos/lib/ui/dinein_actions.dart`
-- rings every line of the order onto a bill on the right table, and only then
-- posts `accepted` with that bill's id. A server that flipped the status by
-- itself would mark the order accepted with `order_id` NULL, no till would
-- ever ring it up, and the kitchen would cook food that reached no bill and no
-- Z report.
--
-- So the till does it, driven by this setting, down the same code path a
-- clerk's tap uses. Exactly-once is already guaranteed on the server side and
-- needs nothing new: the transition updates `WHERE status IN ('placed')`, so a
-- second till gets `affectedRows = 0` and is told another terminal got there
-- first — which is the same refusal two clerks tapping Accept together already
-- get today.
--
-- What the venue gives up is stated on the form rather than left to be
-- discovered: auto-accept needs a till switched on. A venue taking orders from
-- tables has one, but it is their fact to know.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- Files apply in filename sort order on every deploy. `dinein_venue` is
-- created by `schema_menu_dinein.sql`, and "." sorts before "_", so:
--
--     schema_menu_dinein.sql             <- creates dinein_venue
--     schema_menu_dinein_auto_accept.sql <- this file
--     schema_menu_dinein_hours.sql
--
-- Safe to re-run.
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
  'dinein_venue', 'auto_accept_orders', 'TINYINT(1) NOT NULL DEFAULT 0');

-- Who accepted it: a clerk, or the setting above.
--
-- On the ORDER rather than inferred from timestamps, because "why did this go
-- straight to the kitchen?" is the first question asked about an order that
-- should have been refused, and the answer has to survive the setting being
-- turned off afterwards.
--
-- NULL for every order accepted before this column existed, which is honest —
-- those were all accepted by a person, but this row does not know which.
CALL vesopa_add_column(
  'dinein_orders', 'accepted_by', "VARCHAR(16) NULL");

DROP PROCEDURE IF EXISTS vesopa_add_column;
