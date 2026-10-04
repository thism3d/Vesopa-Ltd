-- Memberships: plans, members, family, freezes, classes and online payments.
--
-- The Memberships module (src/modules.js) for gyms, clubs and Metric Group's
-- car-park members. Asked for on 2026-10-04: "Let's add feature of the
-- membership of METRIC GROUP within Vesopa EPOS ... like GYM membership as
-- well", with joining fees, freezes, classes and family plans in the first
-- release.
--
-- BUILT ON WHAT IS ALREADY HERE, NOT BESIDE IT
--
--   * A membership PLAN is a loyalty scheme (epos_loyalty_schemes) with
--     `is_membership` set. Schemes already carry a fee, a term, a card prefix,
--     a colour and member discounts, and the till already asks which scheme a
--     new customer joins. A second "plans" table would be a second list of the
--     same groups that the till, the cards and the loyalty app would each have
--     to be taught about.
--   * A MEMBER is a customer (epos_customers): the card, the photo, the expiry
--     date and the renewal at the till all exist already. This file adds the
--     state a membership has that a loyalty customer does not: frozen,
--     cancelled, who pays for a family, when they joined.
--   * The gym door (schema_till_gym.sql) is unchanged; it reads the same rows.
--
-- Sorts after schema_customers.sql, schema_loyalty_schemes.sql and every
-- schema_membership_*.sql ("membership_" < "memberships" because "_" < "s").
-- Re-runnable: the deploy applies every file in this folder on every deploy.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD INDEX `', idx, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Plans: a scheme that is a membership.
-- ---------------------------------------------------------------------------
-- Off on every existing scheme: a VIP group at a pub is not a gym plan, and
-- nothing about it changes until a manager ticks it.
CALL vesopa_add_column('epos_loyalty_schemes', 'is_membership',
  'TINYINT(1) NOT NULL DEFAULT 0');
-- Charged once, on joining, on top of the first period's fee.
CALL vesopa_add_column('epos_loyalty_schemes', 'joining_fee_minor', 'INT NULL');
-- How many people one membership covers, the payer included. NULL or 1 is a
-- single membership; 4 is "a family of four on one plan".
CALL vesopa_add_column('epos_loyalty_schemes', 'family_size', 'TINYINT NULL');
-- Days a member may freeze in any twelve months. NULL is no freezing; 0 too.
CALL vesopa_add_column('epos_loyalty_schemes', 'freeze_days_per_year', 'SMALLINT NULL');
-- What the plan opens: the gym door, and classes.
CALL vesopa_add_column('epos_loyalty_schemes', 'includes_gym',
  'TINYINT(1) NOT NULL DEFAULT 1');
CALL vesopa_add_column('epos_loyalty_schemes', 'includes_classes',
  'TINYINT(1) NOT NULL DEFAULT 1');
-- Classes a member may book a month. NULL is unlimited.
CALL vesopa_add_column('epos_loyalty_schemes', 'class_credits_per_month', 'SMALLINT NULL');
-- Cars a member may register for vehicle access (Metric). NULL is the
-- vehicle-access default of three.
CALL vesopa_add_column('epos_loyalty_schemes', 'max_vehicles', 'TINYINT NULL');
-- Offered in the loyalty app for joining and paying online.
CALL vesopa_add_column('epos_loyalty_schemes', 'sell_online',
  'TINYINT(1) NOT NULL DEFAULT 0');
-- What the app and the join page say about it.
CALL vesopa_add_column('epos_loyalty_schemes', 'description', 'VARCHAR(500) NULL');

-- ---------------------------------------------------------------------------
-- Members: what a membership has that a loyalty customer does not.
-- ---------------------------------------------------------------------------
-- '' is "not a membership": every loyalty customer that exists today. A
-- customer becomes a member by joining a plan, which sets 'active'.
CALL vesopa_add_column('epos_customers', 'membership_status',
  "VARCHAR(12) NOT NULL DEFAULT ''");
CALL vesopa_add_column('epos_customers', 'joined_on', 'DATE NULL');
-- The member who pays, for somebody on their family plan. NULL for the payer
-- and for everybody on a single plan.
CALL vesopa_add_column('epos_customers', 'family_head_id', 'CHAR(36) NULL');
CALL vesopa_add_column('epos_customers', 'frozen_from', 'DATE NULL');
CALL vesopa_add_column('epos_customers', 'frozen_until', 'DATE NULL');
CALL vesopa_add_column('epos_customers', 'cancelled_on', 'DATE NULL');
-- Email the member a renewal link before their membership runs out.
CALL vesopa_add_column('epos_customers', 'renewal_reminders',
  'TINYINT(1) NOT NULL DEFAULT 1');
CALL vesopa_add_column('epos_customers', 'reminder_sent_for', 'DATE NULL');
CALL vesopa_add_index('epos_customers', 'idx_cust_membership',
  '`email_key`, `membership_status`');
CALL vesopa_add_index('epos_customers', 'idx_cust_family', '`family_head_id`');

-- ---------------------------------------------------------------------------
-- What happened to each membership, in order.
-- ---------------------------------------------------------------------------
-- Joined, renewed, frozen, unfrozen, cancelled, reinstated, moved plan, paid
-- online. A membership desk is asked "when did I pay?" and "why does my card
-- say expired?", and the answer is a list, not a column.
CREATE TABLE IF NOT EXISTS epos_membership_events (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id    CHAR(36)     NOT NULL,
  kind           VARCHAR(16)  NOT NULL,
  scheme_id      INT          NULL,
  expiry_before  DATE         NULL,
  expiry_after   DATE         NULL,
  amount_minor   INT          NULL,
  note           VARCHAR(255) NULL,
  via            VARCHAR(16)  NOT NULL DEFAULT 'backoffice',
  by_who         VARCHAR(190) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_mev_customer (customer_id, created_at),
  KEY idx_mev_office (office, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Paying online, through Dojo's hosted checkout.
-- ---------------------------------------------------------------------------
-- One row per checkout started. The membership moves only when Dojo says the
-- intent is paid -- read from the intent itself, never from the redirect, which
-- proves only that a browser arrived -- and `applied_at` makes applying it
-- happen once however many times the return page or the webhook is hit.
CREATE TABLE IF NOT EXISTS epos_membership_payments (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  public_id      CHAR(32)     NOT NULL,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id    CHAR(36)     NOT NULL,
  scheme_id      INT          NULL,
  kind           VARCHAR(8)   NOT NULL,
  amount_minor   INT          NOT NULL,
  intent_id      VARCHAR(80)  NULL,
  status         VARCHAR(12)  NOT NULL DEFAULT 'pending',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at        DATETIME     NULL,
  applied_at     DATETIME     NULL,
  UNIQUE KEY uq_mpay_public (public_id),
  KEY idx_mpay_office (office, created_at),
  KEY idx_mpay_intent (intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Classes.
-- ---------------------------------------------------------------------------
-- A CLASS is what is taught (Spin, Yoga); the TIMETABLE says when it runs every
-- week; a SESSION is one occurrence on one day, made from the timetable when
-- somebody first looks at that day, or added on its own for a one-off. Members
-- BOOK sessions, and are checked in at the till when they arrive.
CREATE TABLE IF NOT EXISTS epos_classes (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  name           VARCHAR(80)  NOT NULL,
  description    VARCHAR(500) NULL,
  colour         VARCHAR(16)  NOT NULL DEFAULT '#a5c715',
  duration_min   SMALLINT     NOT NULL DEFAULT 60,
  capacity       SMALLINT     NOT NULL DEFAULT 20,
  instructor     VARCHAR(80)  NULL,
  room           VARCHAR(80)  NULL,
  -- What somebody who is not a member (or whose plan has no classes) pays to
  -- drop in. NULL: members only.
  drop_in_minor  INT          NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_classes_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS epos_class_timetable (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  class_id       INT          NOT NULL,
  -- 1 Monday .. 7 Sunday, as ISO counts them.
  weekday        TINYINT      NOT NULL,
  start_time     CHAR(5)      NOT NULL,
  duration_min   SMALLINT     NULL,
  capacity       SMALLINT     NULL,
  instructor     VARCHAR(80)  NULL,
  room           VARCHAR(80)  NULL,
  starts_on      DATE         NULL,
  ends_on        DATE         NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  KEY idx_ctt_office (office, weekday)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS epos_class_sessions (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  class_id       INT          NOT NULL,
  timetable_id   INT          NULL,
  starts_at      DATETIME     NOT NULL,
  ends_at        DATETIME     NOT NULL,
  capacity       SMALLINT     NOT NULL,
  instructor     VARCHAR(80)  NULL,
  room           VARCHAR(80)  NULL,
  cancelled      TINYINT(1)   NOT NULL DEFAULT 0,
  note           VARCHAR(190) NULL,
  -- One session per timetable slot per start, so two people opening the same
  -- day at the same moment cannot make it twice.
  UNIQUE KEY uq_session_slot (timetable_id, starts_at),
  KEY idx_sessions_office (office, starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS epos_class_bookings (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  session_id     INT          NOT NULL,
  customer_id    CHAR(36)     NOT NULL,
  -- booked, waitlist, attended, cancelled, no_show
  status         VARCHAR(10)  NOT NULL DEFAULT 'booked',
  via            VARCHAR(16)  NOT NULL DEFAULT 'backoffice',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_booking (session_id, customer_id),
  KEY idx_bookings_customer (customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- Partner keys: another Vesopa system reading a venue's members.
-- ---------------------------------------------------------------------------
-- Metric Membership (MetricMembership/server) keeps the cars, gates and
-- cameras; the members and plans live here (owner, 2026-10-04: "In EPOS"). The
-- Metric server reads and writes them with a key admin issues for the venue.
-- Only a hash is kept: the key is shown once.
CREATE TABLE IF NOT EXISTS epos_partner_keys (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  label          VARCHAR(80)  NOT NULL DEFAULT '',
  key_hash       CHAR(64)     NOT NULL,
  created_by     VARCHAR(190) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME     NULL,
  revoked_at     DATETIME     NULL,
  UNIQUE KEY uq_partner_key (key_hash),
  KEY idx_partner_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
