-- Whether the check view adds items up, or lists them.
--
-- Every till Vesopa has shipped consolidates: tap Carling three times and the
-- bill says `3  Carling  £10.50`. That is what most venues want and it stays
-- the default.
--
-- Some venues ask for the other thing, and their reason is not aesthetic. A
-- bill that reads `Carling / Carling / Carling` reads as the order was *called*
-- — which is how it is checked back to the table — and each line is a line to
-- void on its own rather than a quantity to edit down. Both are legitimate ways
-- to run a bar.
--
-- 1 on every existing row, which is what every venue has today. A venue that
-- never opens this setting sees no change at all.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- deploy.sh applies schema_*.sql in sort order, and epos_till_settings is
-- created by schema_staff_idle.sql ('st'). This is 'ti', so it runs after —
-- the same reason schema_till_bars.sql and schema_till_pay_bars.sql are named
-- as they are, and the trap their headers document at length.
--
-- MySQL 5.7 / MariaDB have no ADD COLUMN IF NOT EXISTS, so this goes through
-- the usual guard and is safe to run on every deploy.

DROP PROCEDURE IF EXISTS vesopa_add_till_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_till_column(
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
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_till_column('consolidate_lines',
                            'TINYINT(1) NOT NULL DEFAULT 1');

-- Whether the till asks what is in the drawer before a Z report, and how.
--
--   'off'    never ask. What every till does today.
--   'total'  one figure typed in. Fast at close, and when the till is down
--            there is nothing to say where.
--   'count'  the denomination grid the venue already has (see
--            schema_cash_denominations.sql and the till's CashNotesPanel). A
--            miscount shows up as a wrong denomination rather than a wrong
--            total.
--
-- The venue chooses, which is the answer they gave when asked: venues differ on
-- how much they trust a fast close, and a setting is cheaper than being wrong
-- for half of them.
--
-- A short VARCHAR rather than an ENUM: adding a fourth way of counting money
-- should cost a value, not a migration that rewrites the table.
CALL vesopa_add_till_column('cash_declaration',
                            "VARCHAR(8) NOT NULL DEFAULT 'off'");

DROP PROCEDURE IF EXISTS vesopa_add_till_column;
