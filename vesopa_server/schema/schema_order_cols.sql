-- The till gained discounts, covers and notes; the server's orders table never
-- did, so those fields were being dropped on sync.
--
-- WHY THIS IS NOT ONE `ALTER TABLE` ANY MORE
--
-- It used to be, and that made it the one migration in this folder that could
-- not be re-run — which matters, because `deploy.sh --schema` re-runs all of
-- them and says in its own help that doing so is safe.
--
-- The failure was worse than a wasted run. MySQL applies a multi-column ALTER
-- as one statement: hit `Duplicate column name 'customer_name'` on the fourth
-- clause and the first three are rolled back with it. Any database that had
-- picked up `customer_name` from elsewhere — the PHP schema had it — therefore
-- ended up with *none* of these columns, for ever, however many times the
-- migration was applied. `discount_minor` and `covers` are read by the Till
-- Report and the Bill Report, so the symptom is two back-office pages answering
-- 500 on a database that looks migrated.
--
-- Each column is now added on its own and only if it is absent, so a database
-- holding some of them gets the rest instead of nothing.
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

CALL vesopa_add_column('epos_orders', 'discount_minor', 'INT NOT NULL DEFAULT 0 AFTER subtotal_minor');
CALL vesopa_add_column('epos_orders', 'covers',         'INT NULL');
CALL vesopa_add_column('epos_orders', 'notes',          'VARCHAR(500) NULL');
CALL vesopa_add_column('epos_orders', 'customer_name',  'VARCHAR(255) NULL');
CALL vesopa_add_column('epos_orders', 'session_id',     'CHAR(36) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
