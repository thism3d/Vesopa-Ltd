-- Apple Wallet, on top of the Google Wallet tables.
--
-- WHY THIS IS A SEPARATE FILE
--
-- schema_wallet.sql created the three tables both platforms share: what a venue
-- has branded, which classes exist, and which passes have been issued. Nothing
-- there needs changing. What Apple needs is a handful of columns beside them —
-- two more colours, and the two identifiers a `.pkpass` carries so it can be
-- updated in somebody's pocket later.
--
-- Adding them here rather than editing schema_wallet.sql keeps that file
-- matching what is already deployed, which is what makes a re-run safe to
-- reason about. `schema_wallet.sql` sorts before `schema_wallet_apple.sql`
-- (a full stop sorts before an underscore), so deploy.ps1 applies them in the
-- order they depend on.
--
-- Target is MySQL 5.7 / MariaDB. Every statement is guarded and safe to re-run.


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
      AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD INDEX `', idx, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- Two more colours.
-- ---------------------------------------------------------------------------
-- Google takes one colour and works the rest out. Apple takes three and works
-- nothing out: `backgroundColor`, `foregroundColor` (the values) and
-- `labelColor` (the small caps above them). Leave the second two blank and the
-- card renders in Apple's defaults, which on a dark background is dark grey
-- text on near-black — legible in a screenshot and not on a phone at a counter.
--
-- Blank means "use Vesopa's palette", which is deliberate: a venue that has
-- chosen nothing gets a card that looks designed rather than one that looks
-- broken.
CALL vesopa_add_column(
  'epos_wallet_settings', 'hex_foreground',
  "VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''");
CALL vesopa_add_column(
  'epos_wallet_settings', 'hex_label',
  "VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''");

-- Whether this venue issues Apple passes at all.
--
-- Separate from `enabled`, which is the whole wallet feature. A venue may be
-- live on Google and not yet on Apple, or the other way round — the two are
-- configured independently and fail independently, and one switch for both
-- would mean a Google outage turning off cards that work.
CALL vesopa_add_column(
  'epos_wallet_settings', 'apple_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');


-- ---------------------------------------------------------------------------
-- What a .pkpass carries, so it can be updated later.
-- ---------------------------------------------------------------------------
-- A pass in somebody's wallet is identified to Apple by its **serial number**,
-- and authenticated by a token it carries. Together they are what lets the
-- venue push a new points balance to a card already on a phone — without them
-- a pass is a snapshot, correct on the day it was issued and wrong from the
-- first sale afterwards.
--
-- The serial is generated once per pass and never reused, including after the
-- holder deletes the card: Apple keys its registration on it, and handing the
-- same serial to a second person would send one customer's updates to another.
CALL vesopa_add_column(
  'epos_wallet_passes', 'apple_serial',
  "VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''");

-- Bearer-style, sent by the device in an Authorization header on every update
-- check. Not a password and not derived from one — a random per-pass value, so
-- a leaked token exposes exactly one card and can be rotated by reissuing it.
CALL vesopa_add_column(
  'epos_wallet_passes', 'apple_auth_token',
  "VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''");

-- When a .pkpass was last built for this pass. Null means the holder has only
-- ever had the Google version, which is a normal and permanent state for an
-- Android customer.
CALL vesopa_add_column(
  'epos_wallet_passes', 'apple_issued_at', 'DATETIME NULL');

-- The lookup Apple's update service does on every check-in, and the one the
-- back office does when somebody asks "which card is serial ...?".
CALL vesopa_add_index(
  'epos_wallet_passes', 'idx_wallet_apple_serial', '`apple_serial`');


-- ---------------------------------------------------------------------------
-- Devices that have registered for updates.
-- ---------------------------------------------------------------------------
-- One row per (device, pass). A customer with a phone and an iPad has two, and
-- both have to be told when their points change.
--
-- The push token is Apple's, not ours, and is the only way to wake a pass. It
-- is rewritten whenever the device re-registers, because it changes — on a
-- restore from backup, on an OS upgrade — and a stale token is a card that
-- silently stops updating.
--
-- Rows are deleted when a device unregisters, which is what iOS sends when the
-- holder deletes the pass. That is the one place in this schema where deleting
-- is right: a device that has said "stop telling me" must be forgotten, not
-- marked.
CREATE TABLE IF NOT EXISTS epos_wallet_devices (
  device_id     VARCHAR(64)  CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  -- The pass, by Apple's serial rather than our row id: that is what the device
  -- sends, and translating on the way in would mean a join on every check-in.
  serial_number VARCHAR(64)  CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  pass_type_id  VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  push_token    VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (device_id, serial_number),
  KEY idx_wallet_devices_serial (serial_number),
  KEY idx_wallet_devices_office (office, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
