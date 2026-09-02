-- Multi-tenancy and billing.
--
-- The existing tables use an `email` column as an informal tenant key. That is
-- preserved (nothing is rewritten), but it now resolves to a real office via
-- backoffice_users.office_id, so pausing and billing have something to hang off.

CREATE TABLE IF NOT EXISTS offices (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,

  -- active  : trading normally
  -- paused  : suspended by the admin (non-payment, etc). Blocks back-office
  --           sign-in AND till API access.
  -- archived: kept for records, no access.
  status        ENUM('active','paused','archived') NOT NULL DEFAULT 'active',

  plan          VARCHAR(64) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paused_at     DATETIME NULL,
  pause_reason  VARCHAR(255) NULL,

  UNIQUE KEY uq_offices_email (contact_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The recurring charge for an office. Tracked, not auto-collected: the admin
-- marks payments and the system flags what is overdue.
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  office_id      INT NOT NULL,

  -- Pence, so no floating-point drift in money.
  amount_minor   INT NOT NULL DEFAULT 0,
  currency       CHAR(3) NOT NULL DEFAULT 'GBP',
  interval_unit  ENUM('month','year') NOT NULL DEFAULT 'month',

  next_due_on    DATE NOT NULL,
  status         ENUM('active','cancelled') NOT NULL DEFAULT 'active',
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_sub_office FOREIGN KEY (office_id)
    REFERENCES offices(id) ON DELETE CASCADE,
  INDEX idx_sub_due (status, next_due_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every charge raised, and whether it was paid. Keeping the history separate
-- from the subscription means "next due" can move forward without destroying
-- the record of what was billed.
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  subscription_id INT NOT NULL,
  office_id       INT NOT NULL,
  amount_minor    INT NOT NULL,
  due_on          DATE NOT NULL,
  paid_at         DATETIME NULL,
  status          ENUM('due','paid','overdue') NOT NULL DEFAULT 'due',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_inv_sub FOREIGN KEY (subscription_id)
    REFERENCES subscriptions(id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_office FOREIGN KEY (office_id)
    REFERENCES offices(id) ON DELETE CASCADE,
  INDEX idx_inv_status (status, due_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Link existing users to an office, and mark who is the platform admin.
-- Guarded so re-running the migration is safe.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE()
             AND table_name = 'backoffice_users' AND column_name = 'office_id');
SET @s := IF(@c = 0,
  'ALTER TABLE backoffice_users ADD COLUMN office_id INT NULL',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE()
             AND table_name = 'backoffice_users' AND column_name = 'role');
SET @s := IF(@c = 0,
  "ALTER TABLE backoffice_users ADD COLUMN role ENUM('admin','office') NOT NULL DEFAULT 'office'",
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Give every existing user an office, derived from the email they already key
-- their data by, so nothing is orphaned by the migration.
INSERT IGNORE INTO offices (name, contact_email, status)
SELECT COALESCE(NULLIF(company, ''), name), email, 'active'
FROM backoffice_users
WHERE email IS NOT NULL AND email <> '';

UPDATE backoffice_users u
JOIN offices o ON o.contact_email = u.email
SET u.office_id = o.id
WHERE u.office_id IS NULL;
