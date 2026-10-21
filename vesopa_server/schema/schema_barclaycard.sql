-- ---------------------------------------------------------------------------
-- Barclaycard Smartpay Fuse, online payments for a venue's menu (2026-10-20).
-- Re-runnable. No row means Barclaycard is off: the menu pays exactly as
-- before (Teya when chosen, else Dojo).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS epos_barclaycard_settings (
  office       VARCHAR(255) NOT NULL PRIMARY KEY,
  enabled      TINYINT      NOT NULL DEFAULT 0,          -- the menu takes cards with Barclaycard
  environment  VARCHAR(8)   NOT NULL DEFAULT 'sandbox',  -- sandbox | live
  updated_by   VARCHAR(255) NULL,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The venue's REST keys from the Smartpay Fuse Business Center, one set per
-- environment. The shared secret is sealed with EXPRESS_SECRET_KEY.
CREATE TABLE IF NOT EXISTS epos_barclaycard_keys (
  office       VARCHAR(255) NOT NULL,
  environment  VARCHAR(8)   NOT NULL,
  merchant_id  VARCHAR(128) NOT NULL,
  key_id       VARCHAR(128) NOT NULL,
  secret_enc   TEXT         NOT NULL,
  checked_at   DATETIME     NULL,                         -- last time a test payment went through
  updated_by   VARCHAR(255) NULL,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (office, environment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The tills (2026-10-21): Barclaycard has no card machine API, so a till
-- takes the payment on the customer's phone. The till shows a QR code for a
-- payment page; the customer pays there (card, Apple Pay, Google Pay); the
-- till follows it here and closes the sale when it is paid.
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
CALL vesopa_add_column('epos_barclaycard_settings', 'till_enabled', 'TINYINT NOT NULL DEFAULT 0');
-- The menu's own pay_provider is 'barclays' (8 characters fit the column).
DROP PROCEDURE IF EXISTS vesopa_add_column;

CREATE TABLE IF NOT EXISTS epos_barclaycard_payments (
  id              VARCHAR(32)  NOT NULL PRIMARY KEY,   -- random, the page's address
  office          VARCHAR(255) NOT NULL,
  environment     VARCHAR(8)   NOT NULL,
  till            VARCHAR(128) NULL,
  order_id        VARCHAR(64)  NULL,
  reference       VARCHAR(64)  NULL,
  amount_minor    INT          NOT NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'pending',  -- pending | processing | paid | cancelled | expired
  message         VARCHAR(255) NULL,                        -- the last thing that happened ("card declined")
  payment_id      VARCHAR(64)  NULL,                        -- Barclaycard's id, what a refund needs
  card_last4      VARCHAR(4)   NULL,
  card_brand      VARCHAR(32)  NULL,
  auth_code       VARCHAR(32)  NULL,
  refunded_minor  INT          NOT NULL DEFAULT 0,
  opened_at       DATETIME     NULL,
  paid_at         DATETIME     NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_bc_pay_office (office, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
