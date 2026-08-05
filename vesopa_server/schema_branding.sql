-- Receipt branding + the sale context a printed receipt needs.
--
-- Target is MySQL 5.7, which has no `ADD COLUMN IF NOT EXISTS`, so the column
-- additions go through a guard procedure that checks information_schema first.
-- That keeps this file safe to re-run.

-- ---------------------------------------------------------------------------
-- Branding: one row per office (tenant). The till fetches this at sign-in and
-- caches it, so a venue can change its footer or upload a new logo from the
-- back office without anyone touching the tills.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_branding (
  office             VARCHAR(190) NOT NULL PRIMARY KEY,

  -- Header
  venue_name         VARCHAR(120) NOT NULL DEFAULT '',
  logo_url           VARCHAR(255) NULL,
  address_line1      VARCHAR(120) NOT NULL DEFAULT '',
  address_line2      VARCHAR(120) NOT NULL DEFAULT '',
  city               VARCHAR(80)  NOT NULL DEFAULT '',
  postcode           VARCHAR(16)  NOT NULL DEFAULT '',
  phone              VARCHAR(40)  NOT NULL DEFAULT '',
  website            VARCHAR(120) NOT NULL DEFAULT '',
  vat_number         VARCHAR(40)  NOT NULL DEFAULT '',
  company_number     VARCHAR(40)  NOT NULL DEFAULT '',

  -- Body / footer copy
  header_note        VARCHAR(255) NOT NULL DEFAULT '',
  footer_message     VARCHAR(255) NOT NULL DEFAULT 'Thank you for your custom',
  footer_note        VARCHAR(500) NOT NULL DEFAULT '',
  social_line        VARCHAR(160) NOT NULL DEFAULT '',

  -- Layout switches the designer drives
  paper_width_mm     TINYINT      NOT NULL DEFAULT 80,   -- 80 or 58
  show_logo          TINYINT(1)   NOT NULL DEFAULT 1,
  show_vat_breakdown TINYINT(1)   NOT NULL DEFAULT 1,
  show_barcode       TINYINT(1)   NOT NULL DEFAULT 1,
  show_qr            TINYINT(1)   NOT NULL DEFAULT 0,
  qr_url             VARCHAR(255) NOT NULL DEFAULT '',
  show_served_by     TINYINT(1)   NOT NULL DEFAULT 1,
  show_powered_by    TINYINT(1)   NOT NULL DEFAULT 1,

  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Idempotent column adder for 5.7.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
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

-- Sale context the printed receipt needs. All additive and nullable/defaulted,
-- so existing rows and older tills that do not send them still work.
CALL vesopa_add_column('epos_orders', 'customer_name',  'VARCHAR(120) NULL');
CALL vesopa_add_column('epos_orders', 'voucher_code',   'VARCHAR(60) NULL');
CALL vesopa_add_column('epos_orders', 'voucher_minor',  'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'service_minor',  'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'points_earned',  'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('epos_orders', 'points_balance', 'INT NULL');
CALL vesopa_add_column('epos_orders', 'clerk_name',     'VARCHAR(80) NULL');
CALL vesopa_add_column('epos_orders', 'order_note',     'VARCHAR(500) NULL');

-- Per-line notes ("no onions", "well done") print on both the customer
-- receipt and the kitchen ticket.
CALL vesopa_add_column('epos_order_lines', 'note', 'VARCHAR(255) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
