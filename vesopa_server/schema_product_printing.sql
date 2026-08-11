-- Per-product printer routing.
--
-- `printer_route` held one station name ("kitchen" or "bar"), which is one
-- station short for any venue with a grill and a fryer, and two short for one
-- that also has a bar and a pass. A dish routinely belongs on more than one
-- printer: the grill cooks it, the pass plates it, and both need the ticket.
--
-- Stored as a comma-separated list of station keys ("kp1,kp3") rather than a
-- join table. The till reads the whole set for every product on every ticket
-- and never queries by station, so a join table would buy nothing and cost the
-- offline mirror an extra table to sync.
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

CALL vesopa_add_column('bo_products', 'printer_routes', 'VARCHAR(64) NULL');

-- Whether the item appears on the customer's receipt. Defaults to 1, which is
-- what all but a handful of items want; the exception is a kitchen instruction
-- rung up as a product, which belongs on the ticket and nowhere near the bill.
CALL vesopa_add_column(
  'bo_products', 'print_to_receipt', 'TINYINT(1) NOT NULL DEFAULT 1');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- Carry the existing routing across. A venue that set up "kitchen" and "bar"
-- before the stations were numbered keeps printing: kitchen becomes KP 1 and
-- bar becomes KP 2, the order they were listed in and so almost certainly the
-- order the printers were plugged in.
--
-- Only rows that have not been routed yet, so re-running this cannot undo a
-- manager's later edit.
UPDATE bo_products
   SET printer_routes = CASE LOWER(TRIM(printer_route))
                          WHEN 'kitchen' THEN 'kp1'
                          WHEN 'bar'     THEN 'kp2'
                          ELSE LOWER(TRIM(printer_route))
                        END
 WHERE printer_routes IS NULL
   AND printer_route IS NOT NULL
   AND printer_route <> '';

-- `printer_route` is deliberately left in place. A till running the previous
-- release still reads it, and dropping the column would stop those terminals
-- routing food the moment this migration ran rather than when they updated.
-- It is written alongside the new column (see backoffice.js) and can be
-- dropped once no terminal reports an older version.
