-- The hardware shop and customer accounts on vesopaepos.com (2026-10-24).
--
-- web_hw_orders     a hardware order, paid on Dojo's checkout (card, Apple Pay,
--                   Google Pay). Money in pence; lines are priced from
--                   src/hardware-catalogue.js on the server, never the browser.
-- web_account_tokens one-time sign-in links for /account (only the SHA-256 of
--                   the token is stored; 30 minutes, single use).
--
-- src/shop.js runs these on start, so a fresh database needs nothing by hand.
-- Everything is CREATE TABLE IF NOT EXISTS: safe to apply again.

CREATE TABLE IF NOT EXISTS web_hw_orders (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  public_id          CHAR(24)     NOT NULL,
  number             VARCHAR(24)  NOT NULL,
  status             VARCHAR(16)  NOT NULL DEFAULT 'pending',   -- pending | paid | cancelled
  contact_name       VARCHAR(120) NOT NULL,
  business           VARCHAR(160) NULL,
  email              VARCHAR(190) NOT NULL,
  phone              VARCHAR(40)  NULL,
  address1           VARCHAR(160) NOT NULL,
  address2           VARCHAR(160) NULL,
  town               VARCHAR(80)  NOT NULL,
  postcode           VARCHAR(16)  NOT NULL,
  notes              VARCHAR(500) NULL,
  trial_period       VARCHAR(8)   NULL,   -- a software plan's free trial added to the order (no £1 check)
  lines_json         TEXT         NOT NULL,
  delivery_key       VARCHAR(16)  NULL,
  delivery_name      VARCHAR(80)  NULL,
  goods_minor        INT          NOT NULL,
  delivery_minor     INT          NOT NULL DEFAULT 0,
  vat_minor          INT          NOT NULL,
  total_minor        INT          NOT NULL,
  payment_intent_id  VARCHAR(64)  NULL,
  card_label         VARCHAR(60)  NULL,
  dojo_mode          VARCHAR(10)  NOT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at            DATETIME     NULL,
  UNIQUE KEY uq_hw_public (public_id),
  UNIQUE KEY uq_hw_number (number),
  KEY ix_hw_email (email),
  KEY ix_hw_pi (payment_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_account_tokens (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  token_hash         CHAR(64)     NOT NULL,
  email              VARCHAR(190) NOT NULL,
  expires_at         DATETIME     NOT NULL,
  used_at            DATETIME     NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acct_token (token_hash),
  KEY ix_acct_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Databases made before trial_period existed.
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS trial_period VARCHAR(8) NULL AFTER notes;

-- Invoice details (2026-10-24): who the paid invoice from Vesopa Software Ltd
-- is made out to, when that is not simply the delivery name and address.
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS invoice_company VARCHAR(160) NULL AFTER trial_period;
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS invoice_vat VARCHAR(40) NULL AFTER invoice_company;
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS invoice_email VARCHAR(190) NULL AFTER invoice_vat;
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS bill_address1 VARCHAR(160) NULL AFTER invoice_email;
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS bill_address2 VARCHAR(160) NULL AFTER bill_address1;
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS bill_town VARCHAR(80) NULL AFTER bill_address2;
ALTER TABLE web_hw_orders ADD COLUMN IF NOT EXISTS bill_postcode VARCHAR(16) NULL AFTER bill_town;
