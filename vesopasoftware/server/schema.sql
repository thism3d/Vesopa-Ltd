-- vesopa_portal — customer/admin portal for vesopasoftware.com
--
-- MAMP ships MySQL 5.7, not MariaDB, so the utf8mb4_unicode_ci collation named
-- here is stable. Do not copy this file to a MariaDB 11.4 box without checking
-- the server's default collation first.
--
-- Money is DECIMAL(12,2) everywhere. Never FLOAT: an invoice that totals
-- 1234.56 must still total 1234.56 after it has been summed into an earnings
-- figure, and binary floats do not promise that.

-- A customer is an organisation, not a person: the account survives the person
-- who opened it leaving. One is created for every customer at registration,
-- even a sole trader, so there is never a second code path for "has a team".
CREATE TABLE IF NOT EXISTS organisations (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(150) NOT NULL,
  owner_id      INT UNSIGNED NULL,
  vat_number    VARCHAR(40)  NULL,
  reg_number    VARCHAR(40)  NULL,
  billing_email VARCHAR(190) NULL,
  billing_contact VARCHAR(120) NULL,
  address       VARCHAR(400) NULL,
  country       VARCHAR(80)  NULL,
  notes         TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_org_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- org_role is the customer-side permission set; `role` stays the Vesopa-side
-- one. A Vesopa admin has no org_id at all.
--   owner    everything, including billing and inviting people
--   manager  projects, briefs and messages — no billing
--   billing  invoices, payments and messages — cannot change a project
--   member   projects and messages they are attached to
--   viewer   read-only
CREATE TABLE IF NOT EXISTS users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  role           ENUM('admin','customer') NOT NULL DEFAULT 'customer',
  org_id         INT UNSIGNED NULL,
  org_role       ENUM('owner','manager','billing','member','viewer') NOT NULL DEFAULT 'owner',
  job_title      VARCHAR(100) NULL,
  email          VARCHAR(190) NOT NULL,
  password_hash  VARCHAR(100) NOT NULL,
  name           VARCHAR(120) NOT NULL,
  company        VARCHAR(150) NULL,
  phone          VARCHAR(40)  NULL,
  status         ENUM('active','suspended') NOT NULL DEFAULT 'active',
  last_login_at  DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role),
  KEY idx_users_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A quote can arrive from the public site with no account behind it, which is
