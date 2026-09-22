-- Demo venues.
--
-- "If the demo staff log with their account in the Epos, Kitchen, Menu or
-- express app they never can reach anything to the live database. Maybe
-- separate a database or do whatever solution is best for this."
--
-- The best solution here is neither a flag on every row nor a second database:
-- it is a second OFFICE. Every back-office route, every till call, every
-- kitchen ticket and every kiosk order already finds its venue the same way --
-- an office key that every table is scoped by -- so a practice venue needs no
-- filtering, no demo column on sales, and no new isolation mechanism. It is a
-- tenant, and tenants already cannot see one another. The same insight that
-- made multi-site small (src/sites.js) makes this small.
--
-- What replaces what: until now a training sale was answered 200 and written
-- NOWHERE (src/training.js), so a trainee could practise but nobody could ever
-- look at what they did. Now it is a real sale in the practice venue -- on its
-- own X and Z, in its own reports -- and the live venue's figures cannot
-- contain it because it belongs to a different tenant.
--
-- Re-runnable, like every migration here: the deploy applies every schema file
-- on every deploy.

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

-- The live office this one is a practice copy of. NULL for every real venue,
-- and NULL is what every existing row has: deploying this turns nothing into a
-- demo by accident.
--
-- A demo office is `status = 'active'` because it has to be sign-in-able -- it
-- is `demo_of` being set, not the status, that keeps it out of billing, out of
-- platform totals and out of licence counts.
CALL vesopa_add_column('offices', 'demo_of', 'INT NULL');

-- One practice venue per real one. MySQL lets any number of rows hold NULL in a
-- UNIQUE column, so this constrains the demos without constraining the 99% of
-- offices that are not one.
DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index('offices', 'uq_offices_demo_of',
                      'UNIQUE KEY uq_offices_demo_of (demo_of)');

-- When the practice venue was last re-cloned from the live one, and when its
-- practice data was last cleared. Both are shown in the back office, because
-- "why is the demo menu out of date" is answered by the first and "who wiped
-- last week's practice" by the second.
CALL vesopa_add_column('offices', 'demo_refreshed_at', 'DATETIME NULL');
CALL vesopa_add_column('offices', 'demo_reset_at', 'DATETIME NULL');

DROP PROCEDURE IF EXISTS vesopa_add_index;
DROP PROCEDURE IF EXISTS vesopa_add_column;
