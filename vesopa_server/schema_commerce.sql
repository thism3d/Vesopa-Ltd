-- Gratuity, partial/split tender, vouchers, deposits, gift cards, loyalty,
-- promotions, multi-buy, and super-admin templates.
--
-- Target is MySQL 5.7: no `ADD COLUMN IF NOT EXISTS`, so column additions go
-- through a guard procedure. Safe to re-run.

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
-- Tender settings: gratuity and the cash quick-keys, per office.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_tender_settings (
  office              VARCHAR(190) NOT NULL PRIMARY KEY,

  -- Gratuity / service charge.
  gratuity_enabled    TINYINT(1)   NOT NULL DEFAULT 1,
  -- 'off' | 'prompt' (ask at payment) | 'auto' (added to every bill)
  gratuity_mode       VARCHAR(16)  NOT NULL DEFAULT 'prompt',
  -- Offered percentages, e.g. "5,10,12.5,15,20". Basis points would be
  -- overkill; this is display copy the till turns into buttons.
  gratuity_presets    VARCHAR(120) NOT NULL DEFAULT '5,10,12.5,15,20',
  -- Tenths of a percent, so 12.5% is 125 and stays exact in integer maths.
  gratuity_default_bp SMALLINT     NOT NULL DEFAULT 125,
  -- An auto service charge is discretionary in the UK and must be removable.
  gratuity_removable  TINYINT(1)   NOT NULL DEFAULT 1,
  -- Only apply the automatic charge from this many covers upwards (0 = always).
  gratuity_min_covers TINYINT      NOT NULL DEFAULT 0,

  -- Cash quick-keys, in minor units, e.g. "500,1000,2000,5000".
  cash_presets        VARCHAR(160) NOT NULL DEFAULT '500,1000,2000,5000',
  -- Offer a "round up to the next note" key.
  cash_quick_round    TINYINT(1)   NOT NULL DEFAULT 1,

  allow_partial_card  TINYINT(1)   NOT NULL DEFAULT 1,
  allow_split_bill    TINYINT(1)   NOT NULL DEFAULT 1,

  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Gift cards / smart vouchers: a stored balance, redeemable in parts.
--
-- Distinct from bo_vouchers (a discount rule that reduces a bill) — this is
-- money held on account, so it needs a balance and an audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_gift_cards (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  office         VARCHAR(190) NOT NULL,
  code           VARCHAR(64)  NOT NULL,
  -- 'smart' keeps a balance and can be reloaded; 'paper' is a printed
  -- certificate redeemed once for its face value.
  kind           VARCHAR(16)  NOT NULL DEFAULT 'smart',
  initial_minor  INT          NOT NULL DEFAULT 0,
  balance_minor  INT          NOT NULL DEFAULT 0,
  currency       VARCHAR(3)   NOT NULL DEFAULT 'GBP',
  customer_id    CHAR(36)     NULL,
  recipient_name VARCHAR(120) NULL,
  expires_on     DATE         NULL,
  reloadable     TINYINT(1)   NOT NULL DEFAULT 1,
  -- 'active' | 'redeemed' | 'expired' | 'void'
  status         VARCHAR(16)  NOT NULL DEFAULT 'active',
  issued_by      VARCHAR(120) NULL,
  notes          VARCHAR(500) NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  -- A code must be unique within a venue, but two venues may both issue "GIFT1".
  UNIQUE KEY uq_gift_office_code (office, code),
  KEY idx_gift_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every movement on a card. The balance column is the running total; this is
-- the evidence for it, which is what makes a disputed balance answerable.
CREATE TABLE IF NOT EXISTS epos_gift_card_txns (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  gift_card_id   CHAR(36)     NOT NULL,
  office         VARCHAR(190) NOT NULL,
  -- 'issue' | 'reload' | 'redeem' | 'refund' | 'void' | 'adjust'
  kind           VARCHAR(16)  NOT NULL,
  -- Signed: redemptions are negative, so the column sums to the balance.
  amount_minor   INT          NOT NULL,
  balance_after  INT          NOT NULL,
  order_id       CHAR(36)     NULL,
  clerk_name     VARCHAR(80)  NULL,
  note           VARCHAR(255) NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_gct_card (gift_card_id),
  KEY idx_gct_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Deposits: money taken before the sale, redeemed against the final bill.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_deposits (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  office         VARCHAR(190) NOT NULL,
  reference      VARCHAR(60)  NOT NULL,
  customer_id    CHAR(36)     NULL,
  customer_name  VARCHAR(120) NULL,
  customer_phone VARCHAR(64)  NULL,
  -- What the deposit is against: a booking, a catering order, a custom item.
  description    VARCHAR(255) NULL,
  amount_minor   INT          NOT NULL DEFAULT 0,
  -- Deposits can be redeemed in parts against more than one bill.
  redeemed_minor INT          NOT NULL DEFAULT 0,
  order_total_minor INT       NULL,
  method         VARCHAR(24)  NULL,
  -- 'held' | 'redeemed' | 'refunded' | 'forfeited'
  status         VARCHAR(16)  NOT NULL DEFAULT 'held',
  due_on         DATE         NULL,
  taken_by       VARCHAR(120) NULL,
  redeemed_order_id CHAR(36)  NULL,
  notes          VARCHAR(500) NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_deposit_office_ref (office, reference),
  KEY idx_deposit_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Loyalty: how points are earned and what they are worth.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_loyalty_settings (
  office               VARCHAR(190) NOT NULL PRIMARY KEY,
  enabled              TINYINT(1)   NOT NULL DEFAULT 1,
  -- Points per whole pound spent.
  points_per_pound     INT          NOT NULL DEFAULT 1,
  -- What one point is worth when redeemed, in minor units. 1p by default, so
  -- 100 points = £1.
  point_value_minor    INT          NOT NULL DEFAULT 1,
  min_spend_minor      INT          NOT NULL DEFAULT 0,
  min_redeem_points    INT          NOT NULL DEFAULT 100,
  -- Round the redemption down to a multiple of this many points.
  redeem_step_points   INT          NOT NULL DEFAULT 100,
  points_expire_months SMALLINT     NOT NULL DEFAULT 0,
  -- Earn points on the goods only, not on service charge or gift-card top-ups.
  earn_on_gratuity     TINYINT(1)   NOT NULL DEFAULT 0,
  -- A phone number is what identifies the customer at the till.
  require_phone        TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Spend tiers (Silver / Gold / Platinum).
CREATE TABLE IF NOT EXISTS epos_loyalty_tiers (
  id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office             VARCHAR(190) NOT NULL,
  name               VARCHAR(60)  NOT NULL,
  min_spend_minor    INT          NOT NULL DEFAULT 0,
  discount_percent   DECIMAL(5,2) NOT NULL DEFAULT 0,
  points_multiplier  DECIMAL(4,2) NOT NULL DEFAULT 1,
  colour             VARCHAR(16)  NOT NULL DEFAULT '#8e8e93',
  perks              VARCHAR(500) NULL,
  active             TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order         INT          NOT NULL DEFAULT 0,
  KEY idx_tier_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Points movements, so a balance can always be explained.
CREATE TABLE IF NOT EXISTS epos_loyalty_txns (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  office        VARCHAR(190) NOT NULL,
  customer_id   CHAR(36)     NOT NULL,
  order_id      CHAR(36)     NULL,
  -- 'earn' | 'redeem' | 'adjust' | 'expire'
  kind          VARCHAR(16)  NOT NULL,
  points        INT          NOT NULL,
  balance_after INT          NOT NULL,
  spend_minor   INT          NOT NULL DEFAULT 0,
  value_minor   INT          NOT NULL DEFAULT 0,
  note          VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lt_customer (customer_id),
  KEY idx_lt_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Promotions: per-item offers and multi-buy deals.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_promotions (
  id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office          VARCHAR(190) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  -- 'percent' | 'amount' | 'fixed_price' | 'multibuy' | 'bogof'
  kind            VARCHAR(24)  NOT NULL DEFAULT 'percent',
  -- percent: tenths of a percent. amount/fixed_price: minor units.
  value           INT          NOT NULL DEFAULT 0,
  -- multibuy: buy `buy_qty` for `deal_price_minor` (3-for-2 is buy 3, free 1).
  buy_qty         INT          NOT NULL DEFAULT 0,
  free_qty        INT          NOT NULL DEFAULT 0,
  deal_price_minor INT         NOT NULL DEFAULT 0,
  -- What it applies to: 'product' | 'department' | 'group' | 'order'
  scope           VARCHAR(16)  NOT NULL DEFAULT 'product',
  scope_value     VARCHAR(190) NULL,
  min_spend_minor INT          NOT NULL DEFAULT 0,
  starts_on       DATE         NULL,
  ends_on         DATE         NULL,
  -- Day/time windows for happy hour. days_of_week is a 7-char mask, Mon first:
  -- "1111100" is weekdays.
  days_of_week    VARCHAR(7)   NOT NULL DEFAULT '1111111',
  start_time      TIME         NULL,
  end_time        TIME         NULL,
  -- How it looks on the till button, so an offer is visible when selling.
  badge_text      VARCHAR(40)  NULL,
  badge_colour    VARCHAR(16)  NOT NULL DEFAULT '#d81b60',
  -- Stop a product being discounted twice by two different promos.
  stackable       TINYINT(1)   NOT NULL DEFAULT 0,
  priority        INT          NOT NULL DEFAULT 0,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order      INT          NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_promo_office (office),
  KEY idx_promo_scope (office, scope, scope_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Products a promotion covers, when it names them individually.
CREATE TABLE IF NOT EXISTS epos_promotion_products (
  promotion_id INT NOT NULL,
  pluid        INT NOT NULL,
  PRIMARY KEY (promotion_id, pluid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Automation rules: "if this happens, then that applies".
-- Conditions and actions are JSON so the back office can grow new rule types
-- without a migration each time. MySQL 5.7 has no JSON validation on TEXT, so
-- the server parses and validates on write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_rules (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office      VARCHAR(190) NOT NULL,
  name        VARCHAR(120) NOT NULL,
  -- 'sale_total' | 'item_qty' | 'customer_tier' | 'time_window' | 'covers'
  trigger_kind VARCHAR(32) NOT NULL,
  conditions  TEXT         NULL,
  actions     TEXT         NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  priority    INT          NOT NULL DEFAULT 0,
  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rule_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Super admin: starter-data templates assigned when an office is created.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_templates (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  -- 'restaurant' | 'cafe' | 'bar' | 'retail' | 'custom'
  kind        VARCHAR(32)  NOT NULL DEFAULT 'custom',
  -- The whole starter catalogue as JSON: departments, groups, products, tax
  -- rates, promos. Applied by copying rows, so an office can edit them freely
  -- afterwards without affecting the template.
  payload     LONGTEXT     NULL,
  is_default  TINYINT(1)   NOT NULL DEFAULT 0,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Column additions to existing tables.
-- ---------------------------------------------------------------------------

-- Sale-level money that the receipt has to show.
CALL vesopa_add_column('epos_orders', 'gratuity_minor',   'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'gratuity_bp',      'SMALLINT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'gift_card_minor',  'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'gift_card_code',   'VARCHAR(64) NULL');
CALL vesopa_add_column('epos_orders', 'deposit_minor',    'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'deposit_reference','VARCHAR(60) NULL');
CALL vesopa_add_column('epos_orders', 'points_redeemed',  'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'points_value_minor','INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'promo_minor',      'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'customer_id',      'CHAR(36) NULL');
CALL vesopa_add_column('epos_orders', 'customer_phone',   'VARCHAR(64) NULL');
-- Which of several bills a split produced, so a split table reconciles.
CALL vesopa_add_column('epos_orders', 'split_group',      'CHAR(36) NULL');
CALL vesopa_add_column('epos_orders', 'split_index',      'TINYINT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'split_count',      'TINYINT NOT NULL DEFAULT 0');

-- Per-line promotion detail, so a discount can be explained on the receipt
-- rather than only appearing in the total.
CALL vesopa_add_column('epos_order_lines', 'discount_minor', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_order_lines', 'promotion_id',   'INT NULL');
CALL vesopa_add_column('epos_order_lines', 'promotion_name', 'VARCHAR(120) NULL');

-- Payments: partial and split tender need to say what backed each part.
CALL vesopa_add_column('epos_payments', 'reference',    'VARCHAR(120) NULL');
CALL vesopa_add_column('epos_payments', 'gratuity_minor','INT NOT NULL DEFAULT 0');
-- 'terminal' | 'manual' | 'hosted' | 'native' — a manually keyed card is a
-- different risk from one dipped in a reader, and the report must show which.
CALL vesopa_add_column('epos_payments', 'entry_mode',   'VARCHAR(16) NULL');

-- Vouchers gain the rules the till has to enforce.
CALL vesopa_add_column('bo_vouchers', 'min_spend_minor', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_vouchers', 'reusable',        'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_vouchers', 'times_used',      'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_vouchers', 'max_uses',        'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('bo_vouchers', 'starts_on',       'DATE NULL');
-- Visual editor: how the voucher button looks on the till.
CALL vesopa_add_column('bo_vouchers', 'button_colour',   "VARCHAR(16) NOT NULL DEFAULT '#5e35b1'");
CALL vesopa_add_column('bo_vouchers', 'button_size',     "VARCHAR(12) NOT NULL DEFAULT 'medium'");
CALL vesopa_add_column('bo_vouchers', 'button_label',    'VARCHAR(40) NULL');
CALL vesopa_add_column('bo_vouchers', 'icon',            'VARCHAR(16) NULL');
CALL vesopa_add_column('bo_vouchers', 'free_product_pluid', 'INT NULL');

-- Customers gain tier and lifetime spend, which is what tiers are computed from.
CALL vesopa_add_column('epos_customers', 'tier_name',        'VARCHAR(60) NULL');
CALL vesopa_add_column('epos_customers', 'lifetime_spend_minor', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_customers', 'visits',           'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_customers', 'last_visit',       'DATETIME NULL');
CALL vesopa_add_column('epos_customers', 'points_expire_on', 'DATE NULL');

-- Products gain the promo badge the till paints on the button.
CALL vesopa_add_column('bo_products', 'promo_badge',  'VARCHAR(40) NULL');
CALL vesopa_add_column('bo_products', 'promo_colour', 'VARCHAR(16) NULL');
CALL vesopa_add_column('bo_products', 'cost_price',   'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'low_stock_at', 'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'barcode',      'VARCHAR(64) NULL');
CALL vesopa_add_column('bo_products', 'active',       'TINYINT(1) NOT NULL DEFAULT 1');

-- Offices gain subscription and template fields for the super admin.
CALL vesopa_add_column('offices', 'template_id',      'INT NULL');
CALL vesopa_add_column('offices', 'monthly_fee_minor','INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('offices', 'billing_day',      'TINYINT NOT NULL DEFAULT 1');
CALL vesopa_add_column('offices', 'next_due_on',      'DATE NULL');
CALL vesopa_add_column('offices', 'is_demo',          'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('offices', 'trial_ends_on',    'DATE NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
