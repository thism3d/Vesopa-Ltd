-- Locking a venue's apps when its subscription has lapsed.
--
-- "Once subscription ends show the users a warning to renew, locking their
-- options in each app. From admin let us decide either we enable this locking
-- feature for each account or not."
--
-- WHAT THIS COLUMN IS FOR, AND WHY IT STARTS OFF
--
-- The decision taken was the strongest one available: a locked product does not
-- open at all, and the lock lands on the next config fetch rather than waiting
-- for a quiet moment. That is a switch worth being careful with -- a venue whose
-- card expired without anybody noticing loses the ability to trade, in the
-- middle of service, in front of a queue.
--
-- So it is PER VENUE and it starts OFF. Deploying this locks nobody: every
-- existing row is 0, and a venue only becomes lockable when somebody decides
-- that venue should be. The decision to switch it on is a commercial one and it
-- is made deliberately, for one customer at a time.
--
-- WHAT IT IS NOT ENOUGH ON ITS OWN
--
-- Being switched on does not lock anything by itself. See licences.js: a
-- product locks only when this is on AND the entitlement is actually known AND
-- the subscription is past its grace. An unreadable entitlement -- auth
-- unreachable, the venue unlinked, this migration not yet run -- never locks.
-- A billing service having an afternoon must never be the reason a bar cannot
-- open, and that rule already runs through every other layer of this.
--
-- Re-runnable, like every migration here.

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

CALL vesopa_add_column('offices', 'licence_lock_enabled',
                       'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
