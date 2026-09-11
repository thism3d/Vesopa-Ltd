-- Till licences.
--
-- "If a customer has paid for two tills, they should only be able to have two
-- tills logged in simultaneously. This should be controlled by the number of
-- licences the customer has purchased."
--
-- Until now a till's credential was a ten-year token that nothing kept a
-- record of, so nothing could count them and nothing could take one back. A
-- seat is that record: one row per till signed in, named by the seat id the
-- till's token carries (see src/till_seats.js).
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

-- How many tills the venue has paid for. NULL is "no limit", and every venue
-- starts NULL: deploying this must not refuse a single till anywhere. The
-- platform admin sets the number per venue.
CALL vesopa_add_column('offices', 'till_licences', 'INT NULL');


-- One signed-in till.
--
-- `id` is the seat id, carried in the till's token as its `jti`. A till signed
-- in before seats existed has a token with no id; it is given a seat the first
-- time it calls in, keyed on a hash of the token itself (`token_hash`), so the
-- count is true without anybody signing in again.
--
-- `device_id` is the till's own permanent id (the one bo_devices is keyed by),
-- learnt when the till registers itself. It is what lets signing in again on
-- the same machine reuse that machine's seat instead of taking a second one.
--
-- Released rows are kept: "who signed the bar till out, and when" is exactly
-- the question somebody asks the day after.
CREATE TABLE IF NOT EXISTS bo_till_seats (
  id              CHAR(36) NOT NULL PRIMARY KEY,
  office          VARCHAR(190) CHARACTER SET utf8mb4
                  COLLATE utf8mb4_general_ci NOT NULL,
  device_id       VARCHAR(64)  NULL,
  device_name     VARCHAR(120) NULL,
  token_hash      CHAR(64)     NULL,
  signed_in_by    VARCHAR(190) NULL,
  signed_in_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at    DATETIME     NULL,
  released_at     DATETIME     NULL,
  released_by     VARCHAR(190) NULL,
  release_reason  VARCHAR(64)  NULL,
  UNIQUE KEY uq_till_seats_token (token_hash),
  KEY idx_till_seats_office (office, released_at),
  KEY idx_till_seats_device (office, device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS vesopa_add_column;
