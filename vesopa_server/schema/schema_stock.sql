-- ===========================================================================
-- Stock control: a ledger, and the documents that write to it.
-- ===========================================================================
--
-- WHAT THIS IS FOR
--
-- Until now stock was one number on the product -- `bo_products.stock_quantity`
-- -- moved down by sales and overwritten by the back office. A number with no
-- history cannot answer any of the questions a stock report asks: what was
-- sold, what was thrown away, what arrived, what was corrected, and what was
-- there when somebody last counted. So this adds:
--
--   * epos_stock_movements  -- the ledger. Every change to a product's count is
--                              one signed row here, and stock_quantity is the
--                              running balance of them. Sales write it from
--                              sales.js; everything else through a document.
--   * bo_stock_docs / _lines -- wastage, adjustment, stocktake, spot check and
--                              delivery documents. A document is drafted, then
--                              completed once; completing it writes the ledger.
--   * bo_suppliers           -- who a venue buys from.
--   * bo_pack_sizes          -- "Pack of 24" is 24 units; "11g Keg" is 88 pints.
--                              Newbridge calls these SKUs. A product is bought
--                              in packs and sold in units, and the reports show
--                              both.
--   * bo_purchase_orders / _lines -- an order to a supplier, in packs, and what
--                              of it was delivered.
--
-- SORT ORDER. Runs after schema_commerce.sql ('c' < 's'), which creates
-- bo_products, and after schema.sql, which creates epos_orders.
--
-- RE-RUNNABLE. Every deploy replays every file here, so every table is IF NOT
-- EXISTS and every column goes through vesopa_add_column. The procedure is
-- defined here and dropped at the end because the file before this one did
-- the same, and a file that assumed it was still there would fail on the
-- second deploy and silently on the first.
-- ===========================================================================

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

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bo_suppliers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  office        VARCHAR(190) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  contact_name  VARCHAR(120) NULL,
  phone         VARCHAR(40)  NULL,
  email         VARCHAR(190) NULL,
  account_ref   VARCHAR(60)  NULL,
  notes         VARCHAR(500) NULL,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_supplier_name (office, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Pack sizes
-- ---------------------------------------------------------------------------
-- `units` is how many sellable units one pack holds. A keg is bought as one
-- thing and sold as eighty-eight pints; a case of bottles as twenty-four.
-- Seeded per venue by the server on first read, not here: a seed in SQL
-- would need the list of offices, and a venue created next week would miss it.

CREATE TABLE IF NOT EXISTS bo_pack_sizes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  office        VARCHAR(190) NOT NULL,
  name          VARCHAR(60)  NOT NULL,
  units         DOUBLE       NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pack_name (office, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- What a product needs to be stocked
-- ---------------------------------------------------------------------------
-- cost_price (per unit) and low_stock_at already exist on bo_products from
-- schema_commerce.sql. pack_cost is the price of one pack from the supplier;
-- when both it and a pack size are set, the unit cost is pack_cost / units and
-- cost_price is kept in step by the server so every existing reader of
-- cost_price stays right.

CALL vesopa_add_column('bo_products', 'supplier_id',   'INT NULL');
CALL vesopa_add_column('bo_products', 'supplier_code', 'VARCHAR(64) NULL');
CALL vesopa_add_column('bo_products', 'pack_size_id',  'INT NULL');
CALL vesopa_add_column('bo_products', 'pack_cost',     'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'min_stock',     'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'max_stock',     'DOUBLE NULL');
CALL vesopa_add_column('bo_products', 'stock_unit',    'VARCHAR(24) NULL');

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------
-- One row per change to one product's count. `quantity` is signed: a delivery
-- is positive, a sale or wastage negative, a stocktake whatever makes the
-- balance match the shelf. `unit_cost_minor` is the cost as it stood when the
-- row was written, so a valuation of last month is not restated by a price
-- change this month.
--
-- `id` is minted by whoever writes it -- a sale line's own id for a sale, so a
-- till retrying an upload cannot move the same items off twice.

CREATE TABLE IF NOT EXISTS epos_stock_movements (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  office          VARCHAR(190) NOT NULL,
  pluid           INT          NOT NULL,
  product_name    VARCHAR(255) NULL,
  -- sale | refund | wastage | delivery | adjustment | stocktake | spot_check
  kind            VARCHAR(16)  NOT NULL,
  quantity        DOUBLE       NOT NULL,
  unit_cost_minor INT          NOT NULL DEFAULT 0,
  reason          VARCHAR(255) NULL,
  doc_id          CHAR(36)     NULL,
  order_id        CHAR(36)     NULL,
  staff_name      VARCHAR(120) NULL,
  terminal        VARCHAR(120) NULL,
  moved_at        DATETIME     NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_moves_office_time (office, moved_at),
  INDEX idx_stock_moves_product (office, pluid, moved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
-- A wastage, an adjustment, a stocktake, a spot check or a delivery. Drafted
-- with lines, completed once. Completion reads the current count of every
-- line into `expected`, writes the ledger and moves the count -- all in one
-- transaction, so a document is either wholly applied or not at all.
--
-- For a stocktake or spot check `quantity` is what was COUNTED and the ledger
-- row is the difference; for everything else it is the signed movement itself.

CREATE TABLE IF NOT EXISTS bo_stock_docs (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  office        VARCHAR(190) NOT NULL,
  -- wastage | adjustment | stocktake | spot_check | delivery
  kind          VARCHAR(16)  NOT NULL,
  -- draft | completed
  status        VARCHAR(12)  NOT NULL DEFAULT 'draft',
  notes         VARCHAR(500) NULL,
  staff_name    VARCHAR(120) NULL,
  terminal      VARCHAR(120) NULL,
  order_id      CHAR(36)     NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  DATETIME     NULL,
  INDEX idx_stock_docs_office (office, kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_stock_doc_lines (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  doc_id          CHAR(36)     NOT NULL,
  pluid           INT          NOT NULL,
  product_name    VARCHAR(255) NULL,
  expected        DOUBLE       NULL,
  quantity        DOUBLE       NOT NULL DEFAULT 0,
  unit_cost_minor INT          NOT NULL DEFAULT 0,
  reason          VARCHAR(255) NULL,
  CONSTRAINT fk_stock_doc_lines_doc FOREIGN KEY (doc_id)
    REFERENCES bo_stock_docs(id) ON DELETE CASCADE,
  INDEX idx_stock_doc_lines_doc (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
-- In packs, because that is how a supplier sells. The pack's name, size and
-- price are copied onto the line when the order is made: a pack size renamed
-- next year must not restate what was ordered this year.

CREATE TABLE IF NOT EXISTS bo_purchase_orders (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  office          VARCHAR(190) NOT NULL,
  supplier_id     INT          NULL,
  supplier_name   VARCHAR(120) NULL,
  -- new | sent | part_delivered | delivered | cancelled
  status          VARCHAR(16)  NOT NULL DEFAULT 'new',
  notes           VARCHAR(500) NULL,
  -- email | phone
  send_method     VARCHAR(12)  NOT NULL DEFAULT 'email',
  supplier_email  VARCHAR(190) NULL,
  staff_name      VARCHAR(120) NULL,
  total_minor     INT          NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at         DATETIME     NULL,
  delivered_at    DATETIME     NULL,
  INDEX idx_purchase_orders_office (office, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_purchase_order_lines (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  order_id         CHAR(36)     NOT NULL,
  pluid            INT          NOT NULL,
  product_name     VARCHAR(255) NULL,
  supplier_code    VARCHAR(64)  NULL,
  pack_size_id     INT          NULL,
  pack_name        VARCHAR(60)  NULL,
  pack_units       DOUBLE       NOT NULL DEFAULT 1,
  pack_cost_minor  INT          NOT NULL DEFAULT 0,
  packs_ordered    DOUBLE       NOT NULL DEFAULT 0,
  packs_delivered  DOUBLE       NOT NULL DEFAULT 0,
  CONSTRAINT fk_purchase_order_lines_order FOREIGN KEY (order_id)
    REFERENCES bo_purchase_orders(id) ON DELETE CASCADE,
  INDEX idx_purchase_order_lines_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS vesopa_add_column;
