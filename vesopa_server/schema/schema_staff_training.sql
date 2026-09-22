-- Training accounts.
--
-- "Create a staff account specifically for Training Mode. Sales made in
-- Training Mode should not be sent to the back office and should not count
-- towards the sales figures on the till."
--
-- One flag on the member of staff, because that is where the question lives: a
-- till knows who is signed on, and a trainee is a person, not a till setting a
-- manager has to remember to switch back. Everything else follows from it -- the
-- till marks the bills a training account rings up and keeps them to itself, and
-- the server refuses to record a sale from one even if an older till sends it
-- (see src/training.js).
--
-- Re-runnable, like every migration here: deploy applies every schema file on
-- every deploy.

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

-- 0 for every member of staff who exists today, so nobody who is selling for
-- real becomes a trainee by being deployed over.
CALL vesopa_add_column('bo_clarks', 'training', 'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
