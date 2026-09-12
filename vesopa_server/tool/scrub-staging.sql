-- Make a copy of live safe to test against.
--
--   mysql vesopa_eposdb_staging < tool/scrub-staging.sql
--
-- Staging exists so a release can be run against the SHAPE of real data before
-- a venue sees it: the same number of products, the same odd catalogue, the
-- same twelve-year-old rows nobody remembers creating. It does not need, and
-- must not have, real people's names, addresses, card numbers or passwords.
--
-- RUN THIS AGAINST STAGING. NEVER AGAINST LIVE.
--
-- The guard below is not decoration. A copy-paste into the wrong terminal is
-- exactly how this kind of script destroys a customer database, so it refuses
-- to run anywhere whose database name does not end in `_staging`.

-- ---------------------------------------------------------------------------
-- The guard.
--
-- SIGNAL cannot be conditional at the top level, so it lives in a procedure
-- that is called and then dropped.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_assert_staging;
DELIMITER //
CREATE PROCEDURE vesopa_assert_staging()
BEGIN
  IF DATABASE() NOT LIKE '%\_staging' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Refusing to scrub: this is not a _staging database.';
  END IF;
END //
DELIMITER ;
CALL vesopa_assert_staging();
DROP PROCEDURE IF EXISTS vesopa_assert_staging;


-- ---------------------------------------------------------------------------
-- Overwrite a column, but only where that column exists.
--
-- This script spans releases and venues: a table gains a column in one release
-- and not another, and a scrub that died half way through on `ER_BAD_FIELD`
-- would leave a staging database holding real addresses and looking finished.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_scrub;
DELIMITER //
CREATE PROCEDURE vesopa_scrub(IN tbl VARCHAR(64), IN col VARCHAR(64), IN expr TEXT)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('UPDATE `', tbl, '` SET `', col, '` = ', expr);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS vesopa_empty;
DELIMITER //
CREATE PROCEDURE vesopa_empty(IN tbl VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) THEN
    SET @s = CONCAT('DELETE FROM `', tbl, '`');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- Members of the loyalty schemes.
--
-- Kept as ROWS -- the count and the shape are the point of testing against a
-- copy of live -- with every readable thing about them replaced. The card
-- number stays: it is not personal on its own, tills scan it, and a scheme with
-- no card numbers would test nothing.
-- ---------------------------------------------------------------------------
CALL vesopa_scrub('epos_customers', 'first_name', "CONCAT('Test', id)");
CALL vesopa_scrub('epos_customers', 'last_name',  "'Customer'");
CALL vesopa_scrub('epos_customers', 'name',       "CONCAT('Test Customer ', id)");
CALL vesopa_scrub('epos_customers', 'email',      "CONCAT('customer', id, '@vesopa.invalid')");
CALL vesopa_scrub('epos_customers', 'email_key',  "CONCAT('customer', id, '@vesopa.invalid')");
CALL vesopa_scrub('epos_customers', 'phone',      "'01000000000'");
CALL vesopa_scrub('epos_customers', 'mobile',     "'07000000000'");
CALL vesopa_scrub('epos_customers', 'address1',   "'1 Test Street'");
CALL vesopa_scrub('epos_customers', 'address2',   'NULL');
CALL vesopa_scrub('epos_customers', 'city',       "'Swansea'");
CALL vesopa_scrub('epos_customers', 'postcode',   "'SA1 1AA'");
CALL vesopa_scrub('epos_customers', 'date_of_birth', 'NULL');
CALL vesopa_scrub('epos_customers', 'notes',      'NULL');

-- ---------------------------------------------------------------------------
-- Staff.
--
-- PINs are reset to one value on purpose: a tester needs to be able to sign on,
-- and a staging database holding real PINs is a list of the door codes to every
-- till in the country.
-- ---------------------------------------------------------------------------
CALL vesopa_scrub('bo_clarks', 'pin_code',   "'1234'");
CALL vesopa_scrub('bo_clarks', 'swipe_card', "''");
CALL vesopa_scrub('bo_clarks', 'email_address', "CONCAT('clerk', id, '@vesopa.invalid')");

-- Back-office logins. The password hash goes; nobody signs into staging with a
-- live password, and a leaked staging dump must not be a leaked live one.
CALL vesopa_scrub('backoffice_users', 'password', "''");
CALL vesopa_scrub('backoffice_users', 'email', "CONCAT('user', id, '@vesopa.invalid')");

-- Nothing on staging may reach a real person. Every venue's contact address is
-- pointed at a domain that cannot resolve.
CALL vesopa_scrub('offices', 'contact_email', "CONCAT('venue', id, '@vesopa.invalid')");

-- ---------------------------------------------------------------------------
-- Things that are nothing but somebody's personal detail, or a live credential.
-- Emptied rather than rewritten: there is no version of these worth keeping.
-- ---------------------------------------------------------------------------
CALL vesopa_empty('dinein_diners');
CALL vesopa_empty('dinein_otp');
CALL vesopa_empty('epos_customer_locations');
CALL vesopa_empty('epos_push_channels');
CALL vesopa_empty('epos_push_inbox');
CALL vesopa_empty('epos_loyalty_app_sessions');
CALL vesopa_empty('epos_loyalty_app_codes');
CALL vesopa_empty('epos_wallet_devices');
CALL vesopa_empty('epos_wallet_passes');
CALL vesopa_empty('backoffice_password_resets');
CALL vesopa_empty('dojo_webhook_events');
-- Card machines and till licences belong to the real venues, not to this copy.
CALL vesopa_empty('bo_till_seats');
CALL vesopa_empty('bo_licence_keys');
CALL vesopa_empty('bo_devices');
CALL vesopa_empty('bo_device_log');

-- ---------------------------------------------------------------------------
-- Card payment configuration.
--
-- A staging server holding live Dojo keys could take a real payment from a
-- test. The keys go and the environment is forced to sandbox.
-- ---------------------------------------------------------------------------
CALL vesopa_scrub('epos_tender_settings', 'dojo_api_key', 'NULL');
CALL vesopa_scrub('epos_express_settings', 'dojo_api_key', 'NULL');

DROP PROCEDURE IF EXISTS vesopa_scrub;
DROP PROCEDURE IF EXISTS vesopa_empty;

SELECT 'Scrubbed. This database holds no real names, addresses, PINs or keys.' AS done;
