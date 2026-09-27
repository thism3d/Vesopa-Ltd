-- ===========================================================================
-- The activity log: what every till, screen, kiosk, app and back-office user
-- pressed or changed, so a fault can be traced without ringing the venue.
-- ===========================================================================
--
-- Written by src/activity_log.js (a copy of shared/activity-log). Three sources:
--
--   * every request that changes something, or fails, on this server
--     (the middleware in server.js), with the body after redaction;
--   * events the Flutter apps send to POST /activity/v1/events: taps, screens
--     opened, sign-ins, errors (EPOS, kitchen screen, Express kiosk, loyalty);
--   * page views and actions from the back office itself.
--
-- Nothing secret is stored: passwords, PINs, tokens, card numbers, CVVs, bank
-- details and one-time codes are replaced with "[redacted]" before the insert.
--
-- RETENTION. Ninety days, deleted in batches by the server itself (the same
-- approach as epos_wallet_events). The .jsonl files beside the app keep 30.
--
-- Append-only from the application's side: no route edits or deletes a row.
--
-- RE-RUNNABLE. Every deploy replays every file here.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS epos_activity_log (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- vesopa_server, or the Node service that wrote it.
  service      VARCHAR(32)  NOT NULL,
  -- The venue (office contact email), from the signed token. Null for a
  -- request nobody was signed in for.
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  -- epos | kitchen | display | express | loyalty | backoffice | server | ...
  app          VARCHAR(32)  NULL,
  app_version  VARCHAR(32)  NULL,
  device_id    VARCHAR(64)  NULL,
  device_name  VARCHAR(120) NULL,
  -- Who: a member of staff's name, a back-office email, a customer.
  actor        VARCHAR(190) NULL,
  -- staff | user | admin | customer | device | system
  actor_type   VARCHAR(16)  NULL,
  customer_id  VARCHAR(64)  NULL,
  -- tap | screen | change | request | error | signin | signout | start | ...
  action       VARCHAR(32)  NOT NULL,
  -- What was pressed ("Cash"), the screen opened, or the route called.
  target       VARCHAR(255) NULL,
  method       VARCHAR(8)   NULL,
  status       SMALLINT     NULL,
  ms           INT          NULL,
  -- Redacted JSON, at most 2000 characters.
  detail       TEXT         NULL,
  ip           VARCHAR(64)  NULL,
  session_id   VARCHAR(64)  NULL,

  KEY idx_activity_office_at (office, at),
  KEY idx_activity_at (at),
  KEY idx_activity_office_app_at (office, app, at),
  KEY idx_activity_office_customer (office, customer_id, at),
  KEY idx_activity_office_device (office, device_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
