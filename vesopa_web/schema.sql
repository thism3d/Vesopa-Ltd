-- vesopaepos.com — tables the public site and its admin panel own.
--
-- Everything here is CREATE TABLE IF NOT EXISTS, so applying it to the live
-- database is a no-op once it has run. It does not touch any of the till or
-- back-office tables owned by vesopa_server.
--
-- Every table pins COLLATE=utf8mb4_general_ci explicitly rather than trusting
-- "DEFAULT CHARSET=utf8mb4" to pick it: that default depends on the server,
-- not the charset. This project's dev database resolves it to
-- utf8mb4_general_ci; the live server resolves the exact same bare charset to
-- utf8mb4_uca1400_ai_ci. The two do not compare against each other — see
-- schema_admin.sql for the "Illegal mix of collations" that surfaced once
-- backoffice_users (created here, by this same unpinned default) was joined
-- against a table on the other collation. Pinning it here means a fresh
-- install can never reproduce that on day one.

-- ---------------------------------------------------------------------------
-- Enquiry forms
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_message (
  id             INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  timeadded      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  name           VARCHAR(255),
  email          VARCHAR(255),
  phone          VARCHAR(255),
  message        VARCHAR(5000),
  comment        VARCHAR(1000),
  INDEX idx_customer_message_time (timeadded)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS demo_request (
  id             INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  timeadded      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  name           VARCHAR(255),
  email          VARCHAR(255),
  phone          VARCHAR(255),
  business_name  VARCHAR(512),
  business_brief VARCHAR(2000),
  -- 'Y' once an admin has approved it and created the back-office account.
  approved       CHAR(1) NOT NULL DEFAULT 'N',
  INDEX idx_demo_request_approved (approved),
  INDEX idx_demo_request_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS career_request (
  id             INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  timeadded      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  name           VARCHAR(255),
  email          VARCHAR(255),
  phone          VARCHAR(255),
  company        VARCHAR(512),
  description    VARCHAR(2000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS training_request (
  id             INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  timeadded      TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  name           VARCHAR(255),
  email          VARCHAR(255),
  phone          VARCHAR(255),
  company        VARCHAR(512),
  booking_time   DATETIME NULL,
  message        VARCHAR(2000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

-- Businesses approved off the back of a demo request. This is the row the back
-- office (vesopa_server) authenticates against.
CREATE TABLE IF NOT EXISTS backoffice_users (
  id             INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  timeadded      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  email          VARCHAR(255) NOT NULL,
  password       VARCHAR(255) NOT NULL,
  name           VARCHAR(255),
  company        VARCHAR(512),
  approved       CHAR(1) NOT NULL DEFAULT 'N',
  UNIQUE KEY uq_backoffice_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Staff logins for /admin on this site. Distinct from back-office users.
CREATE TABLE IF NOT EXISTS admin_table (
  id             INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  dateadded      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fullname       VARCHAR(255) NOT NULL,
  username       VARCHAR(64) NOT NULL,
  -- bcrypt. Rows carried over from the PHP site hold plaintext and are
  -- re-hashed in place the first time that admin logs in successfully.
  password       VARCHAR(255) NOT NULL,
  public_key     VARCHAR(255),
  country        VARCHAR(128),
  -- 'Admin' can manage other admins; 'Subadmin' cannot.
  status         VARCHAR(32) NOT NULL DEFAULT 'Subadmin',
  enabled        CHAR(1) NOT NULL DEFAULT 'Y',
  UNIQUE KEY uq_admin_table_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
--
-- New. The PHP checkout had every one of its INSERTs commented out, so a
-- completed PayPal payment was verified and then thrown away: nothing was
-- recorded and the customer was never redirected to a receipt. These two tables
-- are what makes that flow finish.

CREATE TABLE IF NOT EXISTS paypal_subscriptions (
  id                INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  created           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- Our own opaque handle, the only id ever put in a URL.
  reference         CHAR(32) NOT NULL,
  period_months     INTEGER NOT NULL,
  plan_name         VARCHAR(255),
  paypal_order_id   VARCHAR(64),
  paypal_plan_id    VARCHAR(64),
  paypal_subscr_id  VARCHAR(64) NOT NULL,
  valid_from        DATETIME NULL,
  valid_to          DATETIME NULL,
  paid_amount       DECIMAL(10,2),
  currency_code     VARCHAR(8),
  payer_id          VARCHAR(64),
  payer_name        VARCHAR(255),
  payer_email       VARCHAR(255),
  -- The email the customer typed on the checkout page; the one their EPOS
  -- account will be created under, which is often not their PayPal address.
  account_email     VARCHAR(255),
  status            VARCHAR(32),
  UNIQUE KEY uq_paypal_subscriptions_reference (reference),
  -- Makes re-posting the same approval idempotent rather than double-booking.
  UNIQUE KEY uq_paypal_subscriptions_subscr (paypal_subscr_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS paypal_transactions (
  id                INTEGER PRIMARY KEY AUTO_INCREMENT NOT NULL,
  created           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reference         CHAR(32) NOT NULL,
  period_months     INTEGER NOT NULL,
  plan_name         VARCHAR(255),
  paypal_order_id   VARCHAR(64) NOT NULL,
  transaction_id    VARCHAR(64),
  paid_amount       DECIMAL(10,2),
  currency_code     VARCHAR(8),
  payment_source    VARCHAR(64),
  payer_id          VARCHAR(64),
  payer_name        VARCHAR(255),
  payer_email       VARCHAR(255),
  payer_country     VARCHAR(8),
  account_email     VARCHAR(255),
  status            VARCHAR(32),
  UNIQUE KEY uq_paypal_transactions_reference (reference),
  UNIQUE KEY uq_paypal_transactions_order (paypal_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
