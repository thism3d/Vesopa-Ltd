-- Apple Wallet push updates, on top of the Apple Wallet tables.
--
-- WHY THIS IS A SEPARATE FILE
--
-- schema_wallet_apple.sql added what a `.pkpass` carries so it *could* be
-- updated later — the serial, the authentication token, and the table of
-- devices that have registered. What it did not add is the two things the
-- update service itself needs: a record of when a card's contents last
-- changed, and somewhere to put the reason a push failed.
--
-- `schema_wallet_apple.sql` sorts before `schema_wallet_apple_push.sql` (a full
-- stop sorts before an underscore), so deploy.ps1 applies them in the order
-- they depend on. That ordering is load-bearing: the ALTERs below are no-ops
-- against a database where the previous file has not run, and they fail
-- silently rather than loudly, so a file that sorted the other way would leave
-- a half-built schema and nothing to say so.
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
-- When this card last changed.
-- ---------------------------------------------------------------------------
-- Apple's update protocol is a conversation about time. A device asks "which of
-- my passes have changed since <tag>", and whatever it is told, it hands back
-- as the tag next time. So there has to be a per-pass moment to compare, and it
-- has to mean *the card's contents changed* — not "a row was touched".
--
-- `updated_at` on this table cannot be that moment. It moves when the Google
-- half syncs an object, when a save_url is rewritten, when a state changes —
-- none of which alter what the customer sees on an Apple card. Reusing it would
-- wake every registered phone on the venue's next Google sync, which is a
-- battery cost paid by customers for nothing.
--
-- NULL means "changed exactly when it was issued", which is the correct reading
-- for every pass that existed before this column did: they have never been
-- updated, so the issue time is the last time their contents moved.
CALL vesopa_add_column(
  'epos_wallet_passes', 'apple_updated_at', 'DATETIME NULL');

-- The "which of mine have changed" query walks a venue's passes by the tag
-- above. Without this it is a scan of every pass the venue has ever issued, run
-- every time any registered phone checks in.
CALL vesopa_add_index(
  'epos_wallet_passes', 'idx_wallet_apple_updated', '`office`, `apple_updated_at`');


-- ---------------------------------------------------------------------------
-- Why a push did not arrive.
-- ---------------------------------------------------------------------------
-- The whole failure mode of this feature is silence. There is no app on the
-- customer's phone to log anything, Wallet reports nothing to us, and a push
-- that APNs rejects looks exactly like a push that worked: the card simply does
-- not change, days later, in someone's pocket, where nobody is looking.
--
-- So the rejection is written down at the moment it happens. `last_push_at` is
-- the last time we tried at all, which answers "is this device being told
-- anything?", and `last_error` is APNs' own reason string — `BadDeviceToken`,
-- `TopicDisallowed`, `ExpiredProviderToken` — which answers "and why not".
--
-- Both are diagnostics, not state: nothing reads them to decide whether to
-- send. A device that failed yesterday is still tried today, because the usual
-- cause is transient and the alternative is a card that stays wrong forever
-- because of one bad afternoon.
CALL vesopa_add_column(
  'epos_wallet_devices', 'last_push_at', 'DATETIME NULL');

CALL vesopa_add_column(
  'epos_wallet_devices', 'last_error',
  "VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL");


DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
