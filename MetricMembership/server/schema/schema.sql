-- ---------------------------------------------------------------------------
-- Metric Membership (vesopa_metric_server): the whole schema.
--
-- Re-runnable, like every Vesopa schema: the deploy applies it twice and the
-- second run must change nothing.
--
--   plans            what a membership allows (how many cars, which sites)
--   members          one per Vesopa account that has signed in
--   vehicles         a member's cars, by registration
--   sites            Metric's customers' car parks
--   gates            one ANPR camera + barrier lane each, with its adapter
--   gate_plates      what this server has put on each camera's own allow-list
--   access_events    every plate read, and whether the barrier opened
--   activity_log     every press and change, by whom (fault finding)
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS plans (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(80)  NOT NULL,
  description   VARCHAR(255) NOT NULL DEFAULT '',
  max_vehicles  TINYINT UNSIGNED NOT NULL DEFAULT 3,
  -- NULL: every site. Otherwise a comma list of site ids.
  site_ids      VARCHAR(255) NULL,
  is_default    TINYINT(1) NOT NULL DEFAULT 0,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO plans (name, description, max_vehicles, is_default)
SELECT 'Standard', 'Entry and exit at every site for your registered cars.', 3, 1
 WHERE NOT EXISTS (SELECT 1 FROM plans);

CREATE TABLE IF NOT EXISTS members (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  vesopa_sub    VARCHAR(191) NOT NULL,
  email         VARCHAR(191) NOT NULL DEFAULT '',
  name          VARCHAR(120) NOT NULL DEFAULT '',
  phone         VARCHAR(40)  NOT NULL DEFAULT '',
  company       VARCHAR(120) NOT NULL DEFAULT '',
  member_no     VARCHAR(20)  NULL,
  -- pending: signed up, waiting for Metric; active: barriers open;
  -- suspended: Metric has stopped it; closed: the member deleted it.
  status        ENUM('pending','active','suspended','closed') NOT NULL DEFAULT 'pending',
  plan_id       INT UNSIGNED NULL,
  valid_from    DATE NULL,
  valid_to      DATE NULL,
  notes         VARCHAR(500) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_members_sub (vesopa_sub),
  UNIQUE KEY uq_members_no (member_no),
  KEY ix_members_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vehicles (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  member_id     INT UNSIGNED NOT NULL,
  -- AB12CDE: upper case, letters and digits only. What cameras compare.
  plate         VARCHAR(16)  NOT NULL,
  -- AB12 CDE: as the member typed it, for showing back.
  plate_display VARCHAR(20)  NOT NULL,
  -- AB12C0E: the plate with the letters cameras confuse folded together
  -- (src/plates.js fuzzy). A lane that allows it matches on this too.
  plate_fuzzy   VARCHAR(16)  NOT NULL DEFAULT '',
  make          VARCHAR(60)  NOT NULL DEFAULT '',
  colour        VARCHAR(40)  NOT NULL DEFAULT '',
  nickname      VARCHAR(60)  NOT NULL DEFAULT '',
  -- A plate is on one live membership at a time. Removed rows keep their
  -- history for the access log; `live_plate` is NULL once removed so the
  -- unique key only covers cars still registered.
  removed_at    DATETIME NULL,
  live_plate    VARCHAR(16) GENERATED ALWAYS AS (IF(removed_at IS NULL, plate, NULL)) STORED,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicles_live (live_plate),
  KEY ix_vehicles_member (member_id),
  KEY ix_vehicles_plate (plate),
  KEY ix_vehicles_fuzzy (plate_fuzzy)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sites (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  address       VARCHAR(255) NOT NULL DEFAULT '',
  -- Shown to members so they know where their membership works.
  public        TINYINT(1) NOT NULL DEFAULT 1,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gates (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  site_id       INT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  direction     ENUM('entry','exit','both') NOT NULL DEFAULT 'both',
  -- Which camera/barrier make this lane is, and so how to talk to it:
  -- generic | hikvision | dahua | metric_aigate. See src/adapters/.
  adapter       VARCHAR(30)  NOT NULL DEFAULT 'generic',
  -- decision: the camera (or Metric's AI-Gate back office) asks this server
  --           about every plate and opens on the answer.
  -- allowlist: this server keeps the camera's own list of plates up to date
  --           and the camera opens by itself -- it keeps working if the
  --           internet does not.
  -- both:     the list on the camera, and every read reported here too.
  mode          ENUM('decision','allowlist','both') NOT NULL DEFAULT 'decision',
  -- The camera's address as this server reaches it (allow-list push, remote
  -- open), and its login. NEVER sent to a browser; the console shows only
  -- whether a password is set.
  device_url    VARCHAR(255) NOT NULL DEFAULT '',
  device_user   VARCHAR(80)  NOT NULL DEFAULT '',
  device_pass   VARCHAR(255) NOT NULL DEFAULT '',
  device_channel TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- Tolerate the letters cameras confuse (O/0, I/1, B/8, S/5, Z/2).
  fuzzy_match   TINYINT(1) NOT NULL DEFAULT 1,
  -- The lane's own key: the camera sends it on every event, and it is the
  -- only thing that identifies the lane. Stored as a SHA-256; shown once.
  key_hash      CHAR(64)     NOT NULL,
  key_hint      VARCHAR(12)  NOT NULL DEFAULT '',
  active        TINYINT(1) NOT NULL DEFAULT 1,
  last_seen_at  DATETIME NULL,
  last_sync_at  DATETIME NULL,
  last_sync_error VARCHAR(500) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gates_key (key_hash),
  KEY ix_gates_site (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS gate_plates (
  gate_id       INT UNSIGNED NOT NULL,
  plate         VARCHAR(16)  NOT NULL,
  -- The camera's own record number where it has one (Dahua's recno), so a
  -- removal can name it.
  device_ref    VARCHAR(40)  NOT NULL DEFAULT '',
  pushed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (gate_id, plate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS access_events (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  gate_id       INT UNSIGNED NOT NULL,
  site_id       INT UNSIGNED NOT NULL,
  plate         VARCHAR(16)  NOT NULL,
  direction     ENUM('entry','exit','unknown') NOT NULL DEFAULT 'unknown',
  decision      ENUM('open','deny','seen') NOT NULL,
  reason        VARCHAR(60)  NOT NULL DEFAULT '',
  member_id     INT UNSIGNED NULL,
  vehicle_id    INT UNSIGNED NULL,
  confidence    DECIMAL(5,2) NULL,
  source        VARCHAR(30)  NOT NULL DEFAULT '',
  at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_events_member (member_id, at),
  KEY ix_events_gate (gate_id, at),
  KEY ix_events_plate (plate, at),
  KEY ix_events_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activity_log (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_type    ENUM('member','admin','gate','system') NOT NULL,
  actor_id      VARCHAR(64)  NOT NULL DEFAULT '',
  actor_label   VARCHAR(191) NOT NULL DEFAULT '',
  action        VARCHAR(80)  NOT NULL,
  detail        TEXT NULL,
  ip            VARCHAR(64)  NOT NULL DEFAULT '',
  app           VARCHAR(40)  NOT NULL DEFAULT '',
  KEY ix_activity_at (at),
  KEY ix_activity_actor (actor_type, actor_id, at),
  KEY ix_activity_action (action, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
