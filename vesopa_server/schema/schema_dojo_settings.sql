-- ---------------------------------------------------------------------------
-- Dojo card settings per venue, and every card attempt the tills report.
-- (Dojo accreditation, October 2026.) Re-runnable.
-- ---------------------------------------------------------------------------

-- One row per office. The key is sealed with EXPRESS_SECRET_KEY, the same as
-- Vesopa Express's kiosk key, and only its last four characters are ever shown
-- again. The software house id is not here: it is Vesopa's own (SL942X04) and
-- is fixed in code, as Dojo require.
CREATE TABLE IF NOT EXISTS epos_dojo_settings (
  office          VARCHAR(255) NOT NULL PRIMARY KEY,
  api_key_enc     TEXT         NULL,
  key_hint        VARCHAR(12)  NULL,
  environment     VARCHAR(8)   NOT NULL DEFAULT 'sandbox',   -- sandbox | live
  reseller_id     VARCHAR(64)  NULL,
  terminal_id     VARCHAR(64)  NULL,      -- default card machine for a till with none
  result_seconds  TINYINT      NOT NULL DEFAULT 5,           -- 5 | 10 | 15
  updated_by      VARCHAR(255) NULL,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every card sale, refund, status check and cancel a till made, approved or
-- not. Dojo asked that failed payments are logged as well as paid ones.
-- `id` is a hash of the till's own record, so a till re-sending after a
-- dropped connection does not add the row twice.
CREATE TABLE IF NOT EXISTS epos_card_transactions (
  id                 CHAR(40)     NOT NULL PRIMARY KEY,
  office             VARCHAR(255) NOT NULL,
  terminal           VARCHAR(128) NULL,
  at                 DATETIME     NOT NULL,
  kind               VARCHAR(24)  NOT NULL,   -- sale | refund | matched_refund | unlinked_refund | check | cancel
  outcome            VARCHAR(24)  NOT NULL,   -- approved | declined | cancelled | busy | expired | unknown | failed | ...
  amount_minor       INT          NOT NULL DEFAULT 0,
  intent_id          VARCHAR(64)  NULL,
  session_id         VARCHAR(64)  NULL,
  dojo_status        VARCHAR(48)  NULL,
  message            VARCHAR(500) NULL,
  order_id           VARCHAR(64)  NULL,
  terminal_id        VARCHAR(64)  NULL,
  software_house_id  VARCHAR(64)  NULL,
  reseller_id        VARCHAR(64)  NULL,
  auth_code          VARCHAR(32)  NULL,
  card_last4         VARCHAR(4)   NULL,
  card_type          VARCHAR(32)  NULL,
  staff              VARCHAR(128) NULL,
  receipt_lines      JSON         NULL,
  received_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_card_tx_office_at (office, at),
  INDEX idx_card_tx_intent (intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
