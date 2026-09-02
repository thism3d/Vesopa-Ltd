-- The till gained discounts, covers and notes; the server's orders table never
-- did, so those fields were being dropped on sync.
ALTER TABLE epos_orders
  ADD COLUMN discount_minor INT NOT NULL DEFAULT 0 AFTER subtotal_minor,
  ADD COLUMN covers         INT NULL,
  ADD COLUMN notes          VARCHAR(500) NULL,
  ADD COLUMN customer_name  VARCHAR(255) NULL,
  ADD COLUMN session_id     CHAR(36) NULL;
