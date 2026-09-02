-- Void audit trail. A voided sale must be explainable — who, when, why, and
-- how much — or it becomes a way to make takings disappear unaccountably.
CREATE TABLE IF NOT EXISTS epos_void_log (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,          -- tenant key (office)
  order_id    CHAR(36)     NULL,
  clerk_pin   VARCHAR(255) NULL,
  reason      VARCHAR(255) NOT NULL,
  amount_minor INT         NOT NULL DEFAULT 0,
  voided_at   DATETIME     NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_void_email_time (email, voided_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reasons the till offers. Seeded with sensible defaults; the office edits them.
INSERT IGNORE INTO bo_error_reasons (id, reason, applies_to) VALUES
  (10, 'Customer changed mind', 'void'),
  (11, 'Wrong item rung up', 'void'),
  (12, 'Duplicate order', 'void'),
  (13, 'Kitchen error', 'void'),
  (14, 'Training / test', 'void');
