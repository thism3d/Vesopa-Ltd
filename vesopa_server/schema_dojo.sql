-- ---------------------------------------------------------------------------
-- Dojo webhooks and card-payment reconciliation.
-- ---------------------------------------------------------------------------
-- Dojo pushes payment-intent and terminal-session events to the back office.
-- Two things have to be true for that to be worth anything:
--
--   1. An event must be recorded exactly once, however many times Dojo sends
--      it. Delivery is at-least-once with up to 12 retries, so a duplicate is
--      the normal case, not the exceptional one — hence the PRIMARY KEY on
--      Dojo's own event id rather than a surrogate.
--   2. An event must be traceable back to a sale. That is what
--      `epos_payments.reference` is for: the paymentIntentId the till used.
--
-- Re-runnable: every statement is IF NOT EXISTS or guarded by
-- vesopa_add_column, which schema_commerce.sql defines.

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

-- ---------------------------------------------------------------------------
-- The event ledger.
-- ---------------------------------------------------------------------------
-- Every verified event is written here before anything acts on it, so the
-- effect of an event can always be explained after the fact — including the
-- ones that arrived for a payment this system has never heard of, which is
-- exactly what a misconfigured environment looks like.
CREATE TABLE IF NOT EXISTS dojo_webhook_events (
  -- Dojo's event id ("evt_..."). PRIMARY KEY, not UNIQUE-on-a-surrogate:
  -- an INSERT IGNORE against this is the whole de-duplication strategy.
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,

  event          VARCHAR(64)  NOT NULL,          -- payment_intent.status_updated, ...
  environment    VARCHAR(16)  NOT NULL,          -- 'sandbox' | 'live'
  account_id     VARCHAR(64)  NULL,
  created_at     DATETIME     NULL,              -- Dojo's CreatedAt

  -- The two ids worth indexing out of the payload, so reconciliation and
  -- support lookups do not have to scan JSON.
  payment_intent_id   VARCHAR(64) NULL,
  terminal_session_id VARCHAR(64) NULL,
  terminal_id         VARCHAR(64) NULL,
  payment_status      VARCHAR(32) NULL,

  -- The raw body as delivered. Kept because a signed payload is the only
  -- evidence of what Dojo actually said, and accreditation asks for it.
  payload        JSON         NOT NULL,

  -- Whether this event was matched to a sale. 'matched' | 'unmatched' —
  -- unmatched is not an error (a webhook can beat the till's own upload),
  -- but a pile of them means the environments are crossed.
  reconciliation VARCHAR(16)  NOT NULL DEFAULT 'unmatched',

  received_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_dojo_evt_intent  (payment_intent_id),
  INDEX idx_dojo_evt_session (terminal_session_id),
  INDEX idx_dojo_evt_time    (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Card state on the payment row.
-- ---------------------------------------------------------------------------
-- `reference` already exists (schema_commerce.sql) and is where the till puts
-- the paymentIntentId. These three record what the acquirer went on to say
-- about that intent after the till had stopped listening — a refund raised
-- from the Dojo portal, a reversal, a late capture.
CALL vesopa_add_column('epos_payments', 'dojo_status',        "VARCHAR(32) NULL");
CALL vesopa_add_column('epos_payments', 'dojo_refunded_minor', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_payments', 'dojo_updated_at',     'DATETIME NULL');

-- Looking a payment up by the acquirer's intent id is the hot path for every
-- webhook, and it was previously a full scan.
--
-- MySQL has no CREATE INDEX IF NOT EXISTS, and deploy.sh re-runs every
-- schema_*.sql on each --schema deploy, so this needs the same guard the
-- columns get or the second deploy fails on a duplicate key name.
DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('CREATE INDEX `', idx, '` ON `', tbl, '` (', cols, ')');
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index('epos_payments', 'idx_payments_reference', '`reference`');
