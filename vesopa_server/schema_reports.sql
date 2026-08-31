-- Scheduled reports: a report that runs itself and arrives by email.
--
-- Two tables. `bo_report_schedules` is what a manager sets up; `bo_report_runs`
-- is what happened each time one fired. The second is not a log for developers
-- — it is the answer to "the Monday report didn't arrive", which is a question
-- a venue asks and which is unanswerable without a record of the attempt, the
-- addresses it went to, and why it failed.
--
-- Target is MySQL 5.7 / MariaDB. Everything is CREATE TABLE IF NOT EXISTS, so
-- deploy.sh can run it on every deploy.
--
-- Collation note, as in schema_screens.sql: `office` is an email address and
-- gets compared against columns that are utf8mb4_general_ci, so it is stated
-- explicitly rather than left to the server's default.

CREATE TABLE IF NOT EXISTS bo_report_schedules (
  id          INT AUTO_INCREMENT PRIMARY KEY,

  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,

  name        VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,

  -- The report's key, not its label. A schedule set up months ago must survive
  -- somebody renaming "Financial Summary" on the screen.
  report_key  VARCHAR(60) NOT NULL,

  -- pdf | csv | xls
  format      VARCHAR(8) NOT NULL DEFAULT 'pdf',

  -- daily | weekly | monthly | quarterly | yearly
  frequency   VARCHAR(16) NOT NULL DEFAULT 'daily',

  -- Minutes past midnight, local time. Stored as a number rather than a TIME
  -- because every driver, connection charset and MySQL version has its own
  -- opinion about how a TIME comes back — as a string, as a Date in 1970, as
  -- milliseconds — and "08:30" turning into "1970-01-01T08:30:00Z" is how a
  -- schedule silently moves an hour when the clocks change.
  run_at_minute SMALLINT NOT NULL DEFAULT 510,

  -- Which window the report covers when it runs: today, yesterday, this_week…
  -- Deliberately separate from `frequency`. "Run every Monday, covering last
  -- week" and "run every Monday, covering yesterday" are both things a venue
  -- asks for, and collapsing the two into one field makes the second
  -- impossible to express.
  period      VARCHAR(24) NOT NULL DEFAULT 'today',

  -- Comma-separated. A list of addresses is not worth a second table: nothing
  -- ever queries across it, and the venue types it as one line.
  recipients  TEXT NOT NULL,

  active      TINYINT(1) NOT NULL DEFAULT 1,

  last_run_at DATETIME NULL,

  -- When it is next due. Computed on save and after every run, so the tick can
  -- find due schedules with an indexed comparison instead of working out the
  -- next occurrence of every schedule in the database once a minute.
  next_run_at DATETIME NULL,

  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_schedule_office (office),
  -- The tick's own index: active schedules, soonest first.
  INDEX idx_schedule_due (active, next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS bo_report_runs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  schedule_id INT NOT NULL,

  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,

  ran_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- sent | failed | no_mail
  --
  -- `no_mail` is its own outcome rather than a failure: an installation with
  -- SMTP unconfigured is a normal state during setup, and reporting it as a
  -- failure would bury the real ones.
  status      VARCHAR(16) NOT NULL,

  -- What went wrong, or what was sent. Read by a human answering "the Monday
  -- report didn't arrive".
  detail      VARCHAR(500) NULL,

  recipients  TEXT NULL,

  -- The window the report actually covered, so a run can be checked against
  -- the figures somebody is holding.
  covered_from DATETIME NULL,
  covered_to   DATETIME NULL,

  CONSTRAINT fk_run_schedule FOREIGN KEY (schedule_id)
    REFERENCES bo_report_schedules (id) ON DELETE CASCADE,
  INDEX idx_run_schedule (schedule_id, ran_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
