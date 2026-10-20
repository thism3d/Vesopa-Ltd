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
