-- Licences for every app, bound to the machine.
--
-- "If they pay for two kitchen apps then let two devices log in... we provide
-- the license key and only activate it on that device and store hardware
-- information."
--
-- WHAT WAS HERE BEFORE, AND WHY IT WAS NOT ENOUGH
--
-- schema_till_licences.sql added `offices.till_licences` (one number) and
-- `bo_till_seats` (one row per signed-in till). Two gaps:
--
--   1. Only tills were counted. A venue paying for one kitchen screen could run
--      six, because nothing but `kind = 'till'` ever took a seat.
--   2. The identity a seat was keyed on is a UUID the device generates and keeps
--      in its own settings. A reinstall makes a new one; a copied install brings
--      the old one along. That is a nickname, not a licence.
--
-- Both are fixed here without moving what already works: `bo_till_seats` keeps
-- its name and gains a `kind`, and the per-app counts live beside it.
--
-- NOTHING LOCKS ANYBODY OUT ON DEPLOY. A venue with no row in bo_licence_limits
-- has no limit for that app, exactly as a NULL till_licences meant no limit.
-- The numbers are set per venue by the platform admin, afterwards, on purpose.
--
-- Re-runnable, like every migration here.

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

-- Which app a seat belongs to. Every row that exists today is a till, which is
-- what the default says, so the count a venue sees does not change on deploy.
CALL vesopa_add_column('bo_till_seats', 'kind',
                       "VARCHAR(24) NOT NULL DEFAULT 'till'");

-- The machine a seat is actually on. Null for every seat taken before licence
-- keys existed, and for a device on a release too old to send one -- which is
-- why it is never the thing a sign-in is refused for on its own.
CALL vesopa_add_column('bo_till_seats', 'device_fingerprint', 'CHAR(64) NULL');

-- The licence key this seat was taken with, where one was used.
CALL vesopa_add_column('bo_till_seats', 'licence_key_id', 'INT NULL');


-- How many of each app a venue has paid for.
--
-- A row per app rather than a column per app: "display" was not a thing anybody
-- licensed when till_licences was added, and the next app will not be either.
-- No row means no limit for that app.
CREATE TABLE IF NOT EXISTS bo_licence_limits (
  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,

  -- 'till' | 'kitchen' | 'display' | 'express'. Free text, matching
  -- bo_devices.kind, so an app invented later is recorded and not refused.
  kind        VARCHAR(24) NOT NULL,

  seats       INT NOT NULL,

  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP,
  updated_by  VARCHAR(190) NULL,

  PRIMARY KEY (office, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- One licence key.
--
-- THE KEY ITSELF IS NOT STORED. Only a hash of it, and the first few characters
-- so a human can tell two apart on screen. A key is shown once, when it is
-- issued; if it is lost it is revoked and another is issued, which takes a
-- moment and cannot go wrong in the way a database of readable keys can. This
-- repository is public and has already had one shared secret in its history.
--
-- `device_fingerprint` is what "activated on that device" means: a hash of
-- values a copied install cannot bring with it -- the Windows MachineGuid, the
-- motherboard serial and the system drive serial. The first machine to present
-- the key claims it; any other machine presenting the same key is refused and
-- told to ask Vesopa, which is the point.
CREATE TABLE IF NOT EXISTS bo_licence_keys (
  id            INT AUTO_INCREMENT PRIMARY KEY,

  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,
  kind          VARCHAR(24) NOT NULL,

  key_hash      CHAR(64) NOT NULL,
  -- The readable half: "VES-TILL-A1B2…", for telling keys apart in a list.
  key_prefix    VARCHAR(24) NOT NULL,

  -- What it is for, in the venue's words: "Bar till", "Kitchen - pass".
  label         VARCHAR(120) NULL,

  device_fingerprint CHAR(64)    NULL,
  device_id          VARCHAR(64) NULL,
  device_name        VARCHAR(120) NULL,
  activated_at       DATETIME    NULL,
  activated_by       VARCHAR(190) NULL,

  -- Set when Vesopa takes the key back, or when a venue moves it to new
  -- hardware: the row is kept either way, because "which machine was this on
  -- before" is the question asked the day after a till is replaced.
  revoked_at    DATETIME NULL,
  revoked_by    VARCHAR(190) NULL,

  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by    VARCHAR(190) NULL,

  UNIQUE KEY uq_licence_key_hash (key_hash),
  KEY idx_licence_keys_office (office, kind, revoked_at),
  KEY idx_licence_keys_device (office, device_fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- Carry the single number that exists today into the per-app table, so a venue
-- the admin has already given two till licences keeps them.
--
-- INSERT IGNORE, so re-running the migration never overwrites a limit somebody
-- has since changed on the new screen.
-- No mention of demo_of here on purpose, though a practice venue must never be
-- licensed: it is another migration's column, and a file that reads one is a
-- file that fails if the deploy ever applies them in another order. It does not
-- need it -- a practice venue is created with till_licences NULL and so is not
-- selected anyway.
INSERT IGNORE INTO bo_licence_limits (office, kind, seats, updated_by)
SELECT o.contact_email, 'till', o.till_licences, 'migrated from offices.till_licences'
  FROM offices o
 WHERE o.till_licences IS NOT NULL;

DROP PROCEDURE IF EXISTS vesopa_add_column;
