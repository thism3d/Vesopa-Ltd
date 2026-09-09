-- Every bulk price change, and what it changed, so it can be put back.
--
-- "I want a product price level update like this but more advanced."
--
-- The thing being improved on takes a base level, a target level, a set of
-- products, a percentage, and writes. There is no preview and no way back. That
-- is a page where one mistyped number reprices four hundred products across a
-- venue and the only recovery is remembering what they used to be.
--
-- So a run is recorded, product by product, with the value each one held
-- BEFORE it was written. Two things follow from that and neither is decoration:
--
--   * a manager can undo the last change, in one press, at the counter;
--   * "who put the wine up 8% in March?" has an answer.
--
-- WHY THE OLD VALUE IS A DOUBLE AND NULLABLE
--
-- `bo_products.price_2` … `price_6` are DOUBLE and NULLABLE, and null is a real
-- answer there — it means "this product has no special price at this level,
-- charge Price 1". An undo that wrote 0 back over a null would silently start
-- giving that product away at that level. So the audit stores exactly what was
-- there, null included, and the undo puts exactly that back.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- Files apply in filename sort order, all of them, on every deploy.
-- `schema_commerce.sql` creates `bo_products` and "c" sorts before "p", so the
-- catalogue exists by the time this runs. Nothing here alters an existing
-- table, so there is no ALTER to land before its table.
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS, and the guard procedure for the
-- one index that is added separately.
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- One row per bulk change.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bo_price_level_runs (
  id            INT AUTO_INCREMENT PRIMARY KEY,

  -- The venue. `email` and not `office_id`, to match `bo_products`, which is
  -- what every query here joins against — the catalogue inherited its tenant
  -- key from the PHP schema and a second spelling in the same query is how a
  -- scoping bug gets written.
  email         VARCHAR(255) NOT NULL,

  -- Which level was read, and which was written. 1 is `price`; 2-6 are
  -- `price_2` … `price_6`.
  source_level  TINYINT NOT NULL,
  target_level  TINYINT NOT NULL,

  -- percent | amount | copy
  method        VARCHAR(16) NOT NULL,
  -- up | down. Held apart from the value so a manager types a positive number
  -- and picks a direction, rather than remembering that a minus sign is what
  -- makes a price go down.
  direction     VARCHAR(8) NOT NULL DEFAULT 'up',
  -- Percentage points (2 decimal places) for `percent`, pence for `amount`,
  -- and ignored for `copy`.
  amount        DECIMAL(10,2) NOT NULL DEFAULT 0,

  -- none | 5p | 10p | 99 | 95 | pound
  rounding      VARCHAR(16) NOT NULL DEFAULT 'none',

  -- What it touched, so the list reads without opening every run.
  product_count INT NOT NULL DEFAULT 0,

  -- Who and when. The address rather than a user id: a member of staff can be
  -- deleted and the question "who did this" still has to have an answer.
  created_by    VARCHAR(255) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Set when somebody puts the change back, so a run can be undone once and
  -- the button then says so rather than silently doing nothing.
  undone_at     DATETIME NULL,
  undone_by     VARCHAR(255) NULL,

  KEY ix_price_runs_office (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- One row per product the run touched.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bo_price_level_run_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  run_id      INT NOT NULL,

  -- The catalogue's key, per venue. Deliberately not a foreign key: `pluid` is
  -- unique per venue rather than across the platform, so a constraint here
  -- would be pointing at the wrong thing — the same reason
  -- `schema_membership_product.sql` gives.
  plu_id      INT NOT NULL,

  -- Exactly what the target level held before, null included. See the header:
  -- null means "no price at this level", and writing 0 back over it would give
  -- the product away.
  before_price DOUBLE NULL,
  after_price  DOUBLE NULL,

  CONSTRAINT fk_price_run FOREIGN KEY (run_id)
    REFERENCES bo_price_level_runs(id) ON DELETE CASCADE,
  KEY ix_price_run_items (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS vesopa_add_column;
