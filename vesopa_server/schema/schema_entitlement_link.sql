-- The link between a venue here and what it pays Vesopa.
--
-- WHY THIS EXISTS
--
-- Two systems held the same number. auth.vesopa.com has the subscriptions --
-- with a quantity, a status and a renewal date, because that is where a
-- customer buys them. The back office grew `bo_licence_limits`, holding the
-- same count with no status and no lifecycle. Nothing joined them, so the
-- number had to be typed twice, and the copy that was wrong would be the one
-- refusing a kitchen screen mid-service.
--
-- The fix is not to delete either. They do different jobs:
--
--   auth answers WHAT IS OWED -- quantity, status, renewal.
--   the back office decides WHAT TO DO -- seats, keys, refusals.
--
-- This file adds the join, and turns bo_licence_limits from the place a number
-- is authored into a cache of what auth said, plus a deliberate override.
--
-- NOTHING CHANGES FOR AN UNMAPPED VENUE. auth_organisation_id NULL means "not
-- linked", and an unlinked venue keeps exactly today's behaviour: no limit
-- unless somebody set one here. Every venue starts NULL, so deploying this
-- changes nothing for anybody, and venues can be linked one at a time.
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

-- Which Vesopa organisation this venue is. NULL until somebody links it.
CALL vesopa_add_column('offices', 'auth_organisation_id', 'INT NULL');

-- Where a limit came from.
--
-- 'auth'     : copied from the subscription. Replaced on every refresh, so
--              editing it here is pointless and would be silently undone.
-- 'override' : typed by a person, and never overwritten. The support escape
--              hatch -- a venue given an extra till for a week while something
--              is sorted out -- and it is LABELLED, so nobody later mistakes a
--              favour for what the customer actually pays for.
--
-- Existing rows default to 'override' because that is what they are: every one
-- of them was typed by an admin before this existed.
CALL vesopa_add_column('bo_licence_limits', 'source',
                       "ENUM('auth','override') NOT NULL DEFAULT 'override'");

-- When auth was last asked. Null on an override, which is never asked about.
CALL vesopa_add_column('bo_licence_limits', 'checked_at', 'DATETIME NULL');

-- What the subscription said, kept beside the number.
--
-- Status is stored rather than acted on immediately: an expired subscription is
-- a conversation, not a cliff, and a till that stopped selling the moment a card
-- expired would be a worse fault than the unpaid invoice. The back office warns
-- on this and enforces only after a grace period.
CALL vesopa_add_column('bo_licence_limits', 'status', 'VARCHAR(24) NULL');
CALL vesopa_add_column('bo_licence_limits', 'ends_at', 'DATETIME NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
