-- ---------------------------------------------------------------------------
-- Paying for a menu order by card, on Dojo's hosted checkout (2026-10-15)
-- ---------------------------------------------------------------------------
--
-- The owner: "In the Vesopa kitchen menu add the hosted payment with public
-- dojo api so that people can pay easily. Enabled from the back office."
--
-- A venue switches it on (online_pay) and may make it the only way to order
-- (online_pay_required). An order being paid for waits as 'awaiting_payment':
-- the tills and kitchen screens ask only for placed, accepted and ready, so
-- nothing is cooked until Dojo says the money has moved. Then it becomes
-- 'placed' and reaches the till exactly as a pay-at-the-bar order does, with
-- pay_status 'paid' and "PAID ONLINE" in its note. A payment that fails or is
-- abandoned leaves the order 'cancelled'. The key is the venue's own online
-- Dojo key, the one match tickets and gift cards already use.

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

CALL vesopa_add_column('dinein_venue', 'online_pay', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('dinein_venue', 'online_pay_required', 'TINYINT(1) NOT NULL DEFAULT 0');

CALL vesopa_add_column('dinein_orders', 'pay_status', 'VARCHAR(16) NULL');
CALL vesopa_add_column('dinein_orders', 'dojo_intent_id', 'VARCHAR(80) NULL');
CALL vesopa_add_column('dinein_orders', 'paid_minor', 'INT NULL');
CALL vesopa_add_column('dinein_orders', 'paid_at', 'DATETIME NULL');
-- A paid order the venue cannot serve is refunded through Dojo, never just
-- refused (the owner, 2026-10-15): how much went back, when, and Dojo's id.
CALL vesopa_add_column('dinein_orders', 'refunded_minor', 'INT NULL');
CALL vesopa_add_column('dinein_orders', 'refunded_at', 'DATETIME NULL');
CALL vesopa_add_column('dinein_orders', 'refund_ref', 'VARCHAR(80) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- Table names a bad designer save wrote as the word "null" (2026-10-15):
-- cleared, so the table shows by its number. Harmless to re-run.
UPDATE floor_tables SET name = NULL WHERE LOWER(TRIM(name)) IN ('null', 'undefined');
UPDATE floor_tables SET label = NULL WHERE LOWER(TRIM(label)) IN ('null', 'undefined');

-- The new first state. Re-running is harmless: MODIFY to the same list.
ALTER TABLE dinein_orders MODIFY status
  ENUM('awaiting_payment','placed','accepted','ready','served','rejected','cancelled')
  NOT NULL DEFAULT 'placed';
