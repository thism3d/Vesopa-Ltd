-- ===========================================================================
-- Which app is allowed to interrupt somebody, and whether it may make a noise.
-- ===========================================================================
--
-- The venue asked for Windows notifications on every app, and — the important
-- half — for one place to decide which notification goes where: "give
-- centralized option in the back office".
--
-- So the decision lives on the venue's till-settings row, beside every other
-- thing a manager sets once for the building, and each app reads it. An app
-- also keeps a local switch, because a manager standing at a quiet till at
-- eight in the morning should be able to turn the noise off without opening a
-- browser.
--
-- HOW THE TWO COMBINE, stated once so three apps do not each invent it:
--
--     effective = notify_master AND <the event's column> AND <app-local toggle>
--
-- The back office can therefore switch a whole class of notification off for
-- every terminal in the building, and a device can opt out of what it is
-- allowed. Neither can turn on what the other has turned off, which is what
-- makes "centralized" mean anything.
--
-- SORT ORDER. `epos_till_settings` is created by schema_staff_idle.sql ("st").
-- This is "ti", so it runs after — the same reason schema_till_bars.sql and
-- schema_till_pay_bars.sql are named as they are. Their headers document the
-- venue that lost its printer names to getting this wrong.
--
-- WHY THE DISPLAY DEFAULTS OFF
--
-- It is a screen facing a queue. A toast sliding over a customer's bill is a
-- notification aimed at nobody: the person who needs to know is behind the
-- counter, looking at the till. It exists so a venue that mounts a display in
-- a back office can switch it on, not because it is wanted at the front.
--
-- RE-RUNNABLE. Every deploy replays every file here.
-- ===========================================================================

DROP PROCEDURE IF EXISTS vesopa_add_notify_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_notify_column(
  IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'epos_till_settings'
       AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `epos_till_settings` ADD COLUMN `', col,
                    '` ', ddl);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- The master switch. One tick to silence every terminal in the building.
CALL vesopa_add_notify_column('notify_master', 'TINYINT(1) NOT NULL DEFAULT 1');

-- A customer has ordered from a QR code. Both the till and the kitchen want to
-- know, and which of them is actually watching differs by venue — a bar runs
-- the till, a kitchen runs the board — so each is its own switch rather than
-- one "new order" that is wrong for half of them.
CALL vesopa_add_notify_column('notify_till_dinein_new',
                              'TINYINT(1) NOT NULL DEFAULT 1');
CALL vesopa_add_notify_column('notify_kitchen_dinein_new',
                              'TINYINT(1) NOT NULL DEFAULT 1');

-- A till has sent food to the pass. Kitchen only: the till knows, it sent it.
CALL vesopa_add_notify_column('notify_kitchen_ticket_new',
                              'TINYINT(1) NOT NULL DEFAULT 1');

-- Sound, separately from the toast.
--
-- A silent toast is genuinely useful on a bar where the music is loud enough
-- that a chime is noise and a light on the screen is not, and a kitchen that
-- cannot hear over an extractor wants the opposite. Tying the two together
-- would force one venue to choose between being interrupted and being told.
CALL vesopa_add_notify_column('notify_till_sound',
                              'TINYINT(1) NOT NULL DEFAULT 1');
CALL vesopa_add_notify_column('notify_kitchen_sound',
                              'TINYINT(1) NOT NULL DEFAULT 1');

-- The customer display. Off, for the reason in the header.
CALL vesopa_add_notify_column('notify_display_enabled',
                              'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_notify_column;
