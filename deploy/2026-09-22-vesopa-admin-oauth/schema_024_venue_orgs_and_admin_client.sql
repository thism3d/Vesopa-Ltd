-- ---------------------------------------------------------------------------
-- Venues become organisations; the EPOS admin console becomes a client.
--
-- TWO THINGS, because the second is the only caller of the first.
--
-- 1. organisations.external_ref / managed_by_application_id
--
--    The back office already reads a venue's licences from here by
--    organisation, and already has offices.auth_organisation_id to say which
--    one. There was no way to make a venue's organisation, so auth held only
--    Vesopa's own. /api/app/venues/provision (src/venues.js) now makes them,
--    and finds them again by `external_ref` — the caller's own stable name for
--    the venue ("epos-office:35") — so that running it twice changes nothing.
--    NULL for every organisation that was not made that way, and a UNIQUE key
--    on a nullable column admits any number of NULLs, so Vesopa's own
--    organisation is untouched.
--
-- 2. "Vesopa EPOS Administration" — vesopaepos.com/admin
--
--    First-party, confidential, NO self-enrolment: an admin is somebody Vesopa
--    Software has decided may see every venue's billing, so a membership row is
--    required and is granted here to info@vesopasoftware.com, the owner's
--    decision of 2026-09-22. MFA is recommended to admins but not required
--    (min_acr stays NULL), also the owner's decision.
--
--    Sign-in methods, grants and scopes are copied from the back office, which
--    is the closest thing it is. The secret is NOT made here: it is minted with
--    scripts/mint-client-secret.js straight into a 0600 file, so the plaintext
--    never passes through a terminal or this file.
--
-- NEW COLUMNS GO IN TWO PLACES — see the trap recorded in the plan (§7):
-- schema.sql for a fresh database, and here for the ones that exist.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

-- Defined here and dropped at the end, as schema_013 does: the helper is not
-- kept in the database between migrations.
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

CALL vesopa_add_column('organisations', 'external_ref',
  'VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL DEFAULT NULL AFTER status');
CALL vesopa_add_column('organisations', 'managed_by_application_id',
  'INT UNSIGNED NULL DEFAULT NULL AFTER external_ref');

SET @has_idx := (SELECT COUNT(*) FROM information_schema.statistics
                  WHERE table_schema = DATABASE() AND table_name = 'organisations'
                    AND index_name = 'uq_org_external_ref');
SET @ddl := IF(@has_idx = 0,
  'ALTER TABLE organisations ADD UNIQUE KEY uq_org_external_ref (external_ref)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- the admin console as a client ---------------------------------------

SET @bo := (SELECT id FROM applications WHERE slug = 'vesopa-backoffice' LIMIT 1);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type,
   app_display_name, is_first_party, show_consent, allow_self_enroll,
   auth_policy, subject_type, access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa EPOS Administration', 'vesopa-epos-admin',
       'The staff console for vesopaepos.com: venues, billing, plans and the blog.', 'web',
       'Vesopa Admin', 1, 0, 0, 'password_first', 'public',
       COALESCE((SELECT access_token_ttl FROM applications WHERE id = @bo), 900),
       COALESCE((SELECT refresh_token_ttl FROM applications WHERE id = @bo), 2592000),
       'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-epos-admin');

SET @admin := (SELECT id FROM applications WHERE slug = 'vesopa-epos-admin' LIMIT 1);

INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT @admin, m.method, m.enabled, m.sort
  FROM application_auth_methods m
 WHERE m.application_id = @bo AND @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_auth_methods x
                    WHERE x.application_id = @admin AND x.method = m.method);

INSERT INTO application_grants (application_id, grant_type)
SELECT @admin, g.grant_type
  FROM application_grants g
 WHERE g.application_id = @bo AND @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_grants x
                    WHERE x.application_id = @admin AND x.grant_type = g.grant_type);

INSERT INTO application_scopes (application_id, scope_id)
SELECT @admin, s.scope_id
  FROM application_scopes s
 WHERE s.application_id = @bo AND @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_scopes x
                    WHERE x.application_id = @admin AND x.scope_id = s.scope_id);

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @admin, 'https://vesopaepos.com/admin/auth/vesopa/callback', 'login'
 WHERE @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_redirect_uris r
                    WHERE r.application_id = @admin
                      AND r.uri = 'https://vesopaepos.com/admin/auth/vesopa/callback');

-- Roles are informational: the console decides what somebody may do from its
-- own admin_table.status, and is not governed by these. They make the developer
-- console say something true about who these people are.
INSERT INTO application_roles (application_id, role_key, name, description, is_default)
SELECT @admin, 'admin.full', 'Administrator', 'Every screen, including billing and other admins.', 0
 WHERE @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_roles WHERE application_id = @admin AND role_key = 'admin.full');
INSERT INTO application_roles (application_id, role_key, name, description, is_default)
SELECT @admin, 'admin.contributor', 'Contributor', 'Blog and File Manager, own rows only.', 0
 WHERE @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_roles WHERE application_id = @admin AND role_key = 'admin.contributor');

-- ---- who may sign in -----------------------------------------------------
--
-- By verified address, so a membership is only ever granted to an account that
-- has already proved it owns the address the console knows.

INSERT INTO application_members (application_id, user_id, status)
SELECT @admin, i.user_id, 'active'
  FROM user_identities i
 WHERE @admin IS NOT NULL AND i.type = 'email' AND i.revoked_at IS NULL
   AND i.verified_at IS NOT NULL
   AND i.identifier_norm IN ('info@vesopasoftware.com', 'mehedi901952@gmail.com')
   AND NOT EXISTS (SELECT 1 FROM application_members m
                    WHERE m.application_id = @admin AND m.user_id = i.user_id);

INSERT IGNORE INTO application_member_roles (member_id, role_id)
SELECT m.id, r.id
  FROM application_members m
  JOIN user_identities i ON i.user_id = m.user_id AND i.type = 'email' AND i.revoked_at IS NULL
  JOIN application_roles r ON r.application_id = @admin
       AND r.role_key = IF(i.identifier_norm = 'mehedi901952@gmail.com', 'admin.contributor', 'admin.full')
 WHERE m.application_id = @admin
   AND i.identifier_norm IN ('info@vesopasoftware.com', 'mehedi901952@gmail.com');

DROP PROCEDURE IF EXISTS vesopa_add_column;
