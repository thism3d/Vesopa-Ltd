-- ===========================================================================
-- Dine-in: signing in with a code, and an optional password afterwards.
-- ===========================================================================
--
-- SORT ORDER, again. This alters `dinein_diners`, which
-- schema_menu_dinein_hours.sql creates. Sorted:
--
--     schema_menu_dinein.sql          (".")
--     schema_menu_dinein_hours.sql    ("_h")
--     schema_menu_dinein_offers.sql   ("_o", then "f")
--     schema_menu_dinein_otp.sql      ("_o", then "t")
--
-- "offers" before "otp" because 'f' < 't'. This runs last of the four.
--
-- RE-RUNNABLE. Every deploy replays every file here.
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
-- A password is now optional
-- ---------------------------------------------------------------------------
--
-- Signing in is a code sent to an address or a number. A password is something
-- somebody may add afterwards if they want a faster way back in, and most will
-- not — so the column has to be able to say "there isn't one" rather than
-- holding a hash of something nobody chose.
--
-- Guarded on IS_NULLABLE rather than run unconditionally: MODIFY would succeed
-- every time, but it rewrites the table, and this file runs on every deploy.
DROP PROCEDURE IF EXISTS vesopa_relax_pass;
DELIMITER //
CREATE PROCEDURE vesopa_relax_pass()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dinein_diners'
       AND COLUMN_NAME = 'pass_hash' AND IS_NULLABLE = 'NO'
  ) THEN
    ALTER TABLE dinein_diners MODIFY pass_hash VARCHAR(255) NULL;
  END IF;
END //
DELIMITER ;
CALL vesopa_relax_pass();
DROP PROCEDURE IF EXISTS vesopa_relax_pass;

-- How they signed in, and whether the address or number has been proved.
CALL vesopa_add_column('dinein_diners', 'phone_e164', 'VARCHAR(24) NULL');
CALL vesopa_add_column('dinein_diners', 'country', 'CHAR(2) NULL');
CALL vesopa_add_column('dinein_diners', 'email_verified_at', 'DATETIME NULL');
CALL vesopa_add_column('dinein_diners', 'phone_verified_at', 'DATETIME NULL');

-- An account created from a phone number has no email, and one created from an
-- email has no number. The column was NOT NULL with a unique key across
-- (office_id, email); a phone-only account needs to be able to leave it empty,
-- and MySQL allows any number of NULLs in a unique index.
DROP PROCEDURE IF EXISTS vesopa_relax_email;
DELIMITER //
CREATE PROCEDURE vesopa_relax_email()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dinein_diners'
       AND COLUMN_NAME = 'email' AND IS_NULLABLE = 'NO'
  ) THEN
    ALTER TABLE dinein_diners MODIFY email VARCHAR(190) NULL;
  END IF;
END //
DELIMITER ;
CALL vesopa_relax_email();
DROP PROCEDURE IF EXISTS vesopa_relax_email;

-- ---------------------------------------------------------------------------
-- The challenges
-- ---------------------------------------------------------------------------
--
-- One row per code sent. Kept rather than held in memory because the server is
-- restarted by every deploy, and a customer holding a code that stopped
-- existing mid-meal has no way to tell that from a code that never worked.
--
-- WHAT IS AND IS NOT STORED
--
-- For email, `code_hash` is a SHA-256 of the code with a per-row salt. The code
-- itself is never written down: an OTP table in plain text is a list of live
-- credentials, and the one thing worse than a leaked password database is a
-- leaked one nobody thought counted.
--
-- For phone, there is no code here at all. Postcoder generates it, sends it and
-- checks it, and `provider_ref` is the id it gave us. We could not verify one of
-- those offline if we wanted to.
CREATE TABLE IF NOT EXISTS dinein_otp (
  id           INT AUTO_INCREMENT PRIMARY KEY,

  -- What the customer's browser holds. Random, because it addresses a
  -- challenge and a sequential id would let anybody guess somebody else's.
  public_id    CHAR(32) NOT NULL,

  office_id    INT NOT NULL,

  channel      ENUM('email','phone') NOT NULL,
  -- The address or the number, normalised: lower case for email, E.164 for a
  -- phone. Normalised so that the rate limit cannot be walked around by
  -- changing the spacing.
  destination  VARCHAR(190) NOT NULL,

  code_hash    CHAR(64) NULL,
  code_salt    CHAR(32) NULL,
  provider_ref VARCHAR(64) NULL,

  attempts     INT NOT NULL DEFAULT 0,
  expires_at   DATETIME NOT NULL,
  consumed_at  DATETIME NULL,

  -- For the rate limit, and for working out afterwards where a flood came from.
  ip           VARCHAR(45) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_dinein_otp_public (public_id),
  INDEX idx_dinein_otp_dest (office_id, destination, created_at),
  INDEX idx_dinein_otp_ip (ip, created_at),
  INDEX idx_dinein_otp_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A phone number is as much an identity as an address, so it needs the same
-- uniqueness. Nullable for the same reason email is.
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
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index(
  'dinein_diners', 'uq_dinein_diner_phone',
  'UNIQUE KEY `uq_dinein_diner_phone` (office_id, phone_e164)'
);

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
