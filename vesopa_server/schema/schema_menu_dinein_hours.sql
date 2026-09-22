-- ===========================================================================
-- Dine-in: opening hours, and the people who order.
-- ===========================================================================
--
-- SORT ORDER MATTERS. This file adds columns to `dinein_venue` and
-- `dinein_orders`, which `schema_menu_dinein.sql` creates. The deploy applies
-- every file in this directory in sorted order, and "schema_menu_dinein.sql"
-- sorts before "schema_menu_dinein_hours.sql" because "." is 0x2E and "_" is
-- 0x5F. Do not rename either of them without checking that again — the deploy
-- loop swallows a failure with "(skipped: already applied or not needed)", so
-- getting this wrong means the columns silently never appear.
--
-- RE-RUNNABLE. Every deploy replays every file here. An unguarded ALTER would
-- throw on the second run, and because failures are swallowed, an unguarded
-- CREATE ... SELECT would quietly do nothing while looking like it worked.
-- ===========================================================================

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN t VARCHAR(64), IN c VARCHAR(64), IN spec VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD COLUMN `', c, '` ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Opening hours
-- ---------------------------------------------------------------------------
--
-- Held as JSON in one column rather than as seven rows in a table of its own.
--
-- It is read on every page load and written whole, by one form, for one venue.
-- There is no query that wants "every venue open at 3pm on a Tuesday", and if
-- one ever appears it will want a table and this can become one. Seven rows per
-- venue to answer a question nobody asks is a join on the hot path for nothing.
--
-- Shape: an array of exactly seven objects, Monday first, each
--   { "closed": false, "open": "11:00", "close": "23:00" }
-- A venue that serves past midnight writes a close earlier than its open and
-- the application reads it as running into the next day — see `isOpenNow` in
-- src/dinein.js, which is the only thing that interprets this.
CALL vesopa_add_column('dinein_venue', 'opening_hours', 'TEXT NULL');

-- Whether the hours are enforced at all.
--
-- ON by default, as asked. A venue that has not filled its hours in is treated
-- as always open — an empty schedule must never be read as "closed for ever",
-- which would take every existing venue's ordering off the moment this file
-- was applied.
CALL vesopa_add_column(
  'dinein_venue', 'schedule_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'
);

-- What the venue wants said when it is shut. Optional; there is a sensible
-- default in the page.
CALL vesopa_add_column('dinein_venue', 'closed_message', 'VARCHAR(300) NULL');

-- How long, in minutes, a venue tells a customer to expect. Shown on the
-- tracker once a clerk has accepted the order.
CALL vesopa_add_column(
  'dinein_venue', 'eta_minutes', 'INT NOT NULL DEFAULT 25'
);

-- ---------------------------------------------------------------------------
-- The people who order
-- ---------------------------------------------------------------------------
--
-- Ordering as a guest is the default and always will be: a person sitting at a
-- table with a plate coming is not going to make an account first, and asking
-- them to is how a QR menu gets abandoned halfway.
--
-- An account exists only so that somebody who wants their order history can
-- have it. It buys them exactly that.
--
-- SCOPED PER VENUE, deliberately. Every other table in this system is scoped by
-- office_id, the back office can only ever see its own rows, and a single
-- platform-wide identity would put one venue's customer list within reach of a
-- bug in another venue's code path. Somebody who eats at two venues on this
-- platform makes two accounts, which is the same as every other pub loyalty
-- scheme they already have.
CREATE TABLE IF NOT EXISTS dinein_diners (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  office_id  INT NOT NULL,

  email      VARCHAR(190) NOT NULL,
  -- bcrypt, same as every other password in this database.
  pass_hash  VARCHAR(255) NOT NULL,
  name       VARCHAR(120) NULL,
  phone      VARCHAR(40) NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen  DATETIME NULL,

  -- One account per address per venue. 190 characters because utf8mb4 indexes
  -- cap at 767 bytes and 190 x 4 is the most that fits.
  UNIQUE KEY uq_dinein_diner (office_id, email),
  INDEX idx_dinein_diner_office (office_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which account placed an order, when one did. Null for every guest order,
-- which is most of them.
CALL vesopa_add_column('dinein_orders', 'diner_id', 'INT NULL');

-- What the customer was told to expect when the order was accepted, in
-- minutes. Stored on the order rather than read from the venue at display
-- time, so that changing the venue's default does not silently move the clock
-- on somebody who is already waiting.
CALL vesopa_add_column('dinein_orders', 'eta_minutes', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN t VARCHAR(64), IN i VARCHAR(64), IN spec VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND INDEX_NAME = i
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD INDEX `', i, '` ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index('dinein_orders', 'idx_dinein_orders_diner', '(diner_id, placed_at)');

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
