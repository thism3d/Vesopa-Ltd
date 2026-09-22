-- ---------------------------------------------------------------------------
-- Webhooks — telling an application that something happened to one of its
-- people, without it having to ask.
--
-- THREE TABLES, NOT ONE, and the split is the whole design.
--
--   webhook_endpoints   where an application wants to be told, and about what
--   webhook_events      what happened, ONCE, whoever is listening
--   webhook_deliveries  one attempt to tell one endpoint about one event
--
-- Keeping the event apart from the delivery is what makes the hard parts
-- possible. An event fans out to several endpoints without being recorded
-- several times. A failed delivery is retried without re-deriving what
-- happened. A developer can replay a delivery from the portal and get exactly
-- the bytes we sent the first time, rather than a fresh payload built from
-- data that has since changed — which is the difference between debugging and
-- guessing.
--
-- Same rules as everywhere: idempotent, and every string column pins its
-- collation.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- webhook_endpoints
--
-- THE SIGNING SECRET IS ENCRYPTED, NOT HASHED, and that is the one place this
-- differs from every other credential in the schema. A client secret is only
-- ever *checked*, so a hash is enough. A webhook secret must be used to SIGN
-- each request, so the server has to read it back. It is encrypted with the
-- application's ENCRYPTION_KEY, which lives in the environment — so a dumped
-- database cannot forge a delivery, and the developer keeps a copy of their own.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  application_id  INT UNSIGNED NOT NULL,

  url             VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  description     VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  secret_cipher   VARBINARY(512) NOT NULL,
  -- The last six characters, so a developer can tell two endpoints apart in a
  -- list without the list containing either secret.
  secret_hint     CHAR(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  is_enabled      TINYINT(1) NOT NULL DEFAULT 1,

  /*
   * Switched off automatically after a long run of failures.
   *
   * An endpoint whose domain has expired would otherwise be retried for ever,
   * and every one of those attempts is a connection this server opens to
   * somebody else's machine on a schedule. The developer is told, and turning
   * it back on is one click.
   */
  disabled_at     DATETIME NULL,
  disabled_reason VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  last_success_at DATETIME NULL,
  last_failure_at DATETIME NULL,

  created_by      INT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_public (public_id),
  KEY idx_webhook_app (application_id, deleted_at),
  CONSTRAINT fk_webhook_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- webhook_endpoint_events — which events this endpoint asked for.
--
-- Rows rather than a JSON list, so "who is listening for account.deleted" is a
-- query and not a scan. An endpoint with no rows receives nothing, which is a
-- safer default than "everything".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_endpoint_events (
  endpoint_id INT UNSIGNED NOT NULL,
  event_type  VARCHAR(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (endpoint_id, event_type),
  CONSTRAINT fk_wee_endpoint FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- webhook_events — what happened, recorded once.
--
-- `payload` is frozen at the moment of the event. It is NOT rebuilt at delivery
-- time, and that matters: an account deleted at 10:00 and delivered at 10:05
-- must describe what was true at 10:00, and the row it describes may no longer
-- exist by the time anybody is listening.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id      CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  application_id INT UNSIGNED NOT NULL,
  event_type     VARCHAR(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- Who it was about, so a developer can find every event for one person.
  subject        VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  payload        JSON NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_wevent_public (public_id),
  KEY idx_wevent_app (application_id, created_at),
  KEY idx_wevent_type (event_type, created_at),
  CONSTRAINT fk_wevent_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- webhook_deliveries — one attempt to tell one endpoint.
--
-- `next_attempt_at` IS THE QUEUE. There is no separate job table and no broker:
-- the worker asks for pending rows whose time has come, which means a restart
-- loses nothing and a delivery cannot be forgotten because a process died
-- holding it in memory.
--
-- `response_body` is truncated hard. It is somebody else's server talking, it
-- is shown in the portal, and an endpoint that returns a megabyte of HTML on
-- error should cost us a column, not a table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id       CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  endpoint_id     INT UNSIGNED NOT NULL,
  event_id        BIGINT UNSIGNED NOT NULL,

  status          ENUM('pending','delivered','failed','abandoned') NOT NULL DEFAULT 'pending',
  attempt         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts    SMALLINT UNSIGNED NOT NULL DEFAULT 8,

  next_attempt_at DATETIME NULL,
  -- Held by one worker while it is being sent, so two drains cannot send the
  -- same delivery twice. Cleared on completion; a stale lock is reclaimed.
  locked_at       DATETIME NULL,

  response_code   SMALLINT UNSIGNED NULL,
  response_body   VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  error           VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  duration_ms     INT UNSIGNED NULL,

  -- Set when a human pressed "send it again" in the portal, so a replay is
  -- distinguishable from the original in the delivery list.
  replay_of       BIGINT UNSIGNED NULL,

  delivered_at    DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_wdelivery_public (public_id),
  -- The worker's query: pending, due, unlocked. Ordered so it is an index scan.
  KEY idx_wdelivery_due (status, next_attempt_at),
  KEY idx_wdelivery_endpoint (endpoint_id, created_at),
  KEY idx_wdelivery_event (event_id),
  CONSTRAINT fk_wdelivery_endpoint FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  CONSTRAINT fk_wdelivery_event FOREIGN KEY (event_id) REFERENCES webhook_events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
