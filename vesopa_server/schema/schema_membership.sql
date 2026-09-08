-- Memberships that expire, and a face to check a card against.
--
-- Three columns for 1.6.8.0:
--
--   * `epos_customers.photo_url` — "Ability to upload a photo of a customer
--     that would display on the till when scanned to confirm it's the right
--     person." A membership card is a bearer token: the till has no way of
--     knowing whether the person holding it is the member until somebody can
--     look at a face.
--
--   * `epos_loyalty_settings.membership_term_months` and
--     `membership_fee_minor` — "say they expired and then paid £10 membership
--     at the till, the till should then renew to a date we set in the back
--     office." The date is not set at the till; the *term* is set in the back
--     office and the till adds it to today. Twelve months and £10 are the
--     venue's own example, so they are the defaults.
--
-- Sorts after `schema_customers.sql` and `schema_commerce.sql`, both of which
-- begin with "c", so the tables exist by the time this runs. There are no
-- numeric prefixes in this folder: files apply in filename order and each one
-- must sort after whatever creates the table it alters.
--
-- RE-RUNNABLE, AND WHY THAT IS NOT OPTIONAL
--
-- The deploy applies every file in this folder on every deploy. A bare
-- `ALTER TABLE ... ADD COLUMN` fails the second time — and because MySQL
-- applies a multi-clause ALTER as a single statement, a duplicate-column error
-- rolls back the clauses that had already succeeded. A database that already
-- held one of these columns would therefore get none of the others, for ever,
-- however many times it was applied. See `schema_order_cols.sql`, which is
-- where that was found out the expensive way.
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

-- A path under /uploads, the same shape a product image or a venue logo takes.
-- 500 to match `notes` beside it; an uploaded name is a UUID and a suffix, so
-- the length is for anybody who later stores a full URL here.
CALL vesopa_add_column('epos_customers', 'photo_url', 'VARCHAR(500) NULL');

-- Months, not a date. A date in the back office would need editing every year
-- and would be wrong for everybody who joined on a different day; a term is
-- set once and is right for every renewal the till ever takes.
CALL vesopa_add_column(
  'epos_loyalty_settings', 'membership_term_months', 'SMALLINT NOT NULL DEFAULT 12');

-- Minor units, like every other money column in this schema. £10 by default,
-- because that is the figure the venue used when they asked for it.
CALL vesopa_add_column(
  'epos_loyalty_settings', 'membership_fee_minor', 'INT NOT NULL DEFAULT 1000');

-- The procedure is deliberately left behind, as every other migration here
-- leaves it: each file drops and recreates it at the top, and a file that
-- tidied up after itself would only differ from its neighbours.
