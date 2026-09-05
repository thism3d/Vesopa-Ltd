-- Printing categories: what order a kitchen ticket comes out in.
--
-- "Printer Categorys. This allows us to setup print category's so we can say
-- which order each category's prints. E.g. Breakfast, Mains, Desserts, Sides.
-- Kitchen printer would show
--
--     --- BREAKFAST ---
--     2 Large Breakfast
--     1 Small Breakfast
--     1 Pancakes
--     --- MAINS ---
--     2 Cod & Chips
--     1 Pizza"
--
-- WHY THIS IS NOT THE DEPARTMENT
--
-- A venue already has departments, and they are the wrong tool: a department is
-- how the *takings* are broken down and it answers to the accountant. Wine and
-- Draughts are two departments and one printing group — neither goes to a
-- kitchen at all. Mains and Sides are one department in plenty of venues and
-- two things a chef starts at different times.
--
-- So this is its own list, ordered by the venue, and a product points at one.
CREATE TABLE IF NOT EXISTS bo_print_categories (
  id         INT AUTO_INCREMENT PRIMARY KEY,

  -- The tenant key, as everywhere else in this schema.
  email      VARCHAR(255) NOT NULL,

  name       VARCHAR(64)  NOT NULL,

  -- The order it prints in. Lower first — the factory in programming.js drags
  -- these, so a venue reorders the list rather than typing numbers.
  sort_order INT          NOT NULL DEFAULT 0,

  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_print_category (email, name),
  INDEX idx_print_category_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which category a product prints under.
--
-- NULL is the ordinary answer and means "no category": the product prints last,
-- under no heading, exactly as it did before this existed. A venue with three
-- categories and four hundred products has not filed them all, and a ticket
-- that dropped the unfiled ones would lose food.
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

CALL vesopa_add_column('bo_products', 'print_category_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('CREATE INDEX `', idx, '` ON `', tbl, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- The till joins through this on every catalogue pull.
CALL vesopa_add_index('bo_products', 'idx_products_print_category', '`print_category_id`');

DROP PROCEDURE IF EXISTS vesopa_add_index;
