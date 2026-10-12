-- Where a member's passkey lives and what it was added on (2026-10-12).
--
-- WHY. The owner: "passkey device info should show". A list where every row
-- says "Passkey" is no help to somebody deciding which one to remove, so the
-- account page now says "iCloud Keychain · added on iPhone".
--
--   aaguid     the authenticator's id, from the registration. Names the
--              password manager (src/passkey_providers.js). All zeros is
--              ordinary: Apple sends that for iCloud Keychain.
--   device     what it was added on, in the words of the devices list
--              ("iPhone", "Safari on a Mac"; loyalty_account.js deviceLabel).
--   backed_up  whether the authenticator said it syncs (WebAuthn's BS flag).
--
-- Existing passkeys keep NULLs and show what is known. The server reads these
-- with SELECT * and writes them only when they exist, so this can be applied
-- before or after the code. Guarded, and safe to re-run.

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

CALL vesopa_add_column('epos_loyalty_passkeys', 'aaguid', 'CHAR(36) NULL');
CALL vesopa_add_column('epos_loyalty_passkeys', 'device', 'VARCHAR(80) NULL');
CALL vesopa_add_column('epos_loyalty_passkeys', 'backed_up', 'TINYINT(1) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
