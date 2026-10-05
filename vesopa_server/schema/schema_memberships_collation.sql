-- Memberships and venue modules: the new tables speak the old tables' collation
-- (2026-10-05).
--
-- The live MariaDB defaults new tables to utf8mb4_uca1400_ai_ci, while
-- epos_customers, offices and the rest were made under utf8mb4_general_ci.
-- Comparing a column of one with a column of the other ("Illegal mix of
-- collations ... for operation '='") broke Metric's member sync on the first
-- day. Each table made by schema_venue_modules.sql and schema_memberships.sql
-- is converted to whatever epos_customers.email_key uses, so it matches on
-- every server whatever its default. A table that already matches is left
-- alone, so this is safe to run again.

DELIMITER //
DROP PROCEDURE IF EXISTS vesopa_match_collation //
CREATE PROCEDURE vesopa_match_collation(IN t VARCHAR(64))
BEGIN
  DECLARE want VARCHAR(64) DEFAULT NULL;
  DECLARE have VARCHAR(64) DEFAULT NULL;
  SELECT COLLATION_NAME INTO want FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'epos_customers' AND COLUMN_NAME = 'email_key' LIMIT 1;
  SELECT TABLE_COLLATION INTO have FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t LIMIT 1;
  IF want IS NOT NULL AND have IS NOT NULL AND want <> have THEN
    SET @vesopa_sql = CONCAT('ALTER TABLE `', t, '` CONVERT TO CHARACTER SET utf8mb4 COLLATE ', want);
    PREPARE vesopa_stmt FROM @vesopa_sql;
    EXECUTE vesopa_stmt;
    DEALLOCATE PREPARE vesopa_stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_match_collation('bo_module_prices');
CALL vesopa_match_collation('bo_module_promos');
CALL vesopa_match_collation('bo_venue_modules');
CALL vesopa_match_collation('epos_membership_events');
CALL vesopa_match_collation('epos_membership_payments');
CALL vesopa_match_collation('epos_classes');
CALL vesopa_match_collation('epos_class_timetable');
CALL vesopa_match_collation('epos_class_sessions');
CALL vesopa_match_collation('epos_class_bookings');
CALL vesopa_match_collation('epos_partner_keys');

DROP PROCEDURE IF EXISTS vesopa_match_collation;
