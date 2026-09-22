-- ---------------------------------------------------------------------------
-- Subscriptions and payment methods.
--
-- THE OWNER'S INSTRUCTION, and the boundary it draws:
--
--   "We have Google Pay Apple Pay Already, so we can add cards in the system of
--    the vesopa account but no need to add the card authorization feature right
--    now would do that later, keep the subscription option that's enough."
--
-- So: cards are RECORDED, never charged. There is no amount column that a
-- payment could be taken against, no gateway credential, and no code path from
-- here to money. A half-built payment path is the one that takes money by
-- accident, and the cheapest way not to build one is to leave out the fields it
-- would need.
--
-- What IS here is what the account page shows: which Vesopa products this person
-- pays for, what state each one is in, when it renews, and which card is on
-- file. Modelled on reference_design/…711 and …712 — grouped by state, product
-- tile, product name as a link, plan, then a status line.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

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
-- products — the things somebody can have a subscription to.
--
-- A table rather than an enum, for the same reason `application_auth_methods`
-- is: the list grows. EPOS, Kitchen, Display, Hosting, Domain, Email today, and
-- whatever is built next without a migration.
--
-- `mark` is the icon key the page draws — the same set the rest of the console
-- uses, so a product added here has a mark without an asset being uploaded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  name        VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  description VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  mark        VARCHAR(32)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'apps',
  tint        VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'slate',
  manage_url  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  sort        SMALLINT NOT NULL DEFAULT 100,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_product_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- subscriptions — one person's standing arrangement for one product.
--
-- `status` carries the group headings from the reference: active, cancelled,
-- expired, paused. `cancelled` and `expired` are DIFFERENT and the difference
-- matters to the person reading the page — cancelled means "you stopped it, and
-- it works until the date"; expired means "it ran out".
--
-- NO PRICE COLUMN, deliberately. `plan_label` is the words the page prints —
-- "Till × 3", "100 GB", "5 mailboxes" — because this table is a description of
-- what somebody has, not an invoice. Money lives in the billing system that
-- actually takes it, and giving this one an amount would invite a second source
-- of truth about what a customer owes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  user_id            INT UNSIGNED NOT NULL,
  product_id         INT UNSIGNED NOT NULL,
  organisation_id    INT UNSIGNED NULL,

  plan_label         VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  quantity           INT UNSIGNED NOT NULL DEFAULT 1,

  status             ENUM('active','cancelled','expired','paused','trialling') NOT NULL DEFAULT 'active',
  -- What the page prints under the plan. NULL where there is nothing to say —
  -- an invented date is worse than no date.
  renews_at          DATE NULL,
  ends_at            DATE NULL,
  started_at         DATE NULL,

  -- Which card is meant to pay for it, if one is on file. NULL is normal:
  -- plenty of these are invoiced, and a subscription with no card is not an
  -- error state.
  payment_method_id  INT UNSIGNED NULL,

  -- Set when a renewal has failed, so the account page can show the alert card
  -- from reference_design/…714 rather than a silently expiring product.
  needs_attention    TINYINT(1) NOT NULL DEFAULT 0,
  attention_note     VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_subscription_public (public_id),
  KEY idx_subscription_user (user_id, status),
  KEY idx_subscription_product (product_id),
  CONSTRAINT fk_sub_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sub_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- payment_methods — RECORDED, NEVER CHARGED.
--
-- READ THE COLUMN LIST AND NOTICE WHAT IS ABSENT. There is no PAN, no CVV, no
-- expiry-plus-number pair, and no gateway secret. What is here is exactly what
-- is needed to DRAW a saved card — the brand, the last four digits, the month
-- and year, and an opaque token belonging to whoever actually holds the card.
--
-- That is not caution for its own sake. Storing a card number puts this server
-- in PCI scope, and PCI scope on the box that also holds every Vesopa login is
-- a bad trade for a feature the owner explicitly deferred. When authorisation
-- is built, it will be built against the token and the money will move at the
-- gateway, not here.
--
-- Google Pay and Apple Pay are `wallet` rows: they have a brand and a last four
-- of the DEVICE account number, which is all either platform ever gives us.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id      CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  user_id        INT UNSIGNED NOT NULL,

  kind           ENUM('card','wallet','invoice') NOT NULL DEFAULT 'card',
  -- 'visa', 'mastercard', 'amex', 'google_pay', 'apple_pay'. A string rather
  -- than an enum because card schemes are somebody else's list.
  brand          VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  last4          CHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  exp_month      TINYINT UNSIGNED NULL,
  exp_year       SMALLINT UNSIGNED NULL,

  -- The gateway's own reference. Opaque here, and the only thing that could
  -- ever be used to take money — at the gateway, by code that does not exist
  -- yet and is not in this repository.
  provider       VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  provider_ref   VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  is_default     TINYINT(1) NOT NULL DEFAULT 0,
  removed_at     DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_public (public_id),
  KEY idx_payment_user (user_id, removed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- The six products, so the page is real rather than a placeholder.
--
-- Idempotent on the slug: re-running corrects the wording without duplicating
-- a row, and never resets somebody's subscription.
-- ---------------------------------------------------------------------------
INSERT INTO products (slug, name, description, mark, tint, manage_url, sort) VALUES
  ('epos',    'Vesopa EPOS',    'Tills, and the back office behind them.',      'till',  'brand',  'https://backoffice.vesopaepos.com/', 10),
  ('kitchen', 'Vesopa Kitchen', 'Kitchen screens and order routing.',           'apps',  'amber',  '', 20),
  ('display', 'Vesopa Display', 'Customer-facing displays.',                    'device','teal',   '', 30),
  ('menu',    'Vesopa Menu',    'The QR dine-in menu customers order from.',    'menu',  'pink',   'https://menu.vesopaepos.com/', 40),
  ('hosting', 'Vesopa Hosting', 'Websites and mailboxes on Vesopa Cloud.',      'cloud', 'blue',   'https://cloud.vesopa.com/', 50),
  ('domain',  'Vesopa Domains', 'Domain names, registered and renewed.',        'globe', 'violet', 'https://cloud.vesopa.com/', 60)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description),
  mark = VALUES(mark), tint = VALUES(tint),
  manage_url = VALUES(manage_url), sort = VALUES(sort);
