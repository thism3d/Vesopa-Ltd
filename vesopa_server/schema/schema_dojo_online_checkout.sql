-- ---------------------------------------------------------------------------
-- Online checkout: its own Dojo key, test orders kept off the till, and the
-- details Dojo's go-live review looks for on the venue's menu (2026-10-16)
-- ---------------------------------------------------------------------------
--
-- epos_dojo_settings.online_mode    demo | counter | live, NULL = as before
--   (src/online_checkout.js); online_key_enc / _hint the venue's own live key.
-- dinein_orders.is_demo             paid with the sandbox: never shown to the
--   tills or kitchen screens, never in the takings.
-- dinein_venue legal_name, contact_email, terms_url, privacy_url, refund_url
--   shown at the foot of the menu for Dojo's website checklist.

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

CALL vesopa_add_column('epos_dojo_settings', 'online_mode', 'VARCHAR(8) NULL');
CALL vesopa_add_column('epos_dojo_settings', 'online_key_enc', 'TEXT NULL');
CALL vesopa_add_column('epos_dojo_settings', 'online_key_hint', 'VARCHAR(12) NULL');

CALL vesopa_add_column('dinein_orders', 'is_demo', 'TINYINT(1) NOT NULL DEFAULT 0');

CALL vesopa_add_column('dinein_venue', 'legal_name', 'VARCHAR(190) NULL');
CALL vesopa_add_column('dinein_venue', 'contact_email', 'VARCHAR(190) NULL');
CALL vesopa_add_column('dinein_venue', 'terms_url', 'VARCHAR(300) NULL');
CALL vesopa_add_column('dinein_venue', 'privacy_url', 'VARCHAR(300) NULL');
CALL vesopa_add_column('dinein_venue', 'refund_url', 'VARCHAR(300) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
