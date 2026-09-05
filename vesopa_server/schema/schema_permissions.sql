-- Who may do what: on the till, and in the back office.
--
-- TWO SYSTEMS, BECAUSE THEY ARE TWO DIFFERENT QUESTIONS
--
-- A till permission group answers "may the person standing at this terminal
-- void a line?" It is checked with the broadband down, against a list the till
-- caches, by somebody who signed on with four digits.
--
-- A back-office role answers "may this login see the takings?" It is checked on
-- the server, against a session, by somebody who signed in with an email and a
-- password. An accountant gets the reports and nothing else.
--
-- Sharing one table between them would mean every till carrying a list of who
-- may edit the wallet pass artwork, and every back-office role carrying a
-- "can open the cash drawer" that means nothing in a browser.
--
-- NOTHING CHANGES FOR ANYBODY UNTIL SOMEBODY ASKS IT TO
--
-- Both links are nullable and both nulls mean "as before". A venue that has
-- never opened either screen has every member of staff unrestricted and every
-- back-office login complete, exactly as it was the day before this ran. That
-- is the only safe way to add permissions to a system that has been trading
-- without them: the alternative is a Monday morning where nobody can process a
-- refund because a table was created over the weekend.

-- ---------------------------------------------------------------------------
-- Till: staff permission groups
-- ---------------------------------------------------------------------------
--
-- Explicit columns rather than a blob. The set is small and fixed, the back
-- office draws it as a grid of switches, and a column called `can_refund` is
-- answerable in SQL when somebody asks who was allowed to refund in March.
CREATE TABLE IF NOT EXISTS epos_permission_groups (
  id                 INT AUTO_INCREMENT PRIMARY KEY,

  -- The tenant key, as everywhere else in this schema.
  email              VARCHAR(255) NOT NULL,

  name               VARCHAR(64)  NOT NULL,

  -- Opens the manager functions, and overrides an approval prompt rather than
  -- needing one. The one permission that is about standing, not about a key.
  is_manager         TINYINT(1)   NOT NULL DEFAULT 0,

  -- Money back out of the till.
  can_refund         TINYINT(1)   NOT NULL DEFAULT 0,
  can_void           TINYINT(1)   NOT NULL DEFAULT 0,
  can_discount       TINYINT(1)   NOT NULL DEFAULT 0,
  can_no_sale        TINYINT(1)   NOT NULL DEFAULT 0,

  -- Overriding a programmed price at the counter.
  can_set_price      TINYINT(1)   NOT NULL DEFAULT 0,

  -- Reading the day.
  can_x_report       TINYINT(1)   NOT NULL DEFAULT 0,
  can_z_report       TINYINT(1)   NOT NULL DEFAULT 0,

  -- Taking somebody else's table, and writing off stock.
  can_unlock_tables  TINYINT(1)   NOT NULL DEFAULT 0,
  can_expense        TINYINT(1)   NOT NULL DEFAULT 0,
  can_wastage        TINYINT(1)   NOT NULL DEFAULT 0,

  sort_order         INT          NOT NULL DEFAULT 0,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One "Manager" per venue, not one per venue per accident.
  UNIQUE KEY uq_perm_group (email, name),
  INDEX idx_perm_group_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Back office: user roles
-- ---------------------------------------------------------------------------
--
-- A JSON array of permission keys rather than columns, and for the opposite
-- reason to the table above: this set is not fixed. It has one entry per page
-- in the back office and it grows every time a page is added, which as columns
-- would be a migration per feature for ever.
CREATE TABLE IF NOT EXISTS bo_user_roles (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  display_name VARCHAR(64)  NOT NULL,
  description  VARCHAR(255) NULL,

  -- `["reports.financial_summary","catalogue.products.view", ...]`
  --
  -- LONGTEXT and not JSON: MariaDB aliases JSON to LONGTEXT anyway, and naming
  -- the alias keeps this file loadable by both servers. The application parses
  -- and validates it against the catalogue in src/permissions.js, so an unknown
  -- key is dropped on read rather than granting anything.
  permissions  LONGTEXT     NOT NULL,

  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_bo_role (email, display_name),
  INDEX idx_bo_role_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- The two links
-- ---------------------------------------------------------------------------
--
-- Added through a guarded procedure because MySQL has no
-- ADD COLUMN IF NOT EXISTS and deploy.sh re-runs every migration. See
-- schema_order_cols.sql for what happens when that is forgotten.
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

-- NULL means unrestricted, which is what every existing row is. See the note at
-- the top: a NOT NULL default here would silently take the refund key off every
-- member of staff in the country the moment this migration ran.
CALL vesopa_add_column('bo_clarks', 'permission_group_id', 'INT NULL');
CALL vesopa_add_column('backoffice_users', 'role_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- Indexed because the till's staff pull joins on it once per sync, and the
-- back office resolves it on every request that checks a permission.
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

CALL vesopa_add_index('bo_clarks', 'idx_clarks_perm_group', '`permission_group_id`');
CALL vesopa_add_index('backoffice_users', 'idx_bo_users_role', '`role_id`');

DROP PROCEDURE IF EXISTS vesopa_add_index;
