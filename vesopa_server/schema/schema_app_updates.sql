-- Which version of each Windows app a venue runs, and which version it has
-- (admin.vesopa.com Versions, 2026-10-05).
--
-- "If anyone has an issue I can downgrade them or upgrade." (Nicki, 2026-10-05)
--
-- The installers themselves live on admin.vesopa.com (adm_releases). Here is
-- only what a device needs to be told: the version its venue is set to, where
-- to fetch it and the SHA-256 it must have. A row for office '*' is the
-- default for every venue without a row of its own.
--
-- version NULL means "No auto updates": the venue stays on whatever it has.
--
-- No row anywhere, and the switch in bo_app_update_settings off, is every
-- venue today, so deploying this changes nothing. Safe to re-run.

CREATE TABLE IF NOT EXISTS bo_app_pins (
  office      VARCHAR(190) NOT NULL,
  -- till | kitchen | display | express | loyalty
  app         VARCHAR(16)  NOT NULL,
  version     VARCHAR(32)  NULL,
  url         VARCHAR(500) NULL,
  sha256      CHAR(64)     NULL,
  size        BIGINT       NULL,
  set_by      VARCHAR(190) NULL,
  set_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (office, app)
);

-- What each device last said it runs. Written by /api/licence/state, which
-- every device app asks every five minutes. `install` is store (Microsoft
-- Store copy, which the Store updates) or direct (our own installer).
CREATE TABLE IF NOT EXISTS bo_app_installs (
  office        VARCHAR(190) NOT NULL,
  app           VARCHAR(16)  NOT NULL,
  device_id     VARCHAR(64)  NOT NULL,
  device_name   VARCHAR(120) NULL,
  version       VARCHAR(32)  NULL,
  install       VARCHAR(8)   NULL,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (office, app, device_id),
  KEY idx_app_installs_app (app, last_seen_at)
);

-- One switch for the whole platform: whether devices are told to update at
-- all. Off until Vesopa turns it on (Nicki: "in around 9 months").
CREATE TABLE IF NOT EXISTS bo_app_update_settings (
  k           VARCHAR(32)  NOT NULL,
  v           VARCHAR(64)  NULL,
  PRIMARY KEY (k)
);
INSERT IGNORE INTO bo_app_update_settings (k, v) VALUES ('enabled', '0');

-- 2026-10-08: whether the pinned version is live on the Microsoft Store, so a
-- Store copy can be sent to the Store for it. Store copies were left out
-- before; with this off (the default) they still are. MariaDB (the live box)
-- has ADD COLUMN IF NOT EXISTS, which keeps this file re-runnable.
ALTER TABLE bo_app_pins ADD COLUMN IF NOT EXISTS store_ok TINYINT(1) NOT NULL DEFAULT 0;
