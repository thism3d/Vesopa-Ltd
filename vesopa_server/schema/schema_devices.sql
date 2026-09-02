-- Which terminal took the money, and which devices are on the network.
--
-- Two features that look separate and are not. Both answer the same question a
-- manager standing in a busy venue actually asks: *who was at that machine?*
--
--   * `epos_orders.terminal` puts a terminal's name on every sale, so takings
--     can be read one till at a time. Until now the sales ledger recorded the
--     clerk but not the machine, so a venue with three tills had one column of
--     figures and no way to split it -- and a till that is light at the end of
--     the day could not be told from a clerk who is.
--   * `bo_devices` and `bo_device_log` record which machines are connected and
--     what happened on them. The log is append-only on purpose; see below.
--
-- Target is MySQL 5.7 / MariaDB. Every statement is guarded and safe to re-run,
-- because deploy.ps1 -Schema runs this file on every deploy.
--
-- Collation note, as in schema_staff_idle.sql: `office` is an email address
-- compared against utf8mb4_general_ci columns elsewhere, so it is stated
-- explicitly rather than inherited from the server default. On the live box a
-- bare utf8mb4 column comes out uca1400_ai_ci, which will not compare against
-- backoffice_users.email -- an "Illegal mix of collations" that never
-- reproduces on a dev machine.


-- ---------------------------------------------------------------------------
-- Idempotent column adder. Same procedure the other migrations use.
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- Which terminal took the sale.
-- ---------------------------------------------------------------------------
-- Nullable, and that is not laziness. Every sale already in this table was
-- taken before the till knew to send this, and there is no way to work out
-- after the fact which machine rang it up -- guessing would be inventing an
-- audit trail, which is worse than not having one. So historical rows stay
-- NULL and the reports show them as "Unknown", which is the truth.
--
-- The name matches epos_open_bills.terminal and epos_clerk_sessions.terminal
-- character for character: it is the till's own `terminal_name` preference,
-- the same string that prints on a receipt. A manager reading a receipt and a
-- report is reading one name, not two that need reconciling.
--
-- VARCHAR(120) to match those two tables. The till clamps its own name to 40.
CALL vesopa_add_column(
  'epos_orders', 'terminal',
  'VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL');

-- The reports filter is `email = ? AND closed_at BETWEEN ? AND ? AND
-- terminal = ?`, which is exactly this index. Without it, filtering a busy
-- venue's year by terminal is a full scan of the ledger.
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
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD INDEX `', idx, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_index(
  'epos_orders', 'idx_orders_terminal', '`email`, `terminal`, `closed_at`');

-- The void log gets the same treatment, and for a sharper reason than the
-- ledger does. "Which till are the voids coming from" is the single most
-- useful question in this database, and it could not be asked at all.
CALL vesopa_add_column(
  'epos_void_log', 'terminal',
  'VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL');


-- ---------------------------------------------------------------------------
-- Devices that have connected, and whether they are connected now.
-- ---------------------------------------------------------------------------
-- One row per machine per venue, updated in place. This is the *current state*
-- table -- "is the kitchen screen up?" -- and it is allowed to be overwritten
-- because the history lives in bo_device_log next door.
--
-- The primary key is (office, device_id) rather than an auto id, so a till that
-- reconnects forty times in a service is one row that changes forty times, not
-- forty rows. `device_id` is generated once by the device and kept in its own
-- local preferences, so a rename does not create a second device.
CREATE TABLE IF NOT EXISTS bo_devices (
  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  -- The device's own permanent id (a UUID it generates on first run). Not the
  -- name: a name is changed by whoever is standing at the machine, and an audit
  -- trail keyed on something a person can edit is not an audit trail.
  device_id     VARCHAR(64) NOT NULL,

  -- 'till' | 'kitchen' | 'display'. Free text rather than an ENUM so a device
  -- kind invented in a later release connects to an older server and is
  -- recorded rather than refused.
  kind          VARCHAR(24) NOT NULL DEFAULT 'unknown',

  -- What it calls itself right now. For a till this is the same string that
  -- goes in epos_orders.terminal, which is what lets a manager match a device
  -- on this screen to a column in a report.
  name          VARCHAR(120) NULL,

  -- Who signed this device in. For the customer display this is a back office
  -- account, because that is the credential it is commissioned with.
  signed_in_as  VARCHAR(190) NULL,

  app_version   VARCHAR(32)  NULL,
  ip_address    VARCHAR(64)  NULL,

  -- 1 while a socket is open. Set to 0 on a clean disconnect and by the
  -- heartbeat sweep on a dirty one, so a till that loses power stops claiming
  -- to be online within one heartbeat rather than for ever.
  online        TINYINT(1) NOT NULL DEFAULT 0,

  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (office, device_id),
  KEY idx_devices_office_online (office, online),
  KEY idx_devices_seen (office, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- What happened, kept.
-- ---------------------------------------------------------------------------
-- Append-only. Nothing in the application deletes from this table and no route
-- exposes a delete, which is the entire point of it: a log a manager can edit
-- is worth nothing in the argument it exists to settle. If it ever needs
-- trimming that is a deliberate DBA job against a retention policy somebody has
-- written down, not something the back office can do on a Tuesday.
--
-- Note there is no foreign key to bo_devices. A log entry must survive its
-- device being forgotten -- ON DELETE CASCADE here would mean removing a
-- device quietly erased everything it ever did, which is precisely the hole
-- somebody would go looking for.
CREATE TABLE IF NOT EXISTS bo_device_log (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,

  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,
  device_id     VARCHAR(64)  NOT NULL,

  -- Denormalised deliberately. The name at the time of the event, not the name
  -- now: a device renamed after the fact must not rewrite what the log says it
  -- was called when it did the thing.
  device_name   VARCHAR(120) NULL,
  kind          VARCHAR(24)  NULL,

  -- 'connected' | 'disconnected' | 'signin' | 'signin.failed' | 'signout'
  -- | 'dropped'. Free text for the same reason `kind` is.
  event         VARCHAR(32)  NOT NULL,

  -- Who, where a person is involved. A failed sign-in records the email that
  -- was tried, which is the whole value of logging one.
  actor         VARCHAR(190) NULL,

  detail        VARCHAR(255) NULL,
  ip_address    VARCHAR(64)  NULL,

  at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_device_log_office_at (office, at),
  KEY idx_device_log_device (office, device_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
