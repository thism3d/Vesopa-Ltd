-- Card settings for a Paymentsense Connect account (2026-10-13).
--
-- Pontardawe RFC's live card account from Dojo is a Paymentsense Connect
-- account: its own host (<account>.connect.paymentsense.cloud) and key, not a
-- Dojo API key on api.dojo.tech. The office settings could only carry a Dojo
-- key, and the till forced whatever it was sent onto api.dojo.tech, where a
-- Connect key is always refused. These two columns let a venue's card
-- settings name the platform and its host; the till then uses its Connect
-- integration (lib/payments/connect_pac.dart).
--
--   epos_dojo_settings.platform   dojo | connect
--   epos_dojo_settings.base_url   the Connect host, NULL for Dojo

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

CALL vesopa_add_column('epos_dojo_settings', 'platform', "VARCHAR(8) NOT NULL DEFAULT 'dojo'");
CALL vesopa_add_column('epos_dojo_settings', 'base_url', 'VARCHAR(255) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
