-- A membership renewal is a product a venue ticks, and it runs to a date the
-- venue sets.
--
-- WHAT CHANGED, AND WHY IT OVERRULES A DECISION ALREADY RECORDED
--
-- 1.6.8.0 answered "renew at the till" with two settings on the loyalty row:
-- one named PLU (`membership_plu`) and a rolling term
-- (`membership_term_months`), and `tasks.md` recorded the reasoning — somebody
-- joining in November should not pay a full year for two months of it.
--
-- The venue has now asked for the opposite, twice, and in their own example:
-- "if the expired card was swiped today and they paid for a membership the
-- card would expire on 31/08/2027. The date needs to be changeable." That is
-- a club season, not a rolling year, and it is the right answer for the venues
-- asking — a rugby club's membership year ends when the season does, for
-- everybody, whatever month they joined in.
--
-- So the date is added BESIDE the term rather than instead of it:
--
--   * `membership_renewal_date` set, and not in the past  -> renewals run to it
--   * otherwise                                           -> today + term months
--
-- Replacing the term outright was rejected. The first season a venue forgot to
-- roll the date forward, every renewal taken at the counter would issue a
-- membership that had already expired — and every venue already running on
-- 1.6.8.0's rolling term would have its behaviour changed underneath it by a
-- deploy nobody asked for.
--
-- WHY THE PRODUCT CARRIES A FLAG RATHER THAN THE SETTINGS CARRYING A PLU
--
-- "Set a check box on a product (Renews membership)". One named PLU cannot
-- express what a venue actually sells: full membership, concession, junior,
-- social — four products, one meaning. A flag on the product says which lines
-- on a bill renew a membership, and any number of them may.
--
-- The old setting is migrated, not deleted. A venue that named a PLU has that
-- product ticked by the backfill below and carries on exactly as it did; the
-- column stays readable so a rollback to 1.6.8.0 still finds its setting.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- Files apply in filename sort order, all of them, on every deploy.
-- `schema_commerce.sql` creates both `bo_products` and `epos_loyalty_settings`,
-- and "c" sorts before "m", so both tables exist by the time this runs. It
-- sorts after `schema_membership.sql` and `schema_membership_product.sql`
-- ("product" before "renewal"), which is where the columns it reads come from.
--
-- Deliberately a NEW file rather than an edit to either of those: both have
-- already been applied to the live database, and the guard makes re-running
-- safe without making an edited file re-apply. A migration folder where an
-- applied file changes is a folder nobody can reason about.
--
-- RE-RUNNABLE. The deploy replays every file every time, and a bare ALTER
-- fails the second time — worse, MySQL applies a multi-clause ALTER as one
-- statement, so a duplicate-column error rolls back the clauses that had
-- already succeeded. See `schema_order_cols.sql`, where that was found out the
-- expensive way.
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

-- Asked BEFORE the column is added, because the answer is what decides whether
-- the backfill at the bottom runs. See the long note down there: this is the
-- difference between carrying a venue's old setting forward once and
-- overriding their decision on every deploy for ever.
SET @first_time = NOT EXISTS (
  SELECT 1 FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'bo_products'
     AND COLUMN_NAME = 'renews_membership'
);

-- Which products renew a membership when they are paid for.
--
-- NOT NULL DEFAULT 0, so every product in every catalogue on the platform
-- keeps meaning exactly what it meant this morning. A venue opts in one
-- product at a time.
CALL vesopa_add_column(
  'bo_products', 'renews_membership', 'TINYINT(1) NOT NULL DEFAULT 0');

-- The day a renewal taken at the till runs to.
--
-- NULL is a real answer and it is the default: it means "no season, use the
-- rolling term", which is what every venue has today. It is not a placeholder
-- for a date somebody has not got round to setting.
CALL vesopa_add_column(
  'epos_loyalty_settings', 'membership_renewal_date', 'DATE NULL');

-- ---------------------------------------------------------------------------
-- Carry the old setting forward
-- ---------------------------------------------------------------------------
-- A venue that named a PLU in 1.6.8.0 gets that product ticked, so the till
-- behaves identically the moment it updates.
--
-- ONCE, AND ONLY ON THE DEPLOY THAT ADDS THE COLUMN.
--
-- This is the whole reason for `@first_time` at the top. An UPDATE that ran on
-- every deploy would be re-asserting a 1.6.8.0 setting for ever: a venue that
-- ticks a different product and unticks the old one would find the old one
-- ticked again the next time anybody deployed, and would have no way to make it
-- stop. That is precisely the "same data being manipulated again and again"
-- the venue reported about the void reasons, and the reason
-- `schema_layout.sql` now guards its own seeds on the table being empty.
--
-- So the backfill is bound to the moment the column appears. After that the
-- column is the venue's to set, and this file never touches it again.
--
-- Scoped by office on both sides. `bo_products.pluid` is unique PER VENUE and
-- not across the platform, so an unscoped update would tick one product in
-- every catalogue that happens to use the same number — which on this platform
-- is most of them, because PLUs start at 1 everywhere.
--
-- Through a prepared statement because a bare `IF` is not legal at the top
-- level of a script; `DO 0` is the no-op branch.
SET @backfill = IF(@first_time,
  'UPDATE bo_products p
     JOIN epos_loyalty_settings s
       ON s.office = p.email
      AND s.membership_plu IS NOT NULL
      AND s.membership_plu > 0
      AND p.pluid = s.membership_plu
      SET p.renews_membership = 1',
  'DO 0');
PREPARE stmt FROM @backfill;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The procedure is left behind exactly as every other migration here leaves
-- it: each file drops and recreates it at the top, and a file that tidied up
-- after itself would only differ from its neighbours.
DROP PROCEDURE IF EXISTS vesopa_add_column;
