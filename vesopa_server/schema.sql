-- Sale-side tables. The existing back office already owns products, groups,
-- departments and clerks; none of that is touched here.

-- `id` is the UUID minted by the till, not an auto-increment. That makes the
-- push idempotent: a terminal retrying after a dropped connection re-sends the
-- same id and INSERT IGNORE turns the duplicate into a no-op instead of a
-- second sale.
CREATE TABLE IF NOT EXISTS epos_orders (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  email           VARCHAR(255) NOT NULL,
  table_number    INT          NULL,
  clerk_pin       VARCHAR(255) NULL,
  subtotal_minor  INT          NOT NULL DEFAULT 0,
  tax_minor       INT          NOT NULL DEFAULT 0,
  total_minor     INT          NOT NULL DEFAULT 0,
  closed_at       DATETIME     NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_orders_email_closed (email, closed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS epos_order_lines (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  order_id         CHAR(36)     NOT NULL,
  plu_id           INT          NOT NULL,
  name             VARCHAR(255) NOT NULL,
  quantity         DOUBLE       NOT NULL DEFAULT 1,
  -- Price as charged, not as currently configured: a later back-office edit
  -- must never restate historical takings.
  unit_price_minor INT          NOT NULL,
  tax_percentage   DOUBLE       NOT NULL DEFAULT 0,
  CONSTRAINT fk_lines_order FOREIGN KEY (order_id)
    REFERENCES epos_orders(id) ON DELETE CASCADE,
  INDEX idx_lines_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS epos_payments (
  id           CHAR(36)    NOT NULL PRIMARY KEY,
  order_id     CHAR(36)    NOT NULL,
  method       VARCHAR(32) NOT NULL,
  amount_minor INT         NOT NULL,
  taken_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id)
    REFERENCES epos_orders(id) ON DELETE CASCADE,
  INDEX idx_payments_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
