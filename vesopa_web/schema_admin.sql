-- Tables behind the /admin panel.
--
-- Run once against vesopa_eposdb:
--     mysql vesopa_eposdb < schema_admin.sql
--
-- Every statement is guarded so re-running is safe. The ALTERs use the
-- information_schema dance rather than "ADD COLUMN IF NOT EXISTS" because
-- MariaDB and MySQL disagree about that syntax and this database is shared
-- with vesopa_server, which has to keep working on both.

-- ---------------------------------------------------------------------------
-- Collation drift on backoffice_users.email
--
-- First, deliberately. `mysql <file` stops at the first error by default, so
-- anything below this point is skipped if an earlier statement fails — and this
-- is the one statement in the file that fixes a screen that is already broken.
-- It ran last once, the run stopped short of it, and /admin/users kept 500ing
-- on a database that looked fully migrated.
--
-- This database has grown three collations. Most of the legacy tables are
-- utf8_general_ci, the newer epos_* and tenancy tables are utf8mb4_general_ci,
-- and exactly one column — backoffice_users.email — is utf8_unicode_ci.
--
-- utf8_general_ci and utf8mb4_general_ci compare fine (MySQL widens one side).
-- utf8_general_ci against utf8_unicode_ci does not: it is an "Illegal mix of
-- collations" error, which is what any query joining backoffice_users to
-- bo_clarks on email hits. That join is the admin's users list.
--
-- Bringing the one outlier in line with the tables it is joined against, rather
-- than converting the whole database, which would rewrite the till's tables for
-- a problem confined to this column. utf8mb4 also means an address with an
-- emoji or an astral-plane character stores instead of erroring.
--
-- 255 × 4 bytes = 1020 for the UNIQUE index, well inside InnoDB's 3072 limit.
-- Re-running is a no-op rewrite, not an error.
ALTER TABLE backoffice_users
  MODIFY email VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

