-- ---------------------------------------------------------------------------
-- Teya, the second card acquirer beside Dojo (2026-10-19). Re-runnable.
--
-- Nothing here changes a venue that has not chosen Teya: no row means Teya is
-- off, the tills use Dojo and the menu pays with Dojo, exactly as before.
-- ---------------------------------------------------------------------------

-- One row per venue (office = the venue's contact email, as epos_dojo_settings).
CREATE TABLE IF NOT EXISTS epos_teya_settings (
  office           VARCHAR(255) NOT NULL PRIMARY KEY,
  enabled          TINYINT      NOT NULL DEFAULT 0,          -- Teya off until a manager turns it on
  environment      VARCHAR(8)   NOT NULL DEFAULT 'sandbox',  -- sandbox | live
  card_provider    VARCHAR(8)   NOT NULL DEFAULT 'dojo',     -- the tills' card machines: dojo | teya
  online_provider  VARCHAR(8)   NOT NULL DEFAULT 'dojo',     -- the menu's online checkout: dojo | teya
  updated_by       VARCHAR(255) NULL,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A venue's Teya connections, one per environment, so switching to live and
-- back never loses the sandbox one. Every secret is sealed with
-- EXPRESS_SECRET_KEY, as the Dojo keys are.
CREATE TABLE IF NOT EXISTS epos_teya_connections (
  office               VARCHAR(255) NOT NULL,
  environment          VARCHAR(8)   NOT NULL,
  -- Card machines (POSLink): the manager's approval, and the store's own
  -- machine credentials from registering Vesopa as its ePOS.
  user_refresh_enc     TEXT         NULL,
  user_access_enc      TEXT         NULL,
  user_access_until    DATETIME     NULL,
  user_name            VARCHAR(255) NULL,
  store_id             VARCHAR(64)  NULL,
  store_name           VARCHAR(255) NULL,
  m2m_client_id        VARCHAR(128) NULL,
  m2m_secret_enc       TEXT         NULL,
  default_terminal_id  VARCHAR(64)  NULL,
  connected_by         VARCHAR(255) NULL,
  connected_at         DATETIME     NULL,
  -- Online payments: the store's own credentials, posted by Teya to our
  -- registration webhook, and the key its payment webhooks are signed with.
  online_state         VARCHAR(64)  NULL,
  online_state_until   DATETIME     NULL,
  online_store_id      VARCHAR(64)  NULL,
  online_client_id     VARCHAR(128) NULL,
  online_secret_enc    TEXT         NULL,
  online_webhook_key   TEXT         NULL,
  online_connected_at  DATETIME     NULL,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (office, environment),
  INDEX idx_teya_online_state (online_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A venue's own Teya Device Code app credentials, per environment, entered in
-- the back office (Card Payments, Teya, App credentials). None means Vesopa's
-- own from the server .env. This is where a venue's live credentials go.
CREATE TABLE IF NOT EXISTS epos_teya_apps (
  office            VARCHAR(255) NOT NULL,
  environment       VARCHAR(8)   NOT NULL,
  device_client_id  VARCHAR(128) NOT NULL,
  device_secret_enc TEXT         NOT NULL,
  plugin_type       VARCHAR(40)  NULL,
  updated_by        VARCHAR(255) NULL,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (office, environment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which Teya card machine each till uses, chosen in the back office, keyed on
-- the till's permanent device id so it survives the till signing in again.
CREATE TABLE IF NOT EXISTS epos_teya_till_terminals (
  office       VARCHAR(255) NOT NULL,
  environment  VARCHAR(8)   NOT NULL,
  device_id    VARCHAR(64)  NOT NULL,
  terminal_id  VARCHAR(64)  NOT NULL,
  updated_by   VARCHAR(255) NULL,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (office, environment, device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every payment request a till sent to a Teya card machine, and where it got
-- to. The till's own record goes to epos_card_transactions as for Dojo; this
-- is the server's, so a till that crashed mid-payment can ask again.
CREATE TABLE IF NOT EXISTS epos_teya_payments (
  id                  VARCHAR(64)  NOT NULL PRIMARY KEY,  -- Teya's payment_request_id
  office              VARCHAR(255) NOT NULL,
  environment         VARCHAR(8)   NOT NULL,
  till                VARCHAR(128) NULL,
  terminal_id         VARCHAR(64)  NOT NULL,
  store_id            VARCHAR(64)  NOT NULL,
  kind                VARCHAR(8)   NOT NULL DEFAULT 'SALE',  -- SALE | REFUND
  amount_minor        INT          NOT NULL,
  tip_minor           INT          NOT NULL DEFAULT 0,
  reference           VARCHAR(64)  NOT NULL,
  order_id            VARCHAR(64)  NULL,
  status              VARCHAR(16)  NOT NULL DEFAULT 'NEW',
  progress            VARCHAR(48)  NULL,
  status_reason       VARCHAR(48)  NULL,
  gateway_payment_id  VARCHAR(64)  NULL,
  card_last4          VARCHAR(4)   NULL,
  card_brand          VARCHAR(32)  NULL,
  auth_code           VARCHAR(32)  NULL,
  refunded_minor      INT          NOT NULL DEFAULT 0,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_teya_pay_office (office, created_at),
  INDEX idx_teya_pay_gateway (gateway_payment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The menu: which provider an order is being paid with, Teya's checkout page
-- and its transaction id once paid (for refunds). dojo_intent_id carries Teya's
-- checkout session id for a Teya order, so every "is it still being paid
-- for" check stays one column.
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

CALL vesopa_add_column('dinein_orders', 'pay_provider', "VARCHAR(8) NULL");
CALL vesopa_add_column('dinein_orders', 'pay_env', "VARCHAR(8) NULL");
CALL vesopa_add_column('dinein_orders', 'pay_txn', "VARCHAR(64) NULL");
CALL vesopa_add_column('dinein_orders', 'pay_url', "VARCHAR(512) NULL");

DROP PROCEDURE IF EXISTS vesopa_add_column;
