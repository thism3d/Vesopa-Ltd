-- ---------------------------------------------------------------------------
-- What a payment actually paid, change taken off (2026-10-19)
-- ---------------------------------------------------------------------------
--
-- Pontardawe RFC's Saturday Z: department sales £1,025.69, payments
-- £1,235.49. A cash payment row holds what was handed over -- a £20 note for a
-- £7.50 round is a £20 row, which is what lets the receipt print "Change
-- £12.50" -- and every report that added those rows up counted the change as
-- cash taken (£209.80 that night).
--
-- applied_minor is the part of the payment that paid the bill: the amount
-- less the sale's change, for cash. NULL means the amount is the applied
-- amount (card, and cash with no change). Reports add up
-- COALESCE(applied_minor, amount_minor); amount_minor is never changed.
--
-- The backfill below fills it for sales already in: a closed sale whose
-- payments came to more than its total, on its one cash payment. A sale with
-- two cash payments (rare) is left as it was rather than guessed at. Safe to
-- run again: only rows still NULL are touched.

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

CALL vesopa_add_column('epos_payments', 'applied_minor', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

UPDATE epos_payments p
  JOIN (
    SELECT o.id AS order_id,
           SUM(p2.amount_minor) - o.total_minor AS overpaid,
           SUM(p2.method = 'cash') AS cash_rows
      FROM epos_orders o
      JOIN epos_payments p2 ON p2.order_id = o.id
     WHERE o.closed_at IS NOT NULL
     GROUP BY o.id, o.total_minor
    HAVING overpaid > 0 AND cash_rows = 1
  ) x ON x.order_id = p.order_id
   SET p.applied_minor = GREATEST(p.amount_minor - x.overpaid, 0)
 WHERE p.method = 'cash' AND p.applied_minor IS NULL;
