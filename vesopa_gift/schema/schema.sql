-- ===========================================================================
-- Vesopa Gift — its own database.
-- ===========================================================================
--
-- WHAT LIVES HERE AND WHAT DOES NOT
--
-- Everything about SELLING: which venues have a shop and how it is set up, the
-- designs and experiences on it, events and their tickets, every order, who it
-- was for and when it should arrive, refunds, and the staff console's sessions.
--
-- NOT the money that has been sold. A voucher, once paid for, is issued as a
-- gift card in the venue's EPOS through /api/integrations/gift, and its balance
-- lives there -- where the till spends it under a row lock. The line below
-- records which card it became and nothing more; there is no second balance to
-- drift from the first.
--
-- Tickets are the exception, because they are not money: a ticket is let in
-- once at a door, and the till never sees one. They live here.
--
-- RE-RUNNABLE, like every migration in this repository: the deploy applies it
-- every time. New columns go through vesopa_add_column at the bottom.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS gift_venues (
  office_id            INT          NOT NULL PRIMARY KEY,
  slug                 VARCHAR(60)  NOT NULL,
  -- The owner's switch. A venue with 0 has no shop at all: its address answers
  -- 404, not "coming soon".
  enabled              TINYINT(1)   NOT NULL DEFAULT 0,
  enabled_at           DATETIME     NULL,
  enabled_by           VARCHAR(190) NULL,

  amounts              VARCHAR(200) NOT NULL DEFAULT '2500,5000,7500,10000',
  allow_custom         TINYINT(1)   NOT NULL DEFAULT 1,
  min_minor            INT          NOT NULL DEFAULT 1000,
  max_minor            INT          NOT NULL DEFAULT 50000,
  validity_months      INT          NOT NULL DEFAULT 12,
  allow_schedule       TINYINT(1)   NOT NULL DEFAULT 1,
  schedule_max_days    INT          NOT NULL DEFAULT 183,
  terms                TEXT         NULL,
  notify_email         VARCHAR(190) NULL,

  -- Protection against stolen cards buying vouchers to spend within the hour.
  max_order_minor      INT          NOT NULL DEFAULT 50000,
  orders_per_email_day INT          NOT NULL DEFAULT 5,
  hold_over_minor      INT          NULL DEFAULT 25000,
  hold_hours           INT          NOT NULL DEFAULT 24,

  custom_domain        VARCHAR(190) NULL,

  -- What the EPOS said the venue looks like, kept so a shop page does not ask
  -- the back office on every request. Refreshed on a timer and on demand.
  name                 VARCHAR(160) NULL,
  brand_json           MEDIUMTEXT   NULL,
  brand_at             DATETIME     NULL,

  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gift_venue_slug (slug),
  UNIQUE KEY uq_gift_venue_domain (custom_domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Who may manage which venue, beyond the owner and support. Keyed by the
-- verified email a person signs in with, because that is what the owner knows
-- about them when he names them.
CREATE TABLE IF NOT EXISTS gift_staff (
  office_id   INT          NOT NULL,
  email       VARCHAR(190) NOT NULL,
  created_by  VARCHAR(190) NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (office_id, email),
  KEY idx_gift_staff_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_designs (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office_id   INT          NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  -- 'builtin:celebrate' for one of the four every shop starts with, or a file
  -- name under uploads/<office_id>/ for a venue's own.
  image       VARCHAR(255) NOT NULL,
  -- Which ink the name and amount are printed in on this picture.
  ink         VARCHAR(8)   NOT NULL DEFAULT 'dark',
  on_sale     TINYINT(1)   NOT NULL DEFAULT 1,
  sort        INT          NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_gift_design_office (office_id, on_sale, sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- An experience: a voucher for one named thing at a fixed price.
CREATE TABLE IF NOT EXISTS gift_products (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office_id    INT          NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(500) NULL,
  price_minor  INT          NOT NULL,
  design_id    INT          NULL,
  on_sale      TINYINT(1)   NOT NULL DEFAULT 1,
  sort         INT          NOT NULL DEFAULT 0,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_gift_product_office (office_id, on_sale, sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_events (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office_id     INT          NOT NULL,
  public_id     CHAR(12)     NOT NULL,
  title         VARCHAR(140) NOT NULL,
  description   TEXT         NULL,
  starts_at     DATETIME     NOT NULL,
  ends_at       DATETIME     NULL,
  doors_at      DATETIME     NULL,
  location      VARCHAR(140) NULL,
  image         VARCHAR(255) NULL,
  capacity      INT          NOT NULL,
  on_sale       TINYINT(1)   NOT NULL DEFAULT 1,
  sales_end_at  DATETIME     NULL,
  cancelled_at  DATETIME     NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gift_event_public (public_id),
  KEY idx_gift_event_office (office_id, starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_ticket_types (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id     INT          NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(255) NULL,
  price_minor  INT          NOT NULL,
  -- NULL: shares the event's capacity with every other type.
  capacity     INT          NULL,
  on_sale      TINYINT(1)   NOT NULL DEFAULT 1,
  sort         INT          NOT NULL DEFAULT 0,
  KEY idx_gift_tt_event (event_id, sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_orders (
  id               INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- What goes in a URL. Random, so one buyer cannot walk to the next order.
  public_id        CHAR(24)     NOT NULL,
  office_id        INT          NOT NULL,
  kind             VARCHAR(12)  NOT NULL,
  -- pending | paid | cancelled | failed | refunded
  status           VARCHAR(12)  NOT NULL DEFAULT 'pending',
  buyer_name       VARCHAR(120) NOT NULL,
  buyer_email      VARCHAR(190) NOT NULL,
  total_minor      INT          NOT NULL,
  refunded_minor   INT          NOT NULL DEFAULT 0,
  intent_id        VARCHAR(64)  NULL,
  pay_source       VARCHAR(16)  NULL,
  sandbox          TINYINT(1)   NOT NULL DEFAULT 0,
  -- When Dojo was last asked about this payment, so the sweep does not ask
  -- about one order every thirty seconds for two hours.
  checked_at       DATETIME     NULL,
  card_brand       VARCHAR(40)  NULL,
  card_last4       CHAR(4)      NULL,
  paid_at          DATETIME     NULL,
  fulfilled_at     DATETIME     NULL,
  receipt_sent_at  DATETIME     NULL,
  venue_told_at    DATETIME     NULL,
  ip               VARCHAR(45)  NULL,
  expires_at       DATETIME     NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gift_order_public (public_id),
  KEY idx_gift_order_office (office_id, created_at),
  KEY idx_gift_order_status (status, created_at),
  KEY idx_gift_order_buyer (buyer_email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_order_lines (
  id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id           INT          NOT NULL,
  line_no            INT          NOT NULL,
  -- voucher | experience | ticket
  kind               VARCHAR(12)  NOT NULL,
  product_id         INT          NULL,
  event_id           INT          NULL,
  ticket_type_id     INT          NULL,
  label              VARCHAR(160) NOT NULL,
  unit_minor         INT          NOT NULL,
  quantity           INT          NOT NULL DEFAULT 1,
  design_id          INT          NULL,
  -- recipient | buyer
  send_to            VARCHAR(10)  NOT NULL DEFAULT 'buyer',
  recipient_name     VARCHAR(120) NULL,
  recipient_email    VARCHAR(190) NULL,
  message            VARCHAR(300) NULL,
  -- NULL means as soon as it is paid for.
  deliver_at         DATETIME     NULL,
  delivered_at       DATETIME     NULL,
  delivery_attempts  INT          NOT NULL DEFAULT 0,
  delivery_error     VARCHAR(255) NULL,
  -- After a failed send, not before this. Each failure waits longer.
  next_try_at        DATETIME     NULL,
  -- The gift card this became, in the venue's EPOS.
  card_id            CHAR(36)     NULL,
  card_code          VARCHAR(20)  NULL,
  expires_on         DATE         NULL,
  usable_from        DATETIME     NULL,
  wallet_url         VARCHAR(700) NULL,
  -- What the recipient's "view your voucher" link carries.
  view_token         CHAR(32)     NULL,
  voided_at          DATETIME     NULL,
  refunded_minor     INT          NOT NULL DEFAULT 0,
  UNIQUE KEY uq_gift_line_token (view_token),
  KEY idx_gift_line_order (order_id, line_no),
  KEY idx_gift_line_due (delivered_at, deliver_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_tickets (
  id              INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id        INT          NOT NULL,
  line_id         INT          NOT NULL,
  event_id        INT          NOT NULL,
  ticket_type_id  INT          NOT NULL,
  seq             INT          NOT NULL,
  code            CHAR(9)      NOT NULL,
  holder_name     VARCHAR(120) NULL,
  -- valid | used | void
  status          VARCHAR(8)   NOT NULL DEFAULT 'valid',
  checked_in_at   DATETIME     NULL,
  checked_in_by   VARCHAR(190) NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gift_ticket_code (code),
  UNIQUE KEY uq_gift_ticket_line (line_id, seq),
  KEY idx_gift_ticket_event (event_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_refunds (
  id               INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id         INT          NOT NULL,
  line_id          INT          NULL,
  amount_minor     INT          NOT NULL,
  reason           VARCHAR(255) NULL,
  idempotency_key  CHAR(36)     NOT NULL,
  dojo_refund_id   VARCHAR(80)  NULL,
  -- started | done | failed
  status           VARCHAR(10)  NOT NULL DEFAULT 'started',
  error            VARCHAR(255) NULL,
  created_by       VARCHAR(190) NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gift_refund_key (idempotency_key),
  KEY idx_gift_refund_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- The console's sessions. The cookie holds a random token; this holds its hash,
-- so a copy of the table is not a set of working sessions.
CREATE TABLE IF NOT EXISTS gift_sessions (
  id          CHAR(64)     NOT NULL PRIMARY KEY,
  sub         VARCHAR(80)  NOT NULL,
  email       VARCHAR(190) NULL,
  name        VARCHAR(120) NULL,
  roles       VARCHAR(120) NOT NULL DEFAULT '',
  csrf        CHAR(32)     NOT NULL,
  ip          VARCHAR(45)  NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME     NOT NULL,
  revoked_at  DATETIME     NULL,
  KEY idx_gift_session_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- A buyer signed in to the shop with their Vesopa account, to see what they
-- have bought and been given. The same shape as the console's sessions, in a
-- table of its own: a customer's cookie must never be mistaken for a staff one.
CREATE TABLE IF NOT EXISTS gift_customer_sessions (
  id          CHAR(64)     NOT NULL PRIMARY KEY,
  sub         VARCHAR(80)  NOT NULL,
  email       VARCHAR(190) NOT NULL,
  name        VARCHAR(120) NULL,
  csrf        CHAR(32)     NOT NULL,
  ip          VARCHAR(45)  NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME     NOT NULL,
  revoked_at  DATETIME     NULL,
  KEY idx_gift_customer_session_expiry (expires_at),
  KEY idx_gift_customer_session_sub (sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS gift_audit (
  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor      VARCHAR(190) NULL,
  office_id  INT          NULL,
  action     VARCHAR(60)  NOT NULL,
  detail     TEXT         NULL,
  KEY idx_gift_audit_office (office_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Columns added after the tables above first went live go here, guarded.
-- ---------------------------------------------------------------------------

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

-- The banner across the top of a venue's shop: a file under uploads/<office_id>/,
-- or NULL for the back office's own banner, or Vesopa's default when there is none.
CALL vesopa_add_column('gift_venues', 'hero_image', 'VARCHAR(120) NULL AFTER custom_domain');
-- The Vesopa account that placed the order, when the buyer was signed in.
CALL vesopa_add_column('gift_orders', 'account_sub', 'VARCHAR(80) NULL AFTER ip');
-- Reminders sent once: a voucher's expiry warning, an event's day-before note.
CALL vesopa_add_column('gift_order_lines', 'expiry_warned_at', 'DATETIME NULL');
CALL vesopa_add_column('gift_orders', 'reminded_at', 'DATETIME NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- The public page at gift.vesopa.com: its plans, prices and links, one JSON
-- row edited from the console at /admin/website. Absent, the page shows the
-- defaults in src/site.js.
CREATE TABLE IF NOT EXISTS gift_site_settings (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  content     LONGTEXT     NOT NULL,
  updated_by  VARCHAR(190) NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
