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
