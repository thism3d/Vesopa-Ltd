-- ---------------------------------------------------------------------------
-- Deleting an account, and the data each app holds, on request.
--
-- WHY THIS EXISTS
--
-- Google Play requires every app that lets people make an account to offer a
-- way to delete it both inside the app and on a web page that works without
-- the app installed. The page has to name the app, say what is deleted and
-- what is kept, and actually do it. UK GDPR asks the same of us regardless.
--
-- The old /account/delete only covered a Vesopa account, only for somebody who
-- had one, and nothing ever purged the row afterwards. A member of a venue's
-- loyalty app who signed in with an emailed code has no Vesopa account at all:
-- their card, points and photo live in that venue's back office.
--
-- WHAT THE OWNER ASKED FOR (2026-09-17)
--
--   * one page, per-app choices: the Vesopa account and each app's data
--   * the person chooses: deleted automatically after 7, 15 or 30 days (the
--     default), or "as soon as possible", which an administrator reviews and
--     carries out
--   * info@vesopasoftware.com sees every request, approves the manual ones,
--     and can see and bring forward the automatic ones
--
-- HOW AN APP TAKES PART
--
-- An application that holds personal data registers a privacy provider: an
-- HTTPS endpoint and a shared secret. Vesopa Auth asks it what it holds for an
-- address (lookup) and tells it to erase (erase), signed both ways. The app can
-- also file a request itself when a signed-in member asks from inside the app.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS application_privacy_providers (
  application_id  INT UNSIGNED NOT NULL,
  -- Base URL; the actions are appended: <endpoint>/lookup, /erase, /describe.
  endpoint_url    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- AES-256-GCM under ENCRYPTION_KEY, like webhook secrets.
  secret_cipher   VARBINARY(512) NOT NULL,
  -- What the deletion page calls this app's data when it cannot ask.
  data_label      VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  is_enabled      TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (application_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS deletion_requests (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- The address the request was proved from. Masked once the request is
  -- finished (email_hash keeps it findable), because a list of everybody who
  -- asked to be forgotten, by name, is the one list that must not survive them.
  email              VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  email_hash         CHAR(64) CHARACTER SET ascii NOT NULL DEFAULT '',
  -- A member who signs in by text message may have no email at all.
  contact_label      VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  user_id            INT UNSIGNED NULL,

  source             ENUM('web','app') NOT NULL DEFAULT 'web',
  source_application_id INT UNSIGNED NULL,
  -- The app named on the page the person came from (Google's "the app or
  -- developer name as shown on the store listing").
  app_label          VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  mode               ENUM('scheduled','review') NOT NULL,
  delay_days         SMALLINT UNSIGNED NULL,
  status             ENUM('awaiting_review','scheduled','processing','completed','needs_attention','cancelled','rejected')
                     NOT NULL,
  due_at             DATETIME NULL,

  -- The link emailed to the person, which shows the request and cancels it.
  manage_token_hash  CHAR(64) CHARACTER SET ascii NOT NULL,

  requested_ip       VARCHAR(64) CHARACTER SET ascii NOT NULL DEFAULT '',
  requested_user_agent VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  decided_by_user_id INT UNSIGNED NULL,
  decided_at         DATETIME NULL,
  decision_note      VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  started_at         DATETIME NULL,
  completed_at       DATETIME NULL,
  cancelled_at       DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_deletion_public (public_id),
  KEY idx_deletion_due (status, due_at),
  KEY idx_deletion_email (email_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS deletion_request_items (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id       INT UNSIGNED NOT NULL,
  kind             ENUM('vesopa_account','app_data') NOT NULL,
  application_id   INT UNSIGNED NULL,
  -- The provider's own opaque id for the thing (a membership), never parsed here.
  reference        VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  label            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  detail           VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  status           ENUM('pending','done','failed','cancelled') NOT NULL DEFAULT 'pending',
  result           VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  completed_at     DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_deletion_items_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
