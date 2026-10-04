-- Modules: the parts of the system only some venues get.
--
-- "Only the supported venues gets that. We can add new system or remove or stop
-- any existing systems from the administration." (owner, 2026-10-04)
--
-- TWO SWITCHES, AND WHO HOLDS EACH
--
--   * `allowed` is Vesopa's. Set from Admin > Offices when a venue is created
--     or later. It is the ceiling: nothing a module owns appears anywhere for a
--     venue that is not allowed it, whatever the venue's own settings say.
--   * `enabled` is the venue manager's. Once a module is allowed, the manager
--     turns it on or off from the back office. The owner chose this split on
--     2026-10-04 ("Admin, then manager").
--
-- The gym door already had its manager switch (`epos_gym_settings.enabled`)
-- before modules existed, so for `gym_door` that column stays the manager's
-- switch and `enabled` here is unused. One switch, one place.
--
-- WITHDRAWING A MODULE KEEPS THE DATA
--
-- Turning `allowed` off hides the module and stops it charging; it deletes
-- nothing. Members, visits and plans are still there if it is allowed again --
-- a venue that stops paying for a month must not lose its member list.
--
-- PRICES
--
-- "Yes, a set price" (owner, 2026-10-04). Each module has a default monthly
-- price in `bo_module_prices`; a venue's row copies it when the module is
-- allowed and can be changed per venue. The venue's next invoice adds every
-- allowed module's price to its subscription. Minor units, like every other
-- money column here.
--
-- Sorts after schema_tenancy.sql (offices, subscription_invoices) and
-- schema_till_gym.sql (the backfill reads epos_gym_settings). Re-runnable: the
-- deploy applies every file in this folder on every deploy.

CREATE TABLE IF NOT EXISTS bo_module_prices (
  module        VARCHAR(32)  NOT NULL PRIMARY KEY,
  price_minor   INT          NOT NULL DEFAULT 0,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_venue_modules (
  office_id     INT          NOT NULL,
  module        VARCHAR(32)  NOT NULL,
  allowed       TINYINT(1)   NOT NULL DEFAULT 0,
  enabled       TINYINT(1)   NOT NULL DEFAULT 0,
  -- Per-venue monthly price while allowed. NULL charges the default price.
  price_minor   INT          NULL,
  allowed_at    DATETIME     NULL,
  allowed_by    VARCHAR(190) NULL,
  enabled_at    DATETIME     NULL,
  enabled_by    VARCHAR(190) NULL,
  PRIMARY KEY (office_id, module),
  CONSTRAINT fk_venue_modules_office FOREIGN KEY (office_id)
    REFERENCES offices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- What an invoice was made of. Without it, an invoice that grew by the gym's
-- £20 reads as a price rise nobody can explain.
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
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

CALL vesopa_add_column('subscription_invoices', 'modules_minor', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('subscription_invoices', 'modules_detail', 'VARCHAR(500) NULL');

-- A venue already running the gym keeps it. Before modules, the manager's own
-- switch was the only one; allowing the module for every venue that had turned
-- it on means this deploy changes nothing anybody can see. Price NULL and
-- allowed_by 'migration', so nobody is billed for a gym they already had until
-- an admin decides they should be.
INSERT IGNORE INTO bo_venue_modules
  (office_id, module, allowed, enabled, price_minor, allowed_at, allowed_by)
SELECT o.id, 'gym_door', 1, 1, 0, NOW(), 'migration'
  FROM offices o
  JOIN epos_gym_settings g
    ON g.office = o.contact_email COLLATE utf8mb4_general_ci
 WHERE g.enabled = 1;
