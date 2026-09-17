-- ---------------------------------------------------------------------------
-- Deletion requests a loyalty member made inside the app.
--
-- The request itself lives in Vesopa Auth (vesopa_auth schema_021), which runs
-- it. This is only the app's memory of it, so the Account page can say
-- "your data will be deleted on 30 October" instead of offering the button
-- again. src/privacy_provider.js keeps it current when the request is
-- cancelled, rejected or carried out.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS epos_privacy_requests (
  request_id   CHAR(26)     CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id  CHAR(36)     NOT NULL,
  status       VARCHAR(24)  NOT NULL,
  mode         VARCHAR(16)  NOT NULL,
  delay_days   SMALLINT     NULL,
  due_at       DATETIME     NULL,
  manage_url   VARCHAR(500) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_privacy_customer (office, customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
