-- ---------------------------------------------------------------------------
-- How each application asks people to prove who they are.
--
-- THE OWNER'S REQUIREMENT, in their words: give each application the choice of
-- "Vesopa OAuth Google Login API, Vesopa OAuth Microsoft Login API, Vesopa
-- OAuth Github, Vesopa OAuth Email, Vesopa OAuth Phone or anything that comes
-- later, keep the scope open."
--
-- "Anything that comes later" is why this is a TABLE OF ROWS and not a column
-- per provider. A boolean column each means a schema migration, a form edit and
-- a deploy every time somebody adds a provider — and a form that quietly does
-- not match the database until all three have happened. A row means an INSERT.
--
-- Idempotent, like every file here. `vesopa_add_column` is defined by
-- schema.sql and deliberately NOT dropped there, so later files can use it;
-- it is redefined here anyway so this file is safe to run on its own.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_ddl    TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_column)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- application_auth_methods — which ways in this application offers.
--
-- `method` is a VARCHAR and not an ENUM, and that is the whole point of the
-- table. An ENUM would need an ALTER to gain a value, which is the migration
-- this design exists to avoid. The application layer holds the list of methods
-- it knows how to render; a row naming one it does not know is ignored rather
-- than shown, so a half-deployed provider is invisible instead of broken.
--
-- `sort` decides the order on the page. It matters more than it looks: the
-- first button is the one most people press, so which method leads is a
-- business decision and not an alphabetical accident.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_auth_methods (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  method         VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  enabled        TINYINT(1) NOT NULL DEFAULT 1,
  sort           SMALLINT NOT NULL DEFAULT 100,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_app_method (application_id, method),
  KEY idx_app_method_order (application_id, enabled, sort),
  CONSTRAINT fk_app_method_app FOREIGN KEY (application_id)
    REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- applications.auth_policy — what the page does FIRST.
--
--   password_first  find the person, then ask for a password, with a text link
--                   under it offering an emailed code instead. The owner's
--                   default: "By default, it will ask for password in apps too."
--   code_first      find the person and send a code. Right for the QR menu,
--                   where a diner has no password and never will.
--   provider_only   no local credential at all — Continue with Google, and
--                   nothing else. Right for an internal tool.
--
-- It is a POLICY, not a restriction. `password_first` still offers the code;
-- what the policy decides is which one the person is looking at when the page
-- finishes loading, and that is the only thing most people ever act on.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('applications', 'auth_policy',
  "ENUM('password_first','code_first','provider_only') NOT NULL DEFAULT 'password_first' AFTER guest_allowed");

-- ---------------------------------------------------------------------------
-- applications.show_consent — demand the consent screen even from our own apps.
--
-- First-party applications skip consent today, which is ordinary and
-- defensible: nobody wants to grant Vesopa access to Vesopa every morning. The
-- owner asked for consent on every authorisation, so it becomes a setting, and
-- the setting defaults to ON for anything that is not first-party.
--
-- Worth stating plainly: being able to SEE what the till is asking for is worth
-- more than one saved tap, and a consent screen nobody is ever shown is a
-- promise in a policy document rather than a control.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('applications', 'show_consent',
  'TINYINT(1) NOT NULL DEFAULT 1 AFTER auth_policy');


-- ---------------------------------------------------------------------------
-- Backfill: give every existing application the methods it already behaves as
-- though it has, so nothing changes the moment this lands.
--
-- Email codes and passkeys for everybody, because that is what the sign-in page
-- does today. Passwords for everybody, because the page will offer one to
-- anybody who has set one. Social providers only where the server actually has
-- credentials — a button for a provider we cannot complete is worse than no
-- button, and this table must not become a way to bring one back.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO application_auth_methods (application_id, method, enabled, sort)
SELECT a.id, m.method, 1, m.sort
  FROM applications a
  JOIN (
        SELECT 'password'   AS method, 10 AS sort
  UNION SELECT 'code_email',  20
  UNION SELECT 'code_sms',    30
  UNION SELECT 'passkey',     40
  ) m
 WHERE a.deleted_at IS NULL;

-- Google is live; the others are added by the seed when their credentials
-- appear. Doing it here rather than in application code keeps "which buttons
-- does this app show" answerable with one query.
INSERT IGNORE INTO application_auth_methods (application_id, method, enabled, sort)
SELECT a.id, 'google', 1, 50 FROM applications a WHERE a.deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- The QR menu is the exception, and the exception is the point of the column.
--
-- A diner at a table has no Vesopa password and is not about to invent one, so
-- asking for one first is a wall in front of a menu. It leads with a code — and
-- most of them will not sign in at all, which is untouched either way.
-- ---------------------------------------------------------------------------
UPDATE applications SET auth_policy = 'code_first' WHERE slug = 'vesopa-menu';
DELETE FROM application_auth_methods
 WHERE method = 'password'
   AND application_id = (SELECT id FROM applications WHERE slug = 'vesopa-menu');
