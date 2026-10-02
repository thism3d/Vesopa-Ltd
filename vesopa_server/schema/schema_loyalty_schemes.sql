-- Loyalty schemes: a venue's groups of customers, each with its own rewards.
--
-- WHAT THE VENUE ASKED FOR (2026-10-02)
--
-- "We need the ability to create and manage different Loyalty Schemes. When
-- creating a new customer on the till, it should ask which Loyalty Scheme the
-- customer wants to be part of." Their old system (Newbridge) calls these
-- Loyalty Schemes and uses them as the customer's group as well: VIP, Member,
-- Players VIP, Life Members, Committee, Sponsorship and so on.
--
-- A scheme is either a group with no rewards, or a discount (a percentage, a
-- fixed amount, or a price level), and separately it may earn points. The
-- discount can be limited to some departments, some hours and some days.
--
-- WHAT IT DOES NOT REPLACE
--
-- epos_loyalty_settings stays as the venue's loyalty rules. A scheme only
-- overrides what it sets, and a customer in no scheme is priced exactly as
-- every customer was before schemes existed. A venue that never opens the
-- Loyalty Schemes page sees no change at all.
--
-- THE CARD PREFIX
--
-- Each scheme can own a card prefix (9998, 9997...). A card starting with it is
-- a loyalty card, and somebody enrolled by swiping one joins that scheme
-- without being asked. The rest of the number is their membership number:
-- card 999800001 is member 00001. See src/loyalty_schemes.js.
--
-- Target is MySQL 5.7 / MariaDB. Every statement is guarded and safe to re-run.
-- Sorts after schema_customers.sql, schema_commerce.sql and
-- schema_swipe_cards.sql, whose tables it alters.

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

CREATE TABLE IF NOT EXISTS epos_loyalty_schemes (
  id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office             VARCHAR(190) CHARACTER SET utf8mb4
                     COLLATE utf8mb4_general_ci NOT NULL,
  name               VARCHAR(80)  NOT NULL,
  colour             VARCHAR(16)  NOT NULL DEFAULT '#a5c715',

  -- 'none' | 'percent' | 'amount' | 'price_level'. Newbridge asks "No Rewards
  -- or Discount" and then which discount; one column says both.
  reward_type        VARCHAR(16)  NOT NULL DEFAULT 'none',
  -- Whole percent for 'percent', pence for 'amount'.
  discount_value     INT          NOT NULL DEFAULT 0,
  -- 2 to 6 for 'price_level'.
  price_level        TINYINT      NULL,
  -- JSON array of department names the discount covers. NULL or [] = all.
  discount_departments TEXT       NULL,
  -- The daily window and the days, Monday first, as promotions store them.
  start_time         CHAR(5)      NOT NULL DEFAULT '00:00',
  end_time           CHAR(5)      NOT NULL DEFAULT '23:59',
  days_of_week       CHAR(7)      NOT NULL DEFAULT '1111111',
  -- Points a member must hold before the discount applies.
  min_points_for_discount INT     NOT NULL DEFAULT 0,

  earn_points        TINYINT(1)   NOT NULL DEFAULT 0,
  -- NULL inherits the venue's loyalty settings.
  points_per_pound   INT          NULL,
  point_value_minor  INT          NULL,
  min_spend_minor    INT          NULL,
  -- Points given when somebody joins the scheme.
  welcome_points     INT          NOT NULL DEFAULT 0,
  -- JSON array of department names that earn. NULL or [] = all.
  earn_departments   TEXT         NULL,

  -- Digits on the front of this scheme's cards. '' = no cards of its own.
  card_prefix        VARCHAR(8)   NOT NULL DEFAULT '',
  -- Membership fee and term for this scheme. NULL inherits the venue's.
  membership_fee_minor   INT      NULL,
  membership_term_months INT      NULL,

  -- Picked already when the till asks which scheme.
  is_default         TINYINT(1)   NOT NULL DEFAULT 0,
  -- Offered on the till's new-customer form. A scheme for the committee is
  -- one a venue sets in the back office, not one the counter hands out.
  offer_at_till      TINYINT(1)   NOT NULL DEFAULT 1,
  active             TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order         INT          NOT NULL DEFAULT 0,
  notes              VARCHAR(255) NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_scheme_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which scheme a customer is in. NULL = none, priced by the venue's settings.
CALL vesopa_add_column('epos_customers', 'scheme_id', 'INT NULL');
CALL vesopa_add_index('epos_customers', 'idx_cust_scheme', '`email_key`, `scheme_id`');

-- What Newbridge's customer form also asks.
CALL vesopa_add_column('epos_customers', 'marketing_opt_in', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_customers', 'address_line1', 'VARCHAR(120) NULL');
CALL vesopa_add_column('epos_customers', 'address_line2', 'VARCHAR(120) NULL');
CALL vesopa_add_column('epos_customers', 'town', 'VARCHAR(80) NULL');
CALL vesopa_add_column('epos_customers', 'postcode', 'VARCHAR(16) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
