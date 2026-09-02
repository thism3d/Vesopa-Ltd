-- Customers, keyed to the office. A customer can carry a standing discount,
-- applied automatically when they are attached to a sale.
CREATE TABLE IF NOT EXISTS epos_customers (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  email_key     VARCHAR(255) NOT NULL,           -- tenant key (office contact email)
  name          VARCHAR(255) NOT NULL,
  phone         VARCHAR(64)  NULL,
  email         VARCHAR(255) NULL,
  card_number   VARCHAR(64)  NULL,

  -- A standing discount. percent = whole percent; amount = pence off the bill.
  discount_type ENUM('none','percent','amount') NOT NULL DEFAULT 'none',
  discount_value INT NOT NULL DEFAULT 0,

  points_balance INT NOT NULL DEFAULT 0,
  membership_expiry DATE NULL,
  notes         VARCHAR(500) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_cust_office (email_key),
  INDEX idx_cust_phone (email_key, phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
