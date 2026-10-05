-- ---------------------------------------------------------------------------
-- admin.vesopa.com: the client Vesopa's own administrators sign in with
-- (2026-10-05).
--
-- One app to run every Vesopa app, venue, licence and admin. Connect with
-- Vesopa is its only door ("must be logged with Connect with Vesopa", owner).
--
--   * CONFIDENTIAL ('web'): a server holds the secret, minted into a file on
--     the box by scripts/mint-client-secret.js vesopa-admin-console.
--   * allow_self_enroll ON, deliberately: WHO MAY GET IN is decided by
--     admin.vesopa.com itself (OWNER_EMAIL, then its adm_admins table), so a
--     sub admin the owner adds there can sign in at once with their Vesopa
--     account. Anybody else completes Auth's sign-in and is then refused by
--     admin.vesopa.com, with nothing to see.
--   * show_consent OFF: Vesopa's own staff signing in to Vesopa's own tool.
--
-- The client id is minted here; the deploy reads it back with
--   SELECT client_id FROM applications WHERE slug = 'vesopa-admin-console';
-- Re-runnable.
-- ---------------------------------------------------------------------------
SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @bo := (SELECT id FROM applications WHERE slug = 'vesopa-backoffice' LIMIT 1);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type,
   app_display_name, is_first_party, show_consent, allow_self_enroll,
   auth_policy, subject_type, access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Admin', 'vesopa-admin-console',
       'Run every Vesopa app, venue, licence and admin.', 'web',
       'Vesopa Admin', 1, 0, 1, 'code_first', 'public',
       COALESCE((SELECT access_token_ttl FROM applications WHERE id = @bo), 900),
       COALESCE((SELECT refresh_token_ttl FROM applications WHERE id = @bo), 2592000),
       'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-admin-console');

SET @admin := (SELECT id FROM applications WHERE slug = 'vesopa-admin-console' LIMIT 1);

-- Open to every Vesopa account, first-party, confidential — even if somebody
-- edited it by hand.
UPDATE applications
   SET allow_self_enroll = 1, show_consent = 0, is_first_party = 1, client_type = 'web'
 WHERE id = @admin;

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
SELECT @admin, 'https://admin.vesopa.com/callback', 'login'
 WHERE @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_redirect_uris r
                    WHERE r.application_id = @admin
                      AND r.uri = 'https://admin.vesopa.com/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @admin, 'https://admin.vesopa.com/signin', 'logout'
 WHERE @admin IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_redirect_uris r
                    WHERE r.application_id = @admin
                      AND r.uri = 'https://admin.vesopa.com/signin');
