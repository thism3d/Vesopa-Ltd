-- Apple Wallet passes: the PassKit web service state a phone needs so a card
-- already installed learns its balance changed, without the customer doing
-- anything.
--
-- Named to sort after schema_wallet.sql — it adds columns to epos_wallet_passes,
-- which that file creates. See the note at the top of schema_till_change_window.sql
-- for why the filename is the ordering, and schema_branding.sql for the
-- idempotent-column-add pattern used below (this target is MySQL 5.7, which
-- has no `ADD COLUMN IF NOT EXISTS`).

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

-- `apple_serial` is derivable (wallet_apple.serialFor hashes office+kind+
-- subject), but stored anyway so the pass a phone is asking about can be
-- found without recomputing a hash on every request, and so the hash
-- algorithm is free to change later without stranding passes already issued.
--
-- `apple_auth_token` is the secret pass.json's authenticationToken carries.
-- Generated once, on first mint, and never rotated: a phone sends back
-- whatever token its copy of the pass holds, on every PassKit web service
-- call it ever makes, and a token that changed under it would lock that
-- phone out of its own updates.
CALL vesopa_add_column('epos_wallet_passes', 'apple_serial',      'CHAR(40) NULL');
CALL vesopa_add_column('epos_wallet_passes', 'apple_auth_token',  'CHAR(32) NULL');

-- The public half of the enrolment link. Without it /wallet/join/ is keyed by
-- the office's contact email, which means the venue's own email address is
-- printed on the poster and sits in every customer's browser history. A slug
-- is what a venue would have chosen in the first place if asked.
CALL vesopa_add_column('epos_wallet_settings', 'join_slug', 'VARCHAR(64) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;

-- Give the new column a way back to the row, for the PassKit endpoints that
-- arrive with a serial number and nothing else. MySQL has no CREATE INDEX IF
-- NOT EXISTS and deploy.sh re-runs every migration, so this goes through the
-- same guarded-procedure pattern as schema_department_tenancy.sql.
DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('CREATE INDEX `', idx, '` ON `', tbl, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index('epos_wallet_passes', 'idx_wallet_pass_apple_serial', '`apple_serial`');

-- Unique, because a slug that resolved to two venues would hand a customer
-- somebody else's loyalty card.
DROP PROCEDURE IF EXISTS vesopa_add_unique;
DELIMITER //
CREATE PROCEDURE vesopa_add_unique(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('CREATE UNIQUE INDEX `', idx, '` ON `', tbl, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_unique('epos_wallet_settings', 'uq_wallet_join_slug', '`join_slug`');

DROP PROCEDURE IF EXISTS vesopa_add_unique;

DROP PROCEDURE IF EXISTS vesopa_add_index;

-- ---------------------------------------------------------------------------
-- One row per phone that has ever registered for updates to at least one
-- pass. `device_library_identifier` is a phone-generated opaque id — not an
-- Apple device identifier, just a value Wallet invents and reuses across every
-- pass it registers on that phone, which is what makes it possible to push
-- all of a phone's passes without asking Apple which device is which.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_wallet_apple_devices (
  device_library_id VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  push_token         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Which passes each device wants to hear about. A phone registers per pass,
-- not per device, because it only asks Wallet's web service about the specific
-- card it was told to watch — a phone with a loyalty card and a staff card
-- from the same venue sends two registrations, one per serial number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_wallet_apple_registrations (
  device_library_id    VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  pass_type_identifier VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  serial_number         VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_library_id, pass_type_identifier, serial_number),
  KEY idx_wallet_apple_reg_pass (pass_type_identifier, serial_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
