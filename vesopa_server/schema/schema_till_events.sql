-- ===========================================================================
-- What the till does that is not a sale, sent up so the back office can
-- report on it.
-- ===========================================================================
--
-- WHAT THIS IS FOR
--
-- A refund, a no-sale, an expense paid out of the drawer and cashback given
-- against a card all move money without a sale. The till has kept them in
-- its own TillEvents table for the Z report since 1.6, and never sent them
-- anywhere -- so the back office could not run a Refunds report, an Expenses
-- report or a Cashback report, all three of which the venue asked for by
-- name. This is the server's copy.
--
-- Idempotent on `id`: the till mints it, retries re-send it, INSERT IGNORE
-- drops the duplicate. Voids already work this way in epos_void_log and stay
-- there; a void is a correction to a sale rather than money moving, and the
-- Voids report reads that table.
--
-- Beside it, two columns on tables other files own:
--
--   * epos_payments.cashback_minor -- the cashback inside a card payment. The
--     card machine reports it and the till has always known it; nothing stored
--     it. A Cashback report from events alone would miss every one taken as
--     part of a card sale.
--   * bo_clarks.hourly_rate -- what a member of staff costs an hour, so the
--     Profit Summary can put a labour line under the gross profit.
--
-- SORT ORDER. After schema.sql (epos_payments) and after the original back
-- office's bo_clarks, which every venue already has.
--
-- RE-RUNNABLE. Every deploy replays every file here.
-- ===========================================================================

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

CREATE TABLE IF NOT EXISTS epos_till_events (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  office        VARCHAR(190) NOT NULL,
  -- refund | no_sale | expense | cashback
  kind          VARCHAR(16)  NOT NULL,
  -- Always positive. The report knows a refund is money out.
  amount_minor  INT          NOT NULL DEFAULT 0,
  -- Who it went to, for an expense; what came off, for a refund.
  note          VARCHAR(255) NULL,
  reason        VARCHAR(255) NULL,
  staff_name    VARCHAR(120) NULL,
  terminal      VARCHAR(120) NULL,
  session_id    CHAR(36)     NULL,
  order_id      CHAR(36)     NULL,
  at            DATETIME     NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_till_events_office (office, kind, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CALL vesopa_add_column('epos_payments', 'cashback_minor', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_clarks',     'hourly_rate',    'DOUBLE NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