-- why user_id is nullable. When that visitor later registers with the same
-- address, routes/auth.js claims the orphan quotes for the new account.
CREATE TABLE IF NOT EXISTS quotes (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ref           VARCHAR(20)  NOT NULL,
  user_id       INT UNSIGNED NULL,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  phone         VARCHAR(40)  NULL,
  company       VARCHAR(150) NULL,
  service_type  VARCHAR(40)  NOT NULL,
  scope_tier    VARCHAR(40)  NOT NULL,
  timeline      VARCHAR(40)  NOT NULL,
  features      JSON NULL,
  estimate_min  DECIMAL(12,2) NOT NULL DEFAULT 0,
  estimate_max  DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency      CHAR(3) NOT NULL DEFAULT 'GBP',
  message       TEXT NULL,
  source        VARCHAR(40) NOT NULL DEFAULT 'website',
  status        ENUM('new','reviewing','quoted','accepted','declined') NOT NULL DEFAULT 'new',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_quotes_ref (ref),
  KEY idx_quotes_user (user_id),
  KEY idx_quotes_email (email),
  KEY idx_quotes_status (status),
  CONSTRAINT fk_quotes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- user_id is the person who raised it; org_id is who it belongs to. Access is
-- decided on org_id, so a colleague added to the team next month can still see
-- work started before they existed.
CREATE TABLE IF NOT EXISTS projects (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ref           VARCHAR(20) NOT NULL,
  user_id       INT UNSIGNED NOT NULL,
  org_id        INT UNSIGNED NULL,
  quote_id      INT UNSIGNED NULL,
  title         VARCHAR(160) NOT NULL,
  service_type  VARCHAR(40)  NOT NULL,
  description   TEXT NULL,
  status        ENUM('enquiry','scoping','in_progress','review','live','on_hold','complete','cancelled')
                NOT NULL DEFAULT 'enquiry',
  progress_pct  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  budget_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency      CHAR(3) NOT NULL DEFAULT 'GBP',
  start_date    DATE NULL,
  target_date   DATE NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_ref (ref),
  KEY idx_projects_user (user_id),
  KEY idx_projects_org (org_id),
  KEY idx_projects_status (status),
  CONSTRAINT fk_projects_user  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  CONSTRAINT fk_projects_org   FOREIGN KEY (org_id)   REFERENCES organisations(id) ON DELETE SET NULL,
  CONSTRAINT fk_projects_quote FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who is on a project: the customer's own people and the Vesopa staff working
-- it. This is what makes "who do I talk to about this" answerable, and it is
-- what the direct-message picker reads.
CREATE TABLE IF NOT EXISTS project_members (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  side       ENUM('vesopa','customer') NOT NULL DEFAULT 'customer',
  role_label VARCHAR(60) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member (project_id, user_id),
  KEY idx_member_user (user_id),
  CONSTRAINT fk_member_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Invitations to join a customer's team. Like password resets, only the hash
-- is stored; the emailed link holds the sole copy of the token.
CREATE TABLE IF NOT EXISTS invitations (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id     INT UNSIGNED NOT NULL,
  email      VARCHAR(190) NOT NULL,
  name       VARCHAR(120) NULL,
  org_role   ENUM('owner','manager','billing','member','viewer') NOT NULL DEFAULT 'member',
  token_hash CHAR(64) NOT NULL,
  invited_by INT UNSIGNED NULL,
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invite_token (token_hash),
  KEY idx_invite_org (org_id),
  CONSTRAINT fk_invite_org  FOREIGN KEY (org_id)     REFERENCES organisations(id) ON DELETE CASCADE,
  CONSTRAINT fk_invite_user FOREIGN KEY (invited_by) REFERENCES users(id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The progress timeline the customer sees. is_internal notes stay admin-only,
-- so every read path for a customer must filter on is_internal = 0.
CREATE TABLE IF NOT EXISTS project_updates (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id   INT UNSIGNED NOT NULL,
  author_id    INT UNSIGNED NULL,
  title        VARCHAR(160) NOT NULL,
  body         TEXT NULL,
  progress_pct TINYINT UNSIGNED NULL,
  is_internal  TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_updates_project (project_id, created_at),
  CONSTRAINT fk_updates_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_updates_author  FOREIGN KEY (author_id)  REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The conversation. Three things ride on this table:
--   recipient_id NULL  → the whole project can read it
--   recipient_id set   → private between sender and that one person
--   invoice_id set     → the message carries an invoice card, payable in place
CREATE TABLE IF NOT EXISTS messages (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id   INT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED NULL,
  recipient_id INT UNSIGNED NULL,
  invoice_id   INT UNSIGNED NULL,
  body         TEXT NOT NULL,
  read_at      DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_project (project_id, created_at),
  KEY idx_messages_recipient (recipient_id),
  -- No FK on invoice_id: invoices is created after this table, and a plain
  -- index is enough for a nullable card reference that reads defensively.
  KEY idx_messages_invoice (invoice_id),
  CONSTRAINT fk_messages_project   FOREIGN KEY (project_id)   REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_user      FOREIGN KEY (user_id)      REFERENCES users(id)    ON DELETE SET NULL,
  CONSTRAINT fk_messages_recipient FOREIGN KEY (recipient_id) REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- amount_paid is maintained by lib/invoices.js recalc() from the payments
-- table rather than incremented in place, so a re-run of a webhook or a
-- double-settle cannot inflate it.
CREATE TABLE IF NOT EXISTS invoices (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  number       VARCHAR(20) NOT NULL,
  user_id      INT UNSIGNED NOT NULL,
  org_id       INT UNSIGNED NULL,
  project_id   INT UNSIGNED NULL,
  -- Set when the invoice was raised by the subscription sweep. No FK: the
  -- subscriptions table is created after this one.
  subscription_id INT UNSIGNED NULL,
  issue_date   DATE NOT NULL,
  due_date     DATE NOT NULL,
  currency     CHAR(3) NOT NULL DEFAULT 'GBP',
  subtotal     DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_rate     DECIMAL(5,2)  NOT NULL DEFAULT 0,
  tax_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
  total        DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_paid  DECIMAL(12,2) NOT NULL DEFAULT 0,
  status       ENUM('draft','sent','part_paid','paid','void') NOT NULL DEFAULT 'draft',
  notes        TEXT NULL,
  sent_at      DATETIME NULL,
  paid_at      DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoices_number (number),
  KEY idx_invoices_user (user_id),
  KEY idx_invoices_org (org_id),
  KEY idx_invoices_subscription (subscription_id),
  KEY idx_invoices_status (status),
  CONSTRAINT fk_invoices_org     FOREIGN KEY (org_id)     REFERENCES organisations(id) ON DELETE SET NULL,
  CONSTRAINT fk_invoices_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_invoices_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoice_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id  INT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  qty         DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_price  DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_items_invoice (invoice_id, sort_order),
  CONSTRAINT fk_items_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- provider_ref is UNIQUE (nullable, so manual rows with NULL do not collide):
-- when a real gateway replaces PAYMENT_MODE=mock, a replayed webhook for a
-- reference we already settled fails the insert instead of paying twice.
CREATE TABLE IF NOT EXISTS payments (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id   INT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED NOT NULL,
  amount       DECIMAL(12,2) NOT NULL,
  currency     CHAR(3) NOT NULL DEFAULT 'GBP',
  method       ENUM('manual','bank_transfer','card','crypto','mock') NOT NULL DEFAULT 'manual',
  provider     VARCHAR(40) NOT NULL DEFAULT 'mock',
  provider_ref VARCHAR(120) NULL,
  status       ENUM('pending','settled','failed','refunded') NOT NULL DEFAULT 'settled',
  note         VARCHAR(255) NULL,
  paid_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_provider_ref (provider_ref),
  KEY idx_payments_invoice (invoice_id),
  KEY idx_payments_user (user_id),
  KEY idx_payments_settled (status, paid_at),
  CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  CONSTRAINT fk_payments_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every send is logged whether SMTP is live or mocked, so the mock mode is
-- still inspectable: the portal's admin mail log is the proof a mail fired.
CREATE TABLE IF NOT EXISTS email_log (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  to_email   VARCHAR(190) NOT NULL,
  subject    VARCHAR(255) NOT NULL,
  body       MEDIUMTEXT NULL,
  template   VARCHAR(60) NULL,
  mode       ENUM('mock','smtp') NOT NULL DEFAULT 'mock',
  status     ENUM('sent','failed') NOT NULL DEFAULT 'sent',
  error      VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The task list under a project. is_visible governs whether the customer sees
-- a row at all, so internal work can sit in the same list as the things the
-- customer is waiting on. Progress can be derived from done/total rather than
-- typed in, which is why done_at is recorded rather than just a status flag.
CREATE TABLE IF NOT EXISTS project_tasks (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id  INT UNSIGNED NOT NULL,
  title       VARCHAR(200) NOT NULL,
  detail      TEXT NULL,
  status      ENUM('todo','doing','blocked','done') NOT NULL DEFAULT 'todo',
  assignee_id INT UNSIGNED NULL,
  created_by  INT UNSIGNED NULL,
  due_date    DATE NULL,
  is_visible  TINYINT(1) NOT NULL DEFAULT 1,
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  done_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tasks_project (project_id, status, sort_order),
  KEY idx_tasks_due (due_date),
  CONSTRAINT fk_tasks_project  FOREIGN KEY (project_id)  REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users(id)    ON DELETE SET NULL,
  CONSTRAINT fk_tasks_author   FOREIGN KEY (created_by)  REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Assets attached to a project by either side: briefs, logos, screenshots,
-- signed-off designs. stored_name is a generated random name — the uploader's
-- original filename is kept only as a label, never used as a path, so a file
-- called "../../etc/passwd" is just an awkward label and not a traversal.
CREATE TABLE IF NOT EXISTS project_files (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id    INT UNSIGNED NOT NULL,
  user_id       INT UNSIGNED NULL,
  side          ENUM('vesopa','customer') NOT NULL DEFAULT 'customer',
  stored_name   VARCHAR(120) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime          VARCHAR(120) NULL,
  size_bytes    INT UNSIGNED NOT NULL DEFAULT 0,
  caption       VARCHAR(255) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_files_stored (stored_name),
  KEY idx_files_project (project_id, created_at),
  CONSTRAINT fk_files_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_files_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Where customers can send money. Printed on invoices and quotable into a
-- conversation when we ask to be paid by transfer.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  label        VARCHAR(80) NOT NULL,
  account_name VARCHAR(120) NOT NULL,
  bank_name    VARCHAR(120) NULL,
  account_number VARCHAR(40) NULL,
  sort_code    VARCHAR(20) NULL,
  iban         VARCHAR(60) NULL,
  swift        VARCHAR(20) NULL,
  currency     CHAR(3) NOT NULL DEFAULT 'GBP',
  instructions VARCHAR(400) NULL,
  is_default   TINYINT(1) NOT NULL DEFAULT 0,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bank_active (active, is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recurring revenue: retainers, hosting, support cover, licences.
-- next_charge_date is the whole engine — lib/billing.js sweeps for rows that
-- are due, raises an invoice, and rolls the date forward by one interval.
-- Rolling forward from the *due date* rather than from "today" means a sweep
-- that runs late still bills the right month rather than silently skipping one.
CREATE TABLE IF NOT EXISTS subscriptions (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  org_id          INT UNSIGNED NULL,
  project_id      INT UNSIGNED NULL,
  name            VARCHAR(160) NOT NULL,
  description     VARCHAR(400) NULL,
  amount          DECIMAL(12,2) NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'GBP',
  interval_unit   ENUM('monthly','quarterly','yearly') NOT NULL DEFAULT 'monthly',
  status          ENUM('active','paused','cancelled') NOT NULL DEFAULT 'active',
  next_charge_date DATE NOT NULL,
  last_invoiced_at DATETIME NULL,
  started_at      DATE NULL,
  cancelled_at    DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_subs_user (user_id),
  KEY idx_subs_due (status, next_charge_date),
  CONSTRAINT fk_subs_user    FOREIGN KEY (user_id)    REFERENCES users(id)         ON DELETE CASCADE,
  CONSTRAINT fk_subs_org     FOREIGN KEY (org_id)     REFERENCES organisations(id) ON DELETE SET NULL,
  CONSTRAINT fk_subs_project FOREIGN KEY (project_id) REFERENCES projects(id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Work done but not yet billed: extra hours, a change request, an out-of-scope
-- favour. These are what a customer sees as "pending charges" the moment they
-- log in, and what an admin sweeps into the next invoice in one click.
CREATE TABLE IF NOT EXISTS charges (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  org_id      INT UNSIGNED NULL,
  project_id  INT UNSIGNED NULL,
  invoice_id  INT UNSIGNED NULL,
  description VARCHAR(255) NOT NULL,
  qty         DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_price  DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency    CHAR(3) NOT NULL DEFAULT 'GBP',
  status      ENUM('pending','invoiced','void') NOT NULL DEFAULT 'pending',
  incurred_on DATE NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_charges_user (user_id, status),
  KEY idx_charges_project (project_id),
  CONSTRAINT fk_charges_user    FOREIGN KEY (user_id)    REFERENCES users(id)         ON DELETE CASCADE,
  CONSTRAINT fk_charges_org     FOREIGN KEY (org_id)     REFERENCES organisations(id) ON DELETE SET NULL,
  CONSTRAINT fk_charges_project FOREIGN KEY (project_id) REFERENCES projects(id)      ON DELETE SET NULL,
  CONSTRAINT fk_charges_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reset tokens are stored as a SHA-256 hash, never in the clear: the emailed
-- link is the only place the raw token exists, so a dump of this table cannot
-- be used to take over an account. used_at makes a link single-use.
CREATE TABLE IF NOT EXISTS password_resets (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reset_token (token_hash),
  KEY idx_reset_user (user_id),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notifications are persisted as well as pushed over the websocket, so a user
-- who was offline when something happened still sees it on their next visit.
CREATE TABLE IF NOT EXISTS notifications (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  kind       VARCHAR(40) NOT NULL,
  title      VARCHAR(190) NOT NULL,
  body       VARCHAR(500) NULL,
  href       VARCHAR(255) NULL,
  read_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_user (user_id, read_at, created_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Enquiries sent from the marketing site's contact form. Kept apart from
-- quotes: a quote has a priced scope behind it, this is just someone talking.
CREATE TABLE IF NOT EXISTS enquiries (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  email      VARCHAR(190) NOT NULL,
  phone      VARCHAR(40) NULL,
  subject    VARCHAR(190) NULL,
  message    TEXT NOT NULL,
  status     ENUM('new','read','replied','closed') NOT NULL DEFAULT 'new',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_enquiries_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A contact book that is not the user table: the accountant who must receive
-- invoices, the venue manager who answers the phone on a Friday night. These
-- people have a number and a job, not necessarily a login.
CREATE TABLE IF NOT EXISTS contacts (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id     INT UNSIGNED NULL,
  user_id    INT UNSIGNED NULL,
  project_id INT UNSIGNED NULL,
  name       VARCHAR(120) NOT NULL,
  job_title  VARCHAR(100) NULL,
  email      VARCHAR(190) NULL,
  phone      VARCHAR(40)  NULL,
  mobile     VARCHAR(40)  NULL,
  kind       ENUM('customer','vesopa','supplier','other') NOT NULL DEFAULT 'customer',
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  notes      VARCHAR(500) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_contacts_org (org_id),
  KEY idx_contacts_project (project_id),
  CONSTRAINT fk_contacts_org     FOREIGN KEY (org_id)     REFERENCES organisations(id) ON DELETE CASCADE,
  CONSTRAINT fk_contacts_project FOREIGN KEY (project_id) REFERENCES projects(id)      ON DELETE SET NULL,
  CONSTRAINT fk_contacts_author  FOREIGN KEY (created_by) REFERENCES users(id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which emails a person wants. Defaults are on for everything transactional
-- and off for anything promotional, because that is the only defensible
-- default for a mailing anyone can be added to by a colleague.
CREATE TABLE IF NOT EXISTS email_prefs (
  user_id         INT UNSIGNED NOT NULL,
  on_message      TINYINT(1) NOT NULL DEFAULT 1,
  on_progress     TINYINT(1) NOT NULL DEFAULT 1,
  on_invoice      TINYINT(1) NOT NULL DEFAULT 1,
  on_task         TINYINT(1) NOT NULL DEFAULT 1,
  weekly_digest   TINYINT(1) NOT NULL DEFAULT 1,
  marketing       TINYINT(1) NOT NULL DEFAULT 0,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  name       VARCHAR(60) NOT NULL,
  value      TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
