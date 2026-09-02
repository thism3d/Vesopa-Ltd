-- Change window, and the retirement of the £50 note (v1.3.2.0).
--
-- Two unrelated-looking changes that arrived in the same request from the
-- counter, and which both live in the settings tables, so they migrate
-- together.
--
-- Target is MySQL 5.7 / MariaDB, so column additions go through the same guard
-- procedure the other migrations use. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Idempotent column adder. Same shape as schema_staff_idle.sql — each
-- migration carries its own so they can be applied in any order, or singly.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- How long the change box stays up after a sale settles.
--
-- The box shows one number — what to hand back — and used to wait for a tap.
-- On a busy counter that tap does not always come: the clerk hands the money
-- over, turns to the next customer, and the till sits on a change box until
-- somebody notices. So it now counts down, and when it runs out it takes the
-- terminal where it would have gone anyway — staff signed off, idle screen up.
--
-- 30 seconds matches the venue's previous POS, which is the number the counter
-- already has a feel for. 0 switches the timer off and restores the old
-- wait-for-a-tap behaviour, for a venue that prefers it.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column(
  'epos_till_settings', 'change_window_seconds', 'INT NOT NULL DEFAULT 30');

-- ---------------------------------------------------------------------------
-- Drop £50 from the cash quick-keys.
--
-- Rare enough in UK retail that most counters will not accept one, so the key
-- is never pressed and takes the space of one that would be. The note key
-- itself is retired in schema_cash_denominations.sql; this is the quick-cash
-- row beside it.
--
-- The column default moves for databases created from now on, and the rows
-- already saved are rewritten below — a venue that never edited this setting
-- would otherwise keep the old list forever, because the default only applies
-- to inserts.
-- ---------------------------------------------------------------------------
ALTER TABLE epos_tender_settings
  MODIFY cash_presets VARCHAR(160) NOT NULL DEFAULT '500,1000,2000';

-- Only rows that still hold the *old default* exactly. A venue that has chosen
-- its own list has made a decision, and a migration must not overrule it —
-- including one that deliberately keeps £50.
UPDATE epos_tender_settings
   SET cash_presets = '500,1000,2000'
 WHERE cash_presets = '500,1000,2000,5000';

DROP PROCEDURE IF EXISTS vesopa_add_column;
