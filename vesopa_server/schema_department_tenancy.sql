-- Make categories and groups insertable, and make them belong to somebody.
--
-- `bo_product_departments` and `bo_product_groups` came over from the PHP
-- schema with two NOT NULL columns that no code writes:
--
--   email  varchar(255) NOT NULL   -- the tenant key the rest of the catalogue uses
--   pluid  int(11)      NOT NULL   -- meaningless on a category; every recent row is 0
--
-- Neither has a default, so under MySQL's strict mode every INSERT failed on a
-- column the form never showed. That is the "can't be null" a manager hit when
-- they added a category and gave its button a picture: nothing was wrong with
-- the image, the row could simply never be written.
--
-- `email` is now stamped by the CRUD factory (see programming.js). `pluid` is
-- given a default here instead, because there is nothing meaningful to stamp
-- it with — it is a leftover, and a leftover should not be able to stop a
-- category being created.
--
-- MODIFY is idempotent: running it twice sets the same definition twice.
ALTER TABLE bo_product_departments
  MODIFY COLUMN pluid int(11) NOT NULL DEFAULT 0;

ALTER TABLE bo_product_groups
  MODIFY COLUMN pluid int(11) NOT NULL DEFAULT 0;

-- Anything already written without an owner would be invisible once the reads
-- are scoped, so adopt it. Only a single-office install can have such rows — a
-- multi-office install could not have created them — so the only office there
-- is, is the right owner.
UPDATE bo_product_departments
   SET email = (SELECT contact_email FROM offices ORDER BY id LIMIT 1)
 WHERE (email IS NULL OR email = '')
   AND (SELECT COUNT(*) FROM offices) = 1;

UPDATE bo_product_groups
   SET email = (SELECT contact_email FROM offices ORDER BY id LIMIT 1)
 WHERE (email IS NULL OR email = '')
   AND (SELECT COUNT(*) FROM offices) = 1;

-- Reads are now scoped by email, so this is the column every category listing
-- filters on. Created through a guarded procedure because MySQL has no
-- CREATE INDEX IF NOT EXISTS and deploy.sh re-runs every migration.
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

CALL vesopa_add_index('bo_product_departments', 'idx_bo_departments_email', '`email`');
CALL vesopa_add_index('bo_product_groups', 'idx_bo_groups_email', '`email`');

DROP PROCEDURE IF EXISTS vesopa_add_index;
