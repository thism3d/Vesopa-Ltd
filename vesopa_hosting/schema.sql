-- ---------------------------------------------------------------------------
-- vesopa_hostingdb — hosting.vesopaepos.com
--
-- Every CHAR/VARCHAR/TEXT column pins `COLLATE utf8mb4_general_ci` explicitly.
-- On the live MariaDB a bare `utf8mb4` resolves to `uca1400_ai_ci`, which does
-- not compare against `general_ci` — so an email column left bare joins fine on
-- a dev machine and silently matches nothing in production. That has bitten
-- this codebase before; the fix is to never write a bare VARCHAR again.
--
-- Idempotent: safe to run repeatedly. `vesopa_add_column` guards the ALTERs.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Guard procedure: add a column only if it is missing.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_ddl    TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_column)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Staff of the hosting business. Separate from the EPOS back office users:
-- a hosting admin is not an EPOS admin and must not become one by accident.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hosting_admins (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email          VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  name           VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  password_hash  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  role           ENUM('owner','admin','support') NOT NULL DEFAULT 'admin',
  active         TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at  DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hosting_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Customers. Email is the account: there are no usernames to forget.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  password_hash    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  first_name       VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  last_name        VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  company          VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  phone            VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  address1         VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  address2         VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  city             VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  postcode         VARCHAR(24)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  country          CHAR(2)      CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'GB',
  email_verified   TINYINT(1) NOT NULL DEFAULT 0,
  status           ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  -- Hestia usernames are short, lowercase and unique per node. Allocated at
  -- first provision and then never changed: it is the key the panel drives.
  hestia_user      VARCHAR(32)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  last_login_at    DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_email (email),
  UNIQUE KEY uq_customers_hestia (hestia_user),
  KEY idx_customers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Single-use tokens: email verification, password reset.
-- One table rather than two — same shape, same expiry logic, and a token that
-- can only ever do one thing is safer than a flag on the customer row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_tokens (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id  INT UNSIGNED NOT NULL,
  purpose      ENUM('verify','reset') NOT NULL,
  -- The token is stored hashed. A leaked database backup should not be a set of
  -- working password-reset links.
  token_hash   CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  expires_at   DATETIME NOT NULL,
  used_at      DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_tokens_hash (token_hash),
  KEY idx_customer_tokens_lookup (customer_id, purpose),
  CONSTRAINT fk_customer_tokens_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Hosting nodes. One row per HestiaCP box, so a second server is a row and
-- not a redeploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  hostname       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  ip             VARCHAR(45)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  api_port       INT UNSIGNED NOT NULL DEFAULT 8083,
  location       VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  -- Soft cap used by the allocator; not enforced by Hestia itself.
  max_accounts   INT UNSIGNED NOT NULL DEFAULT 200,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  notes          TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_servers_hostname (hostname)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Shared hosting plans. Priced in the database, not in code: unlike the EPOS
-- subscription plans there is no external billing object created from these,
-- so an admin editing a price cannot desynchronise anything already sold.
-- Prices are in pence, integer. Never float money.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug               VARCHAR(60)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  name               VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  tagline            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  monthly_pence      INT UNSIGNED NOT NULL,
  annual_pence       INT UNSIGNED NOT NULL,
  biennial_pence     INT UNSIGNED NOT NULL,
  -- Added after launch. DEFAULT 0 rather than NOT NULL with no default so the
  -- ALTER at the foot of this file can add it to a live table without a value
  -- for the rows already there; the seed then fills it.
  triennial_pence    INT UNSIGNED NOT NULL DEFAULT 0,
  -- What the customer gets. Rendered on the pricing table and enforced at
  -- provision time by the Hestia package these map onto.
  websites           INT UNSIGNED NOT NULL DEFAULT 1,
  storage_gb         INT UNSIGNED NOT NULL DEFAULT 10,
  bandwidth_gb       INT UNSIGNED NOT NULL DEFAULT 0,      -- 0 = unmetered
  `databases`        INT UNSIGNED NOT NULL DEFAULT 1,
  mailboxes          INT UNSIGNED NOT NULL DEFAULT 1,
  free_domain        TINYINT(1) NOT NULL DEFAULT 0,        -- on annual+ terms
  free_ssl           TINYINT(1) NOT NULL DEFAULT 1,
  daily_backups      TINYINT(1) NOT NULL DEFAULT 0,
  priority_support   TINYINT(1) NOT NULL DEFAULT 0,
  hestia_package     VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'default',
  -- Marketing copy, one bullet per line.
  features           TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  badge              VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  sort_order         INT NOT NULL DEFAULT 0,
  active             TINYINT(1) NOT NULL DEFAULT 1,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plans_slug (slug),
  KEY idx_plans_active (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Email plans — a separate product line from hosting.
--
-- A separate table rather than a `kind` column on `plans` because the two are
-- priced on different units and nothing generic could serve both: hosting is
-- priced per account for a term, email is priced PER MAILBOX per month. Bolting
-- a quantity onto `plans` would have left `websites`, `storage_gb` and
-- `hestia_package` meaningless on half the rows, and every query filtering on a
-- kind it forgot about.
--
-- Two families, distinguished by `family`:
--   business   — mailboxes at your own domain. Provisioned on the mail server.
--   marketing  — bulk sending: campaigns, lists, delivery reporting.
-- They share a table because they share a shape (per-unit, per-month, a feature
-- list, a sort order) and both appear in the same pricing grid.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_plans (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug               VARCHAR(60)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  family             ENUM('business','marketing') NOT NULL DEFAULT 'business',
  name               VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  tagline            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  -- Per unit, per month. The unit differs by family, which is why it is named
  -- rather than assumed: "mailbox" for business, "1,000 contacts" for marketing.
  unit_label         VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'mailbox',
  monthly_pence      INT UNSIGNED NOT NULL,
  annual_pence       INT UNSIGNED NOT NULL,
  -- What one unit buys.
  storage_gb         INT UNSIGNED NOT NULL DEFAULT 10,
  min_units          INT UNSIGNED NOT NULL DEFAULT 1,
  max_units          INT UNSIGNED NOT NULL DEFAULT 500,
  -- Marketing only: how many sends per month the price covers. 0 on business.
  monthly_sends      INT UNSIGNED NOT NULL DEFAULT 0,
  features           TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  badge              VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  sort_order         INT NOT NULL DEFAULT 0,
  active             TINYINT(1) NOT NULL DEFAULT 1,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_plans_slug (slug),
  KEY idx_email_plans_active (active, family, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- A bought email plan. The counterpart of `services` for the hosting side.
--
-- Deliberately NOT folded into `services`: that table's columns are about a web
-- account (hestia_user, primary_domain, disk usage) and its provisioning path
-- creates a Hestia user. An email subscription creates a mail domain and a set
-- of accounts, or — for marketing — nothing on our infrastructure at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_services (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id       INT UNSIGNED NOT NULL,
  email_plan_id     INT UNSIGNED NOT NULL,
  order_id          INT UNSIGNED NULL,
  domain            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  units             INT UNSIGNED NOT NULL DEFAULT 1,
  status            ENUM('pending','active','suspended','terminated') NOT NULL DEFAULT 'pending',
  term_months       SMALLINT UNSIGNED NOT NULL DEFAULT 12,
  price_pence       INT UNSIGNED NOT NULL DEFAULT 0,
  next_due_at       DATE NULL,
  notes             TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email_services_customer (customer_id, status),
  KEY idx_email_services_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Discount codes.
--
-- `used` is incremented at checkout inside the order transaction, so two people
-- racing for the last use of a limited code cannot both get it.
--
-- Money is pence and percentages are whole numbers; `kind` says which of
-- `value` means. A code that applies to one product line only carries
-- `applies_to`, because "20% off hosting" must not also take 20% off a domain
-- we buy in at cost.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  description    VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  kind           ENUM('percent','fixed') NOT NULL DEFAULT 'percent',
  value          INT UNSIGNED NOT NULL DEFAULT 0,   -- percent, or pence
  min_spend_pence INT UNSIGNED NOT NULL DEFAULT 0,
  applies_to     ENUM('all','hosting','domain','email') NOT NULL DEFAULT 'all',
  -- 0 = unlimited. First-order-only is the usual acquisition code.
  max_uses       INT UNSIGNED NOT NULL DEFAULT 0,
  used           INT UNSIGNED NOT NULL DEFAULT 0,
  first_order_only TINYINT(1) NOT NULL DEFAULT 0,
  starts_at      DATETIME NULL,
  expires_at     DATETIME NULL,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coupons_code (code),
  KEY idx_coupons_active (active, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Setup steps — what the customer watches after paying.
--
-- Provisioning used to happen in one silent call and the customer saw a page
-- that said "your account is being set up" for however long it took. This table
-- is the running commentary: each step is written as `running` when it starts
-- and updated when it finishes, and the onboarding screen polls for it.
--
-- Rows are per ORDER rather than per service because one order can create a
-- hosting account, a domain and a mailbox plan, and the customer thinks of all
-- of that as one thing being set up.
--
-- Deliberately its own table and not a JSON column on `orders`: a JSON blob
-- rewritten on every step update loses a concurrent write, and this is the one
-- place where two things genuinely are updating at once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS setup_steps (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id     INT UNSIGNED NOT NULL,
  step_key     VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  label        VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  status       ENUM('pending','running','ok','failed','skipped') NOT NULL DEFAULT 'pending',
  detail       VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  sort_order   INT NOT NULL DEFAULT 0,
  started_at   DATETIME NULL,
  finished_at  DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_setup_step (order_id, step_key),
  KEY idx_setup_order (order_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- TLD price list. The registrar's cost is recorded beside the sell price so
-- the margin is visible in the admin rather than worked out on a calculator.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tlds (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tld                VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  register_pence     INT UNSIGNED NOT NULL,
  renew_pence        INT UNSIGNED NOT NULL,
  transfer_pence     INT UNSIGNED NOT NULL,
  cost_pence         INT UNSIGNED NOT NULL DEFAULT 0,
  min_years          TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- Shown in the search results strip above the fold.
  featured           TINYINT(1) NOT NULL DEFAULT 0,
  active             TINYINT(1) NOT NULL DEFAULT 1,
  sort_order         INT NOT NULL DEFAULT 0,
  -- Which shelf this extension sits on in the browser: `business`, `tech`,
  -- `country` and so on. One category per TLD, not a tag list — the whole
  -- point of the filter is that every extension appears exactly once when you
  -- page through a category, and a .shop that is both `shop` and `business`
  -- would show up twice in one infinite scroll.
  category           VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'other',
  -- Free text shown on the extension's own page: who it is for, what the
  -- registry requires. Blank means the page falls back to a generated line.
  blurb              VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uq_tlds_tld (tld),
  KEY idx_tlds_featured (featured, sort_order),
  -- The catalogue browser's two hot paths: filter by shelf, and order by
  -- first-year price for the "under £2" bands.
  KEY idx_tlds_category (active, category, sort_order),
  KEY idx_tlds_register (active, register_pence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Orders. One row per checkout; the lines carry what was bought.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference        VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id      INT UNSIGNED NOT NULL,
  status           ENUM('pending','paid','provisioning','active','cancelled','refunded')
                     NOT NULL DEFAULT 'pending',
  -- When the order's services, domains and mailboxes were WRITTEN INTO THE
  -- ACCOUNT. Not the same thing as paid_at: paid_at says money arrived,
  -- activated_at says we acted on it. It is also the idempotency guard — the
  -- browser return and the IPN both try to activate, and the one that wins is
  -- the one whose UPDATE ... WHERE activated_at IS NULL changes a row.
  activated_at     DATETIME NULL,
  -- VAT is INCLUDED in the price, never added at the end:
  --     subtotal_pence + vat_pence = total_pence
  -- and total_pence is exactly what the customer was shown and pays.
  subtotal_pence   INT UNSIGNED NOT NULL DEFAULT 0,   -- net, ex-VAT
  vat_pence        INT UNSIGNED NOT NULL DEFAULT 0,   -- the VAT inside the total
  total_pence      INT UNSIGNED NOT NULL DEFAULT 0,   -- gross, what they pay
  -- What was knocked off, and why. Kept on the order so a refund or a query
  -- three months later does not need the basket rules re-run to explain a price.
  discount_pence   INT UNSIGNED NOT NULL DEFAULT 0,
  coupon_code      VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  currency         CHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'GBP',
  -- Free text until a gateway is wired; then the provider's own reference.
  payment_method   VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  payment_ref      VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  paid_at          DATETIME NULL,
  notes            TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_reference (reference),
  KEY idx_orders_customer (customer_id, created_at),
  KEY idx_orders_status (status),
  CONSTRAINT fk_orders_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- The lines of an order.
--
-- THESE ROWS ARE THE ONLY RECORD OF AN UNPAID ORDER, and they carry everything
-- needed to build the account from — the plan, the email plan, the term, the
-- units, and the free-domain entitlement as it stood at the moment of sale.
-- Nothing is created in `services`, `domains` or `email_services` until the
-- money arrives; see the note above provisioning.materialiseOrder().
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id       INT UNSIGNED NOT NULL,
  kind           ENUM('hosting','domain','domain_transfer','email','ssl','addon') NOT NULL,
  -- Human label as sold, frozen at purchase time. A plan renamed next year must
  -- not rewrite what an old invoice says was bought.
  description    VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  plan_id        INT UNSIGNED NULL,
  -- Email lines point at `email_plans`, which is a different table from
  -- `plans` — one column each rather than a polymorphic id, because a join
  -- that has to check `kind` first is a join somebody will forget to check.
  email_plan_id  INT UNSIGNED NULL,
  domain         VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  term_months    INT UNSIGNED NOT NULL DEFAULT 12,
  years          TINYINT UNSIGNED NOT NULL DEFAULT 1,
  unit_pence     INT UNSIGNED NOT NULL DEFAULT 0,
  qty            INT UNSIGNED NOT NULL DEFAULT 1,
  total_pence    INT UNSIGNED NOT NULL DEFAULT 0,
  -- The free-domain entitlement, decided by the basket and frozen here.
  -- `eligible` is what the customer was sold; `spent` means the basket already
  -- contained the domain it paid for, so the setup wizard must not offer a
  -- second one. Recomputing either at activation time would let an admin
  -- editing a plan change what somebody was sold last week.
  free_domain_eligible TINYINT(1) NOT NULL DEFAULT 0,
  free_domain_spent    TINYINT(1) NOT NULL DEFAULT 0,
  -- This domain line is the one the plan paid for; it registers for nothing.
  free_with_plan       TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Payment attempts.
--
-- One row per attempt, NOT one per order: a customer who abandons the gateway
-- and comes back is two rows, and the pair is the only record of what actually
-- happened. Overwriting a single row per order would lose the first attempt
-- and, with it, the answer to "they say they were charged twice".
--
-- TWO AMOUNTS, DELIBERATELY.
--
-- `amount_minor` / `currency` is what the ORDER says — sterling, dollars,
-- whatever the customer was quoted and what the invoice must show. `charged_minor`
-- / `charged_currency` is what the GATEWAY actually took, which for SSLCommerz
-- is taka. They are different numbers in different currencies and neither one
-- can be derived from the other after the fact, because the rate moves. A
-- refund is worked out from the charged pair; the invoice from the order pair.
--
-- `gateway_ref` is the provider's own transaction id and is UNIQUE: it is the
-- key the IPN and the browser return both arrive with, and the uniqueness is
-- what stops the two of them settling the same payment twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id          INT UNSIGNED NOT NULL,
  customer_id       INT UNSIGNED NOT NULL,
  -- sslcommerz | stripe | paypal | crypto | manual | free
  gateway           VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'sslcommerz',
  status            ENUM('pending','paid','failed','cancelled','refunded') NOT NULL DEFAULT 'pending',
  amount_minor      INT UNSIGNED NOT NULL DEFAULT 0,
  currency          CHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'GBP',
  charged_minor     INT UNSIGNED NOT NULL DEFAULT 0,
  charged_currency  CHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'BDT',
  -- The rate used to get from one to the other, frozen. Same reasoning as
  -- orders.fx_rate: re-deriving it next month rewrites history.
  fx_rate           DECIMAL(14,6) NOT NULL DEFAULT 1.000000,
  -- Ours, sent as order_ref. Theirs, returned as tran_id.
  order_ref         VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  gateway_ref       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  -- Card brand, wallet name, bank — whatever the provider tells us, for the
  -- admin to read. Never anything that could be a card number.
  method_detail     VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  -- The verified callback, kept verbatim for disputes. Written only after the
  -- signature check passes, so it is evidence rather than an open log.
  payload           TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  failure_reason    VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  settled_at        DATETIME NULL,
  -- The reconciler's own bookkeeping — see src/jobs.js.
  --
  -- A customer who pays and then closes the tab never hits the return URL, and
  -- not every gateway sends a server-to-server notification. So the server asks
  -- the gateway itself, on a timer, until the attempt is settled or its session
  -- is long dead. `expires_at` is when that session stops being worth asking
  -- about; `last_checked_at` and `checks` are what keep the polling honest
  -- across restarts instead of starting again from zero.
  expires_at        DATETIME NULL,
  last_checked_at   DATETIME NULL,
  checks            INT UNSIGNED NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_gateway_ref (gateway_ref),
  UNIQUE KEY uq_payments_order_ref (order_ref),
  KEY idx_payments_order (order_id, created_at),
  KEY idx_payments_status (status, created_at),
  CONSTRAINT fk_payments_order
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- A live hosting account. One per plan purchased.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id       INT UNSIGNED NOT NULL,
  plan_id           INT UNSIGNED NOT NULL,
  server_id         INT UNSIGNED NULL,
  order_id          INT UNSIGNED NULL,
  -- The site this account was bought for. Addon domains live in `domains`.
  primary_domain    VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  status            ENUM('pending','active','suspended','terminated') NOT NULL DEFAULT 'pending',
  term_months       INT UNSIGNED NOT NULL DEFAULT 12,
  price_pence       INT UNSIGNED NOT NULL DEFAULT 0,
  -- Advisory, exactly like the EPOS subscription rule: a lapsed date raises a
  -- flag in the admin and emails the customer. Suspension is a deliberate act,
  -- never a side effect of a date passing.
  next_due_at       DATE NULL,
  suspended_reason  VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  provisioned_at    DATETIME NULL,
  -- The free-domain entitlement, recorded on the SERVICE rather than worked out
  -- again later. The plan's flag or the term could be edited between the order
  -- and the customer claiming it, and what someone was sold must not change
  -- underneath them. `claimed` is what stops a second free domain being taken
  -- by anyone who reloads the setup screen.
  free_domain_eligible TINYINT(1) NOT NULL DEFAULT 0,
  free_domain_claimed  TINYINT(1) NOT NULL DEFAULT 0,
  -- Where the post-payment wizard has got to: domain -> provisioning -> done.
  setup_step        VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'domain',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_services_customer (customer_id, status),
  KEY idx_services_due (next_due_at),
  CONSTRAINT fk_services_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_services_plan
    FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Domains: registered with us, transferred in, or simply pointed at us.
--
-- `source` is the difference that matters, because the three are not the same
-- kind of object at all:
--
--   registered  we bought it at the registry on the customer's behalf. It is
--               theirs, it was paid for, and NOTHING in this app may delete it.
--   transfer    same, arriving from another registrar.
--   external    registered somewhere else entirely. The customer added it here
--               to host it with us, and we have no claim on it whatsoever —
--               which is exactly why an external domain that never points at
--               our nameservers is dropped from the account after the grace
--               period rather than sitting in a list forever.
--
-- A domain is only POINTED at our platform once its nameservers actually
-- resolve to ours. Until then it is `awaiting_ns`: visible to the customer,
-- with the nameservers to set and the deadline to set them by, and no web
-- domain, no mail domain and no certificate on the node.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domains (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id       INT UNSIGNED NOT NULL,
  service_id        INT UNSIGNED NULL,
  order_id          INT UNSIGNED NULL,
  domain            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  tld               VARCHAR(32)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  status            ENUM('pending','awaiting_ns','active','expired','transferred_away','cancelled','removed')
                      NOT NULL DEFAULT 'pending',
  -- `subdomain` is a name under a domain already on this account. It is never
  -- nameserver-checked and never swept: the parent is the thing that has to
  -- point at us, and a subdomain is reachable either through the parent's zone
  -- here or through an A record the customer adds at their own DNS provider.
  source            ENUM('registered','transfer','external','subdomain') NOT NULL DEFAULT 'registered',
  years             TINYINT UNSIGNED NOT NULL DEFAULT 1,
  auto_renew        TINYINT(1) NOT NULL DEFAULT 1,
  privacy           TINYINT(1) NOT NULL DEFAULT 1,
  registered_at     DATE NULL,
  expires_at        DATE NULL,
  -- The nameserver check: when it last ran, when it last passed, what the
  -- public DNS actually answered, and the moment an unverified EXTERNAL domain
  -- is dropped. `ns_grace_until` is written when the row is created so the
  -- deadline the customer is shown is the deadline that is enforced, rather
  -- than one recomputed from created_at by whichever job happens to run.
  ns_verified_at    DATETIME NULL,
  ns_checked_at     DATETIME NULL,
  ns_grace_until    DATETIME NULL,
  ns_observed       VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  -- When the zone and the web/mail domain were actually created on the node.
  pointed_at        DATETIME NULL,
  -- Which of the three a name actually got. A full domain gets all of them, so
  -- these default to on and describe it correctly. A SUBDOMAIN is the reason
  -- they exist: the website is compulsory, and DNS and mail are the customer's
  -- choice at the point they add it — a zone for `shop.example.com` is wrong
  -- unless the parent delegates to it, and a mail domain nobody asked for
  -- quietly starts accepting mail for a name.
  dns_enabled       TINYINT(1) NOT NULL DEFAULT 1,
  mail_enabled      TINYINT(1) NOT NULL DEFAULT 1,
  -- The registrar's own id for this domain, so a reconcile can match rows up.
  registrar_ref     VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  ns1               VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  ns2               VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  ns3               VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  ns4               VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_domains_domain (domain),
  KEY idx_domains_customer (customer_id, status),
  KEY idx_domains_expiry (expires_at),
  -- The sweep's own query: everything still waiting on a nameserver change,
  -- oldest check first.
  KEY idx_domains_ns (status, ns_checked_at),
  CONSTRAINT fk_domains_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Support tickets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference     VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id   INT UNSIGNED NOT NULL,
  subject       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  department    ENUM('support','billing','abuse') NOT NULL DEFAULT 'support',
  priority      ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
  status        ENUM('open','answered','customer_reply','closed') NOT NULL DEFAULT 'open',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tickets_reference (reference),
  KEY idx_tickets_customer (customer_id, status),
  KEY idx_tickets_status (status, updated_at),
  CONSTRAINT fk_tickets_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS ticket_messages (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id    INT UNSIGNED NOT NULL,
  author       ENUM('customer','staff') NOT NULL,
  author_name  VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  body         MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ticket_messages_ticket (ticket_id, created_at),
  CONSTRAINT fk_ticket_messages_ticket
    FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Contact-form enquiries from the public site.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enquiries (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  email       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  phone       VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  subject     VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  message     TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  ip          VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  handled     TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_enquiries_handled (handled, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Everything the panel does to a server, kept whether it succeeded or not.
-- When a customer says "my site went down last Tuesday", this is the answer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_type   ENUM('customer','admin','system') NOT NULL,
  actor_id     INT UNSIGNED NULL,
  action       VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  target       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  detail       TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  ok           TINYINT(1) NOT NULL DEFAULT 1,
  ip           VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_activity_actor (actor_type, actor_id, created_at),
  KEY idx_activity_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Editable site settings, so copy and switches change without a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  name        VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  value       TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Currencies.
--
-- The catalogue is priced ONCE, in GBP, in the `*_pence` columns above. This
-- table says how that base becomes a price in another currency, and every part
-- of it is editable in the admin because every part of it is a commercial
-- decision rather than a technical one.
--
-- `rate` is units of THIS currency per 1 GBP. It is a stored number, not a live
-- feed, and that is deliberate: a price that moves on its own is a price nobody
-- can quote, cache, screenshot or honour. An admin changes it when they decide
-- to, and every price on the site moves at that moment and not before.
--
-- `rounding` turns the arithmetic result into a price a human would actually
-- write. £5.99 at 1.27 is $7.6073, and no hosting company on earth charges
-- $7.61 — `charm99` makes it $7.99, which is both a real price and, once the
-- rate is set sensibly, the same margin.
--
-- `vat_percent` is per currency because VAT is a UK tax. A customer buying in
-- USD is outside the UK VAT net on these services, so their price carries no
-- VAT line at all rather than a UK one relabelled. See the note in config.js.
--
-- `countries` is the geo rule, comma-separated ISO-3166 alpha-2. Whichever
-- currency claims the visitor's country wins; the row flagged `is_default`
-- catches everyone else. Keeping it in a column rather than a `switch` in code
-- is what lets "and Ireland should see EUR" be a five-second admin edit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS currencies (
  code          CHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  name          VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  symbol        VARCHAR(8)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  -- Drives thousands separators and digit grouping only; the symbol above is
  -- always ours, because Intl renders CAD as "CA$" in one locale and "$" in
  -- another and a price list may not be ambiguous about which dollar it means.
  locale        VARCHAR(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'en-GB',
  -- Units of this currency per 1 GBP. 1.000000 on the base currency itself.
  rate          DECIMAL(14,6) NOT NULL DEFAULT 1.000000,
  -- exact | charm99 | charm95 | nearest50 | nearest100
  rounding      VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'charm99',
  vat_percent   DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  -- What the VAT line is called to this customer, blank for none.
  vat_label     VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  countries     VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  is_base       TINYINT(1) NOT NULL DEFAULT 0,
  is_default    TINYINT(1) NOT NULL DEFAULT 0,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  sort_order    INT NOT NULL DEFAULT 0,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (code),
  KEY idx_currencies_active (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Per-currency price overrides.
--
-- Conversion gets you a defensible price for every product in every currency
-- without anyone typing 200 numbers. This table is for the ones where the
-- converted answer is wrong — a plan pitched against a US competitor at $2.99,
-- a TLD whose wholesale cost is quoted to us in dollars and does not move with
-- the pound.
--
-- One row per field, rather than a column per field, so adding a fourth term or
-- a fifth product does not need a migration. `field` names the base column
-- WITHOUT the `_pence` suffix: monthly, annual, biennial, triennial, register,
-- renew, transfer, cost.
--
-- An override is an absolute amount in that currency's minor unit. It is not a
-- multiplier and it does not move when the rate does — that is the whole point
-- of setting one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_overrides (
  entity        ENUM('plan','email_plan','tld') NOT NULL,
  entity_id     INT UNSIGNED NOT NULL,
  currency      CHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  field         VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  amount_minor  INT UNSIGNED NOT NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (entity, entity_id, currency, field),
  KEY idx_price_overrides_currency (currency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Geo lookups, cached.
--
-- ipwho.is is called from the SERVER, once per address, and the answer is kept
-- here so a pm2 restart does not start the whole thing again. A visitor's
-- resolved currency also rides in a cookie, so the common case does not reach
-- this table either.
--
-- The IP is stored hashed, not raw. We need to recognise an address we have
-- already looked up; we do not need to be able to read back the list of every
-- address that has ever visited, and a table that cannot be read back is a
-- table that cannot leak. Hashing is with a per-install salt from .env.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_cache (
  ip_hash     CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  country     CHAR(2)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  currency    CHAR(3)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ip_hash),
  KEY idx_geo_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Migrations for a database that already exists.
--
-- Every CREATE above is IF NOT EXISTS, which means it does nothing at all to a
-- table that is already there — so a column added to this file after the first
-- deploy never reaches the live database. That is the failure this section
-- exists to prevent: the app would boot, and then 500 on the first query that
-- named the missing column.
--
-- Each step checks information_schema first, so the whole file stays idempotent
-- and re-running it is always safe.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_migrate;
DELIMITER //
CREATE PROCEDURE vesopa_migrate()
BEGIN
  -- 3-year term, added with the email product line.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plans'
       AND COLUMN_NAME = 'triennial_pence'
  ) THEN
    ALTER TABLE plans
      ADD COLUMN triennial_pence INT UNSIGNED NOT NULL DEFAULT 0 AFTER biennial_pence;
  END IF;

  -- 'email' added to the order line kinds. Re-stating the full ENUM is the only
  -- way to extend one; listing the existing members is not optional.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
       AND COLUMN_NAME = 'kind' AND COLUMN_TYPE LIKE '%email%'
  ) THEN
    ALTER TABLE order_items
      MODIFY COLUMN kind ENUM('hosting','domain','domain_transfer','email','ssl','addon') NOT NULL;
  END IF;

  -- Coupon and discount on the order.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'coupon_code'
  ) THEN
    ALTER TABLE orders
      ADD COLUMN discount_pence INT UNSIGNED NOT NULL DEFAULT 0 AFTER total_pence,
      ADD COLUMN coupon_code VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                 NOT NULL DEFAULT '' AFTER discount_pence;
  END IF;

  -- Post-payment onboarding: the free-domain entitlement and where the wizard
  -- has got to.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'services'
       AND COLUMN_NAME = 'free_domain_eligible'
  ) THEN
    ALTER TABLE services
      ADD COLUMN free_domain_eligible TINYINT(1) NOT NULL DEFAULT 0 AFTER provisioned_at,
      ADD COLUMN free_domain_claimed  TINYINT(1) NOT NULL DEFAULT 0 AFTER free_domain_eligible,
      ADD COLUMN setup_step VARCHAR(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                 NOT NULL DEFAULT 'domain' AFTER free_domain_claimed;
    -- Anything already provisioned before this existed is finished, not waiting
    -- at the first step of a wizard that did not exist when it was bought.
    UPDATE services SET setup_step = 'done' WHERE status <> 'pending';
  END IF;

  -- Multi-currency: what the order was actually taken in, and its worth in the
  -- base currency at the rate that applied THAT DAY.
  --
  -- base_total_pence is not a convenience — it is the only way the admin
  -- dashboard can add a $79 order to a £59 order and get an honest number.
  -- Re-converting an old order at today's rate would silently rewrite last
  -- quarter's revenue every time somebody edited the rate.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'fx_rate'
  ) THEN
    ALTER TABLE orders
      ADD COLUMN fx_rate DECIMAL(14,6) NOT NULL DEFAULT 1.000000 AFTER currency,
      ADD COLUMN base_total_pence INT UNSIGNED NOT NULL DEFAULT 0 AFTER fx_rate;
    -- Everything already placed was in GBP at parity, which is exactly what the
    -- defaults say, so only the base total needs filling in.
    UPDATE orders SET base_total_pence = total_pence WHERE base_total_pence = 0;
  END IF;

  -- A recurring price has to remember which currency it is, or the first
  -- renewal notice quotes a dollar figure with a pound sign in front of it.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'services'
       AND COLUMN_NAME = 'currency'
  ) THEN
    ALTER TABLE services
      ADD COLUMN currency CHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                 NOT NULL DEFAULT 'GBP' AFTER price_pence;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_services'
       AND COLUMN_NAME = 'currency'
  ) THEN
    ALTER TABLE email_services
      ADD COLUMN currency CHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                 NOT NULL DEFAULT 'GBP' AFTER price_pence;
  END IF;

  -- The catalogue browser: a shelf per extension, and a place to say what the
  -- extension is for. Added with the full DomainNameAPI rate card, which took
  -- the table from 23 rows to some 800 — at which point an unfiltered list is
  -- not a page anybody can use.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tlds'
       AND COLUMN_NAME = 'category'
  ) THEN
    ALTER TABLE tlds
      ADD COLUMN category VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                 NOT NULL DEFAULT 'other' AFTER sort_order,
      ADD COLUMN blurb VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                 NOT NULL DEFAULT '' AFTER category,
      ADD KEY idx_tlds_category (active, category, sort_order),
      ADD KEY idx_tlds_register (active, register_pence);
  END IF;

  -- Payment attempts. Before this, `orders.payment_ref` was the only record of
  -- a payment and an admin typed it in by hand.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
  ) THEN
    -- The CREATE TABLE above already made it on a fresh install; this branch
    -- only ever runs on a database that predates the gateway, and there the
    -- CREATE has just made it too. Left as a no-op guard so the section reads
    -- the same as every other step.
    SET @noop = 1;
  END IF;

  -- -------------------------------------------------------------------------
  -- Nothing is added to the account until the money arrives.
  --
  -- Services, domains and mailbox subscriptions used to be written at checkout,
  -- pending, whether or not the order was ever paid — so an unpaid order put a
  -- hosting account and a domain in the customer's panel, and a pending domain
  -- row took the unique index on a name nobody had bought. They are created at
  -- activation now, from the order lines, which is why the lines have to carry
  -- the email plan and the free-domain entitlement.
  -- -------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items'
       AND COLUMN_NAME = 'email_plan_id'
  ) THEN
    ALTER TABLE order_items
      ADD COLUMN email_plan_id INT UNSIGNED NULL AFTER plan_id,
      ADD COLUMN free_domain_eligible TINYINT(1) NOT NULL DEFAULT 0 AFTER total_pence,
      ADD COLUMN free_domain_spent    TINYINT(1) NOT NULL DEFAULT 0 AFTER free_domain_eligible,
      ADD COLUMN free_with_plan       TINYINT(1) NOT NULL DEFAULT 0 AFTER free_domain_spent;
    -- A line already sold at zero against a plan was the free domain. That is
    -- the only signal an old row carries, and it is the right one.
    UPDATE order_items SET free_with_plan = 1
     WHERE kind = 'domain' AND total_pence = 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'activated_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN activated_at DATETIME NULL AFTER paid_at;
    -- Anything already paid was already built into the account by the old
    -- checkout, so it is activated by definition. Without this the first run of
    -- the reconciler would try to create a second set of rows for every order
    -- ever placed.
    UPDATE orders SET activated_at = COALESCE(paid_at, updated_at)
     WHERE status IN ('paid','provisioning','active') AND activated_at IS NULL;

    /*
     * And clear out what the old checkout left in people's accounts.
     *
     * Every row deleted here belongs to an order that is STILL PENDING and was
     * never acted on — nothing provisioned, no account on the node, no domain
     * at the registry. They are exactly the rows checkout no longer writes, and
     * if any of those orders is ever paid, materialiseOrder() creates them
     * again from the order lines.
     *
     * The conditions are deliberately narrow. A service with a
     * `provisioned_at`, or a domain with a registrar reference or a
     * registration date, is a real thing somebody has and is left alone
     * whatever its order says.
     */
    -- A domain that is being KEPT must not be left pointing at a service that
    -- is about to go. `domains.service_id` carries no foreign key, so nothing
    -- would stop it becoming a dangling id.
    UPDATE domains d
      JOIN services s ON s.id = d.service_id
      JOIN orders   o ON o.id = s.order_id
       SET d.service_id = NULL
     WHERE o.status = 'pending' AND s.status = 'pending' AND s.provisioned_at IS NULL;

    DELETE s FROM services s
      JOIN orders o ON o.id = s.order_id
     WHERE o.status = 'pending' AND s.status = 'pending' AND s.provisioned_at IS NULL;

    DELETE e FROM email_services e
      JOIN orders o ON o.id = e.order_id
     WHERE o.status = 'pending' AND e.status = 'pending';

    DELETE d FROM domains d
      JOIN orders o ON o.id = d.order_id
     WHERE o.status = 'pending' AND d.status = 'pending'
       AND d.registrar_ref = '' AND d.registered_at IS NULL;
  END IF;

  -- The payment reconciler's bookkeeping.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
       AND COLUMN_NAME = 'last_checked_at'
  ) THEN
    ALTER TABLE payments
      ADD COLUMN expires_at      DATETIME NULL AFTER settled_at,
      ADD COLUMN last_checked_at DATETIME NULL AFTER expires_at,
      ADD COLUMN checks          INT UNSIGNED NOT NULL DEFAULT 0 AFTER last_checked_at;
  END IF;

  -- Nameserver verification, and the difference between a domain we sold and a
  -- domain somebody merely pointed at us.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'domains'
       AND COLUMN_NAME = 'source'
  ) THEN
    ALTER TABLE domains
      MODIFY COLUMN status ENUM('pending','awaiting_ns','active','expired','transferred_away','cancelled','removed')
             NOT NULL DEFAULT 'pending',
      ADD COLUMN source ENUM('registered','transfer','external') NOT NULL DEFAULT 'registered' AFTER status,
      ADD COLUMN ns_verified_at DATETIME NULL AFTER expires_at,
      ADD COLUMN ns_checked_at  DATETIME NULL AFTER ns_verified_at,
      ADD COLUMN ns_grace_until DATETIME NULL AFTER ns_checked_at,
      ADD COLUMN ns_observed VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                 NOT NULL DEFAULT '' AFTER ns_grace_until,
      ADD COLUMN pointed_at DATETIME NULL AFTER ns_observed,
      ADD KEY idx_domains_ns (status, ns_checked_at);
    -- Everything that predates this was registered through us and is live, so
    -- it is already pointed here — the sweep re-checks it on its own schedule
    -- and will correct anything that is not.
    UPDATE domains SET ns_verified_at = COALESCE(registered_at, created_at), pointed_at = created_at
     WHERE status = 'active';
  END IF;

  -- A gateway that settles in taka needs a taka rate, and the currencies table
  -- is where every rate in this app lives. INACTIVE on purpose: it is FX
  -- plumbing, not a currency anyone is offered at the top of the page.
  IF NOT EXISTS (SELECT 1 FROM currencies WHERE code = 'BDT') THEN
    INSERT INTO currencies
      (code, name, symbol, locale, rate, rounding, vat_percent, vat_label,
       countries, is_base, is_default, active, sort_order)
    VALUES
      ('BDT', 'Bangladeshi taka', '৳', 'en-BD', 149.000000, 'nearest100', 0.00, '',
       '', 0, 0, 0, 90);
  END IF;
END //
DELIMITER ;
CALL vesopa_migrate();
DROP PROCEDURE IF EXISTS vesopa_migrate;

-- ---------------------------------------------------------------------------
-- Repair pass: if an earlier run of this file created a column before the
-- collation was pinned, fix it in place rather than leaving a join that
-- silently matches nothing.
-- ---------------------------------------------------------------------------
-- A MODIFY built from COLUMN_TYPE alone silently drops NOT NULL and the
-- default — the repair would quietly loosen every column it touched. So
-- nullability and default are read back and reattached.
DROP PROCEDURE IF EXISTS vesopa_fix_collations;
DELIMITER //
CREATE PROCEDURE vesopa_fix_collations()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE t, c, ty VARCHAR(190);
  DECLARE nullable VARCHAR(3);
  DECLARE dflt TEXT;
  DECLARE extra VARCHAR(80);
  DECLARE cur CURSOR FOR
    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLLATION_NAME IS NOT NULL
       AND COLLATION_NAME <> 'utf8mb4_general_ci';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  fix: LOOP
    FETCH cur INTO t, c, ty, nullable, dflt, extra;
    IF done = 1 THEN LEAVE fix; END IF;

    SET @sql = CONCAT('ALTER TABLE `', t, '` MODIFY `', c, '` ', ty,
                      ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci',
                      IF(nullable = 'NO', ' NOT NULL', ' NULL'));

    -- COLUMN_DEFAULT arrives already quoted for literals on MariaDB 10.2+, and
    -- bare for expressions like CURRENT_TIMESTAMP, so it is spliced verbatim.
    IF dflt IS NOT NULL THEN
      SET @sql = CONCAT(@sql, ' DEFAULT ', dflt);
    END IF;
    IF extra IS NOT NULL AND extra <> '' THEN
      SET @sql = CONCAT(@sql, ' ', extra);
    END IF;

    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END LOOP;
  CLOSE cur;
END //
DELIMITER ;
-- ---------------------------------------------------------------------------
-- Columns added after the first release.
--
-- Guarded, so this file stays runnable against a database at any age. They live
-- here rather than in the CREATE TABLE above so that the table definitions keep
-- reading as the shape of the thing, and every later addition is in one place
-- with the reason it was needed.
-- ---------------------------------------------------------------------------

-- HOW a domain was proved to point at us, which is not a detail — it decides
-- what the panel may offer.
--
--   ns   delegated to our nameservers. We answer for the whole zone, so DNS is
--        ours to edit and MX is ours to set.
--   a    an A record aimed at this node while DNS stays at their provider. The
--        website and the certificate work exactly the same; the zone is not
--        ours, so the DNS editor is off and mail needs records THEY add.
--   ''   not proved yet.
--
-- A SUBDOMAIN can only ever be 'a'. Asking whether `shop.example.com` is
-- delegated to us is meaningless — a subdomain normally has no NS records at
-- all, so the nameserver check fails forever on a name that is working
-- perfectly. That mismatch is why the panel used to tell customers a live
-- subdomain was "waiting for your nameservers".
CALL vesopa_add_column('domains', 'verify_method', "ENUM('','ns','a') NOT NULL DEFAULT '' AFTER ns_observed");

-- What the A lookup actually answered, for the same reason ns_observed exists:
-- "we can see 3.72.113.21" lets a customer fix it in two minutes, where a bare
-- "not pointing here" sends them to support.
CALL vesopa_add_column('domains', 'ip_observed', "VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER verify_method");

-- The certificate.
--
-- This was computed and then thrown away: pointAtNode() asked for a certificate
-- and discarded the answer, so nothing recorded whether one existed, nothing
-- retried a failure, and the panel could not show a padlock or explain its
-- absence. `ssl_error` is kept verbatim because "the DNS challenge failed" and
-- "rate limited by Let's Encrypt" need completely different answers from us.
CALL vesopa_add_column('domains', 'ssl_status', "ENUM('none','active','failed') NOT NULL DEFAULT 'none'");
CALL vesopa_add_column('domains', 'ssl_issued_at', 'DATETIME NULL');
CALL vesopa_add_column('domains', 'ssl_checked_at', 'DATETIME NULL');
CALL vesopa_add_column('domains', 'ssl_error', "VARCHAR(300) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''");

CALL vesopa_fix_collations();
DROP PROCEDURE IF EXISTS vesopa_fix_collations;