-- ---------------------------------------------------------------------------
-- Collation drift, round two: offices, demo_request, epos_orders
--
-- The first run of this file got further than the note above suggests and hit
-- a *different* illegal mix: (utf8mb4_general_ci,IMPLICIT) and
-- (utf8mb4_uca1400_ai_ci,IMPLICIT), on the office/backoffice_users backfill
-- below. utf8mb4_uca1400_ai_ci is not a legacy artifact — it is this server's
-- default collation for utf8mb4 columns declared with no explicit COLLATE.
-- `demo_request` was created that way (see schema.sql: "DEFAULT CHARSET=utf8mb4"
-- with no COLLATE), and `offices.contact_email` and `epos_orders.email`
-- evidently were too. On a differently-configured MariaDB — this developer's
-- machine, for one — the same bare "utf8mb4" default lands on
-- utf8mb4_general_ci instead, which is why this was invisible until it ran
-- here, and why an earlier version of this comment claimed epos_orders was
-- already fine. It was checked against the live server, not assumed: it
-- was not fine.
--
-- Unlike the utf8/utf8mb4 case above, general_ci and uca1400_ai_ci do not
-- widen into each other — they are unrelated collations on the same charset —
-- so there is no cheap side to widen and every affected column has to move.
-- Left alone, columns that already agree with each other keep working (that's
-- why `demo_request.email = offices.contact_email` succeeded on the first,
-- partial run) but every join against backoffice_users.email or
-- bo_clarks.email — both utf8mb4_general_ci, or the utf8mb3 equivalent —
-- keeps failing. Moving the rest into that group is what the admin panel
-- already assumes throughout: dashboard.js's "busiest sites" query joins
-- epos_orders.email to offices.contact_email directly.
--
-- offices and epos_orders are tables this project does not define the DDL
-- for, so their columns' exact VARCHAR length is not something to guess at:
-- MODIFY restates the whole type, and a guessed length that is too short
-- truncates live data. vesopa_fix_collation reads COLUMN_TYPE and IS_NULLABLE
-- from information_schema first and rebuilds the ALTER from those, so the
-- only thing that changes is the collation.
--
-- epos_orders is the one genuinely large table in this list once the till is
-- taking real sales — an in-place collation change there is a full table
-- rebuild, not a metadata-only change, and doing that against a live
-- transaction table is not something to do without checking its size first.
-- It is safe today only because nothing has gone live yet (a few dozen rows).
-- The good news is this does not need re-checking before every future run:
-- vesopa_fix_collation no-ops once a column already reads utf8mb4_general_ci,
-- so it can never fire again against this table once it has fired the one
-- time it needed to — the day this migration first reaches the live server,
-- while epos_orders is still empty.
DROP PROCEDURE IF EXISTS vesopa_fix_collation;
DELIMITER $$
CREATE PROCEDURE vesopa_fix_collation(IN tbl VARCHAR(64), IN col VARCHAR(64))
BEGIN
  DECLARE cur_collation VARCHAR(64);
  DECLARE col_type VARCHAR(128);
  DECLARE nullable VARCHAR(3);

  SELECT COLLATION_NAME, COLUMN_TYPE, IS_NULLABLE
    INTO cur_collation, col_type, nullable
    FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = tbl AND column_name = col
   LIMIT 1;

  IF cur_collation IS NOT NULL AND cur_collation <> 'utf8mb4_general_ci' THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` MODIFY COLUMN `', col, '` ',
                     col_type, ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci ',
                     IF(nullable = 'YES', 'NULL', 'NOT NULL'));
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL vesopa_fix_collation('offices', 'contact_email');
CALL vesopa_fix_collation('demo_request', 'email');
CALL vesopa_fix_collation('epos_orders', 'email');

DROP PROCEDURE IF EXISTS vesopa_fix_collation;

-- ---------------------------------------------------------------------------
-- Packages
--
-- The pricing table used to live in src/config.js, on the argument that a price
-- editable without a deploy could drift out of step with a PayPal plan already
-- billing a customer. It cannot, and the reason is worth writing down: PayPal
-- plans are created at checkout time and bill against the figures they were
-- created with, and each office stores its own monthly_fee_minor. So editing a
-- row here changes what *new* customers are quoted and nothing else. Existing
-- subscribers keep the price they signed up at until an admin changes it on
-- their office. is_archived exists so a retired package stays resolvable for
-- the offices still on it instead of being deleted out from under them.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS web_plans (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  slug                  VARCHAR(64)  NOT NULL,
  name                  VARCHAR(120) NOT NULL,

  -- How long one purchase covers. 3 is the quarterly term Vesopa actually sells.
  period_months         INT NOT NULL,

  -- What PayPal is told to bill, which is not always the same shape as the
  -- term: a 24-month plan is "every 2 years", not "every 24 months".
  interval_label        VARCHAR(32) NOT NULL DEFAULT 'Month',
  interval_count        INT NOT NULL DEFAULT 1,

  -- All money in minor units (pence). Decimals in a price column eventually
  -- produce a 0.005 rounding argument with a customer.
  price_per_month_minor INT NOT NULL,
  total_minor           INT NOT NULL,
  discounted_minor      INT NOT NULL,
  vat_minor             INT NOT NULL DEFAULT 0,
  total_with_vat_minor  INT NOT NULL,
  save_percentage       INT NOT NULL DEFAULT 0,
  currency              CHAR(3) NOT NULL DEFAULT 'GBP',

  blurb                 VARCHAR(500) NULL,
  -- One feature per line. A JSON column would need a migration to add a
  -- feature; the admin edits this as a textarea.
  features              TEXT NULL,

  is_popular            TINYINT(1) NOT NULL DEFAULT 0,
  is_active             TINYINT(1) NOT NULL DEFAULT 1,
  -- The plan an office gets when the admin does not pick one.
  is_default            TINYINT(1) NOT NULL DEFAULT 0,
  -- Archived rows keep old checkouts resolvable but never appear for sale.
  is_archived           TINYINT(1) NOT NULL DEFAULT 0,
  sort_order            INT NOT NULL DEFAULT 0,

  paypal_image          VARCHAR(255) NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_web_plans_slug (slug),
  INDEX idx_web_plans_live (is_archived, is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Seed from what src/config.js hardcoded, so the pricing page renders the same
-- thing the day this runs as it did the day before.
INSERT IGNORE INTO web_plans
  (slug, name, period_months, interval_label, interval_count,
   price_per_month_minor, total_minor, discounted_minor, vat_minor,
   total_with_vat_minor, save_percentage, blurb, features,
   is_popular, is_default, sort_order, paypal_image)
VALUES
  ('starter', 'Starter Plan', 1, 'Month', 1,
   8000, 8000, 7500, 1500, 9000, 6,
   'Month to month. Cancel whenever you like.',
   'Full till software\nUnlimited products\nBack office access\nEmail support',
   0, 0, 10, 'https://vesopaepos.com/assets/paypal/paypal_starter_plan.png'),

  -- Quarterly: the term Vesopa actually sells on. Seeded between the monthly
  -- and annual rates; the real figure is the admin's to set on /admin/plans.
  ('quarterly', 'Quarterly Plan', 3, 'Month', 3,
   7500, 22500, 21000, 4200, 25200, 6,
   'Three months up front — the standard Vesopa term.',
   'Full till software\nUnlimited products\nBack office access\nPriority email support\nQuarterly billing',
   1, 1, 20, NULL),

  ('business', 'Business Plan', 12, 'Year', 1,
   7000, 84000, 78000, 11700, 89700, 7,
   'A year up front, at a lower monthly rate.',
   'Everything in Quarterly\nPhone support\nFree setup and data import\nStaff training session',
   0, 0, 30, 'https://vesopaepos.com/assets/paypal/paypal_business_plan.png'),

  ('enterprise', 'Enterprise Plan', 24, 'Year', 2,
   6000, 144000, 130000, 19500, 149500, 10,
   'Two years, at the best rate we offer.',
   'Everything in Business\nDedicated account manager\nMulti-site back office\nOn-site installation',
   0, 0, 40, 'https://vesopaepos.com/assets/paypal/paypal_enterprise_plan.png');

-- ---------------------------------------------------------------------------
-- Offices: the columns the subscription screens need
--
-- offices is the billing source of truth. It already carries
-- monthly_fee_minor / next_due_on / trial_ends_on / status / plan; what it has
-- no room for is the phone number to ring when a term lapses, and the term
-- length itself.
-- ---------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER $$
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = tbl AND column_name = col) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- The number the admin rings when a subscription lapses. Nothing about the
-- expiry flow works without it, and offices had no phone column at all.
CALL vesopa_add_column('offices', 'contact_phone', 'VARCHAR(64) NULL');
CALL vesopa_add_column('offices', 'contact_name',  'VARCHAR(255) NULL');

-- Term length in months. 3 = quarterly, the real Vesopa term. Renewals add
-- this to next_due_on, so changing it changes the next cycle and not the past.
CALL vesopa_add_column('offices', 'term_months', 'INT NOT NULL DEFAULT 3');

-- Free-text the admin keeps about the account.
CALL vesopa_add_column('offices', 'notes', 'TEXT NULL');

-- When the lapse warning was last acknowledged. Lets the dashboard stop
-- shouting about an office someone has already chased today, without hiding it.
CALL vesopa_add_column('offices', 'reminded_at', 'DATETIME NULL');

-- Backfill the phone from the demo request the office signed up through.
UPDATE offices o
JOIN demo_request d ON d.email = o.contact_email
SET o.contact_phone = d.phone
WHERE (o.contact_phone IS NULL OR o.contact_phone = '')
  AND d.phone IS NOT NULL AND d.phone <> '';

UPDATE offices o
JOIN backoffice_users u ON u.email = o.contact_email
SET o.contact_name = u.name
WHERE (o.contact_name IS NULL OR o.contact_name = '')
  AND u.name IS NOT NULL AND u.name <> '';

-- Give every office a term end. Offices with no next_due_on are invisible to
-- the expiry screens, which is worse than an approximate date the admin can fix.
UPDATE offices
SET next_due_on = DATE_ADD(DATE(created_at), INTERVAL 3 MONTH)
WHERE next_due_on IS NULL;

UPDATE offices o
JOIN web_plans p ON p.is_default = 1
SET o.plan = p.slug
WHERE o.plan IS NULL OR o.plan = '';

UPDATE offices o
JOIN web_plans p ON p.slug = o.plan
SET o.monthly_fee_minor = p.price_per_month_minor,
    o.term_months       = p.period_months
WHERE o.monthly_fee_minor = 0;

-- (vesopa_add_column is dropped at the very end of this file — the blog table
-- below needs it too, for installs created before those columns existed.)

-- ---------------------------------------------------------------------------
-- Collection: what was actually taken, and when
--
-- subscription_invoices exists but hangs off a `subscriptions` row, and no
-- office has one. This ledger hangs off the office directly, which is how the
-- admin thinks about it: "who has paid me".
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS office_payments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  office_id     INT NOT NULL,
  amount_minor  INT NOT NULL,
  currency      CHAR(3) NOT NULL DEFAULT 'GBP',
  paid_on       DATE NOT NULL,

  method        ENUM('bank','card','paypal','cash','cheque','other')
                NOT NULL DEFAULT 'bank',
  reference     VARCHAR(120) NULL,

  -- The term this payment bought. Set when the payment is recorded against a
  -- renewal, so a lapsed account's history reads as a run of covered periods.
  period_start  DATE NULL,
  period_end    DATE NULL,

  plan_slug     VARCHAR(64) NULL,
  note          VARCHAR(500) NULL,
  recorded_by   VARCHAR(120) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_office_payment_office FOREIGN KEY (office_id)
    REFERENCES offices(id) ON DELETE CASCADE,
  INDEX idx_office_payments_paid (paid_on),
  INDEX idx_office_payments_office (office_id, paid_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Chase log
--
-- An expiry never switches a till off, so the only thing that resolves it is
-- somebody making contact. That has to be written down or the next admin
-- repeats the call.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS office_contact_log (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  office_id  INT NOT NULL,
  kind       ENUM('email','call','note') NOT NULL DEFAULT 'note',
  subject    VARCHAR(255) NULL,
  body       TEXT NULL,
  -- 'sent' / 'failed' for email, NULL otherwise.
  outcome    VARCHAR(32) NULL,
  admin_name VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_contact_log_office FOREIGN KEY (office_id)
    REFERENCES offices(id) ON DELETE CASCADE,
  INDEX idx_contact_log_office (office_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Blog and product updates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blog_posts (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  slug         VARCHAR(180) NOT NULL,
  title        VARCHAR(255) NOT NULL,

  -- 'update' posts are release notes and get the version badge; 'post' is
  -- everything else. Same table because they share a template and a feed.
  kind         ENUM('post','update') NOT NULL DEFAULT 'post',
  version      VARCHAR(32) NULL,

  excerpt      VARCHAR(500) NULL,
  body         MEDIUMTEXT NOT NULL,
  cover_url    VARCHAR(500) NULL,
  author       VARCHAR(120) NULL,
  tags         VARCHAR(255) NULL,

  seo_title       VARCHAR(255) NULL,
  seo_description VARCHAR(500) NULL,

  status       ENUM('draft','published') NOT NULL DEFAULT 'draft',
  published_at DATETIME NULL,
  views        INT NOT NULL DEFAULT 0,

  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_blog_slug (slug),
  INDEX idx_blog_live (status, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Added after the table shipped, so guarded for installs that already have it.
--
-- layout picks how the post presents itself. Kept as a plain VARCHAR rather
-- than an ENUM: adding a fifth layout would otherwise be an ALTER on a live
-- table, and an unrecognised value already falls back to 'standard' in the
-- template, which is the same safety an ENUM would give.
CALL vesopa_add_column('blog_posts', 'layout',
  "VARCHAR(32) NOT NULL DEFAULT 'standard'");

-- Pinned to the top of /blog regardless of date. One post at a time in
-- practice, but not enforced in the schema — the listing just takes the most
-- recent flagged one, so ticking a second cannot produce a broken page.
CALL vesopa_add_column('blog_posts', 'is_featured', 'TINYINT(1) NOT NULL DEFAULT 0');

-- published_at itself needs no migration — it already exists. What changes is
-- that the editor now writes it instead of always stamping NOW(), so a post can
-- be back-dated to when it was written or dated forward to schedule it. The
-- public queries gained an `AND published_at <= NOW()` to make that mean
-- something; idx_blog_live already covers the lookup.
--
-- No index on is_featured on purpose: the listing reads one flagged row out of
-- a table that will hold tens of posts, and an index there would cost a write
-- on every save to save nothing measurable on the read.

-- ---------------------------------------------------------------------------
-- File manager
--
-- Uploads and external links in one table, because the admin's question is
-- "what can I paste into a page", and the answer is a URL either way.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media_files (
  id            INT AUTO_INCREMENT PRIMARY KEY,

  -- 'file' is on disk under public/; 'link' is somewhere else entirely.
  kind          ENUM('file','link') NOT NULL DEFAULT 'file',
  category      ENUM('app','image','document','other') NOT NULL DEFAULT 'other',

  title         VARCHAR(255) NOT NULL,
  -- What the browser saves it as. Kept apart from the stored name so two
  -- uploads called "installer.exe" do not overwrite each other.
  original_name VARCHAR(255) NULL,
  stored_name   VARCHAR(255) NULL,
  -- Site-relative for uploads ("/app/x.apk"), absolute for links.
  url           VARCHAR(700) NOT NULL,

  mime          VARCHAR(120) NULL,
  size_bytes    BIGINT NULL,
  -- Which page it is meant to appear on, if any: 'download', 'home', …
  attach_to     VARCHAR(64) NULL,
  -- Shown next to the link on that page.
  label         VARCHAR(255) NULL,
  version       VARCHAR(32) NULL,

  is_public     TINYINT(1) NOT NULL DEFAULT 1,
  sort_order    INT NOT NULL DEFAULT 0,
  download_count INT NOT NULL DEFAULT 0,

  uploaded_by   VARCHAR(120) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_media_stored (stored_name),
  INDEX idx_media_attach (attach_to, is_public, sort_order),
  INDEX idx_media_category (category, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Sub-users (till clerks)
--
-- bo_clarks keys off the office's email, has no unique constraint, and stores
-- the PIN in whatever the back office wrote. Left alone structurally — the till
-- reads it — but given the index the admin list needs to not table-scan.
-- ---------------------------------------------------------------------------

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE()
             AND table_name = 'bo_clarks' AND index_name = 'idx_bo_clarks_email');
SET @s := IF(@i = 0, 'CREATE INDEX idx_bo_clarks_email ON bo_clarks (email)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The helper stays alive until here because the blog table above uses it too.
DROP PROCEDURE IF EXISTS vesopa_add_column;
