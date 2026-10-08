-- admin.vesopa.com's own database (2026-10-05). Admins, their roles, the
-- audit log and the few actions it has to finish later. Nothing a venue owns
-- lives here: venues, licences and modules stay in the app that owns them, and
-- admin.vesopa.com changes them through that app. Safe to re-run.

-- Who may sign in, and as what. The owner (OWNER_EMAIL) needs no row: they are
-- Owner by address and cannot be removed or demoted.
CREATE TABLE IF NOT EXISTS adm_admins (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email       VARCHAR(190) NOT NULL,
  name        VARCHAR(120) NULL,
  -- owner | support | billing | content | readonly (src/roles.js)
  role        VARCHAR(16)  NOT NULL DEFAULT 'readonly',
  -- Which apps the role reaches: '*' for all, else a comma list (src/roles.js APPS).
  apps        VARCHAR(255) NOT NULL DEFAULT '*',
  status      VARCHAR(12)  NOT NULL DEFAULT 'active',
  added_by    VARCHAR(190) NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_adm_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A random token in a cookie, and its SHA-256 here. Signing out is deleting a
-- row; what a session may do is re-read from adm_admins on every request.
CREATE TABLE IF NOT EXISTS adm_sessions (
  id          CHAR(64)     NOT NULL,
  email       VARCHAR(190) NOT NULL,
  name        VARCHAR(120) NULL,
  csrf        CHAR(32)     NOT NULL,
  ip          VARCHAR(45)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME     NOT NULL,
  revoked_at  DATETIME     NULL,
  PRIMARY KEY (id),
  KEY idx_adm_sessions_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every change anybody makes here: who, what, to which venue, before and after.
CREATE TABLE IF NOT EXISTS adm_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor       VARCHAR(190) NOT NULL,
  action      VARCHAR(48)  NOT NULL,
  app         VARCHAR(16)  NULL,
  venue_id    INT UNSIGNED NULL,
  venue_name  VARCHAR(190) NULL,
  item        VARCHAR(48)  NULL,
  detail      TEXT         NULL,
  ok          TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_adm_audit_at (at),
  KEY idx_adm_audit_venue (venue_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Things to finish when a grace day ends, for apps that have no grace of their
-- own (Gift, Hosting). The back office keeps its own holds and needs none.
CREATE TABLE IF NOT EXISTS adm_scheduled (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  due_at      DATETIME     NOT NULL,
  app         VARCHAR(16)  NOT NULL,
  venue_id    INT UNSIGNED NULL,
  item        VARCHAR(48)  NOT NULL,
  action      VARCHAR(16)  NOT NULL,
  actor       VARCHAR(190) NULL,
  done_at     DATETIME     NULL,
  cancelled_at DATETIME    NULL,
  error       VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_adm_scheduled_due (done_at, cancelled_at, due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Small facts the app keeps for itself, such as the day the summary last went.
CREATE TABLE IF NOT EXISTS adm_state (
  k           VARCHAR(64)  NOT NULL,
  v           VARCHAR(255) NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The Windows installers Vesopa hands out itself, beside the Microsoft Store
-- (2026-10-05). "I think exe with a private link for time being will be good.
-- That allows us to control what versions people are on." (Nicki)
--
-- Every version is kept, so moving a venue back is installing an older one.
-- The file lives in RELEASES_DIR/<app>/<file>; this row is what it is.
-- app: till | kitchen | display | express | loyalty (src/releases.js).
CREATE TABLE IF NOT EXISTS adm_releases (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  app         VARCHAR(16)  NOT NULL,
  version     VARCHAR(32)  NOT NULL,
  file        VARCHAR(190) NOT NULL,
  size        BIGINT       NOT NULL,
  sha256      CHAR(64)     NOT NULL,
  -- Signed with Vesopa's code-signing certificate (Azure Trusted Signing).
  signed      TINYINT(1)   NOT NULL DEFAULT 0,
  notes       TEXT         NULL,
  added_by    VARCHAR(190) NULL,
  added_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Hidden from Downloads and from the version lists; the file stays.
  withdrawn_at DATETIME    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_adm_release (app, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2026-10-08: the same version live on the Microsoft Store as well, so a venue
-- set to it moves its Store copies too (they are sent to the Store for it). A
-- version that is on the Store only, with no installer, is a row with an empty
-- file. MariaDB's IF NOT EXISTS keeps this re-runnable.
ALTER TABLE adm_releases ADD COLUMN IF NOT EXISTS store_live TINYINT(1) NOT NULL DEFAULT 0;
