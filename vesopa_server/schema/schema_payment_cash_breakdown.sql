-- The notes a customer actually handed over, as counted in on the till's cash
-- keys: `2000x2,500x1` for two twenties and a five.
--
-- Kept so a receipt reprinted from the back office reproduces exactly what was
-- handed over at the counter, rather than collapsing to a bare "CASH £45.00".
--
-- Guarded so re-running the migration is safe.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE()
             AND table_name = 'epos_payments'
             AND column_name = 'cash_breakdown');
SET @s := IF(@c = 0,
  'ALTER TABLE epos_payments ADD COLUMN cash_breakdown VARCHAR(255) NULL',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
