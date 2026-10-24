-- Vesopa EPOS subscriptions billed through Dojo (2026-10-24).
--
-- A venue starts a 14-day trial on vesopaepos.com/trial with a £1 card check
-- on Dojo's checkout, refunded at once (owner, 2026-10-24). The first charge
-- and every renewal are a Dojo pay link (card, Apple Pay, Google Pay) emailed
-- before the due date, until Dojo switches recurring card-on-file on for the
-- Vesopa account. A failed or unpaid charge is retried 3 times over 7 days,
-- with an email each time; then the subscription is suspended and
-- admin.vesopa.com pauses the venue's tills with a grace period.
--
-- Everything is CREATE TABLE IF NOT EXISTS: safe to apply again.

CREATE TABLE IF NOT EXISTS web_subscriptions (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  public_id          CHAR(24)     NOT NULL,
  venue_name         VARCHAR(160) NOT NULL,
  contact_name       VARCHAR(120) NULL,
  email              VARCHAR(190) NOT NULL,
  phone              VARCHAR(40)  NULL,

  plan_slug          VARCHAR(64)  NOT NULL,
  plan_name          VARCHAR(120) NOT NULL,
  period_months      INT          NOT NULL,
  -- Money in pence, ex VAT. first_term = the plan's introductory price,
  -- renewal = the listed price for later terms.
  first_term_minor   INT          NOT NULL,
  renewal_minor      INT          NOT NULL,
  addons_json        TEXT         NULL,          -- [{key,name,qty,monthly_minor}]
  addons_minor       INT          NOT NULL DEFAULT 0,   -- per term
  setup_fee_minor    INT          NOT NULL DEFAULT 0,
  vat_rate_bp        INT          NOT NULL DEFAULT 2000, -- 20.00%

  status             VARCHAR(20)  NOT NULL DEFAULT 'pending_card',
     -- pending_card | trial | active | past_due | suspended | cancelled | ended
  trial_ends_at      DATETIME     NULL,
  period_start       DATETIME     NULL,
  period_end         DATETIME     NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  cancelled_at       DATETIME     NULL,
  suspended_at       DATETIME     NULL,

  dojo_mode          VARCHAR(10)  NOT NULL DEFAULT 'sandbox',  -- sandbox | live
  setup_intent_id    VARCHAR(80)  NULL,   -- kept for Dojo recurring card-on-file later
  verify_intent_id   VARCHAR(80)  NULL,   -- the £1 card check at sign-up, refunded at once
  card_label         VARCHAR(60)  NULL,

  venue_id           INT          NULL,   -- the back office venue, once linked in admin.vesopa.com
  notes              TEXT         NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_web_sub_public (public_id),
  INDEX idx_web_sub_status (status),
  INDEX idx_web_sub_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS web_sub_invoices (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  subscription_id    INT          NOT NULL,
  number             VARCHAR(24)  NOT NULL,
  kind               VARCHAR(16)  NOT NULL,   -- first | renewal
  period_start       DATETIME     NOT NULL,
  period_end         DATETIME     NOT NULL,
  net_minor          INT          NOT NULL,
  vat_minor          INT          NOT NULL,
  total_minor        INT          NOT NULL,
  lines_json         TEXT         NOT NULL,
  status             VARCHAR(16)  NOT NULL DEFAULT 'open',   -- open | paid | failed | void | refunded
  due_at             DATETIME     NOT NULL,
  attempts           INT          NOT NULL DEFAULT 0,
  next_attempt_at    DATETIME     NULL,
  last_error         VARCHAR(255) NULL,
  payment_intent_id  VARCHAR(80)  NULL,
  pay_url            VARCHAR(255) NULL,
  paid_at            DATETIME     NULL,
  refunded_minor     INT          NOT NULL DEFAULT 0,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_web_sub_inv_number (number),
  INDEX idx_web_sub_inv_sub (subscription_id),
  INDEX idx_web_sub_inv_due (status, next_attempt_at),
  INDEX idx_web_sub_inv_pi (payment_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS web_sub_events (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  subscription_id    INT          NOT NULL,
  kind               VARCHAR(40)  NOT NULL,
  detail             VARCHAR(500) NULL,
  actor              VARCHAR(190) NULL,     -- 'system', 'customer' or the admin's email
  at                 TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_web_sub_ev_sub (subscription_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Added after the first draft: a database that already has the table gets the column too.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'web_subscriptions' AND COLUMN_NAME = 'verify_intent_id');
SET @q := IF(@c = 0, 'ALTER TABLE web_subscriptions ADD COLUMN verify_intent_id VARCHAR(80) NULL AFTER setup_intent_id', 'SELECT 1');
PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;
