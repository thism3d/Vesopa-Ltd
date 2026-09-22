-- ---------------------------------------------------------------------------
-- Offering a password on the first sign-in, and remembering "not now".
--
-- Most people reach a Vesopa account for the first time through an emailed
-- code or an invitation, and never set a password at all. That is a perfectly
-- good way to sign in and it is not being taken away — but it means every
-- subsequent sign-in costs a trip to an inbox, and on a till in a bar at seven
-- in the morning that is a real cost.
--
-- So the first time somebody signs in without a password, they are offered
-- one. Offered: there is a "Skip for now" beside it, because an identity
-- provider that will not let you in until you have chosen a password is an
-- identity provider that has decided its own tidiness matters more than the
-- person standing at the till.
--
-- `password_prompt_snoozed_until` is what "for now" means. Without it, "Skip"
-- would mean "ask me again in thirty seconds, every time, for ever", which is
-- not skipping — it is nagging, and the way people answer a nag is by typing
-- the weakest thing that gets rid of it.
--
-- NOT the same column as `password_paused_until`, which already exists and
-- means something almost opposite: that an account has been recovered and its
-- password must NOT be accepted for a while. Reusing it would have been one
-- column fewer and a very good way to lock somebody out of their own account.
--
-- Re-runnable, like every migration here.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_ddl    TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_column)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- NULL means "never been asked, or asked and not skipped" — so a NULL column on
-- every existing row is exactly right: nobody has skipped anything yet, and the
-- offer is made the next time each of them signs in.
CALL vesopa_add_column(
  'users',
  'password_prompt_snoozed_until',
  'DATETIME NULL AFTER password_paused_until');

DROP PROCEDURE IF EXISTS vesopa_add_column;
