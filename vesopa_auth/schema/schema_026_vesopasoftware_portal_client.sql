-- ---------------------------------------------------------------------------
-- The Vesopa Software client area: Continue with Vesopa at vesopasoftware.com.
--
-- WHAT IT IS FOR
--
-- vesopasoftware.com/portal is where Vesopa Software's customers follow their
-- projects, quotes and invoices (vesopasoftware/server). It has always had its
-- own email-and-password login; this client puts Continue with Vesopa beside
-- it (vesopasoftware/server/routes/vesopa-sso.js). The password form stays.
--
-- Shaped like the EPOS admin console (schema_024) for what it IS, and like
-- the self-enrolling web clients (schema_019, schema_020) for who may use it:
--
--   * CONFIDENTIAL 'web' client, FIRST-PARTY: the portal's server holds the
--     secret and exchanges the code itself.
--   * allow_self_enroll ON: any customer with a Vesopa account may sign in.
--     There is nothing behind the door but their own (possibly brand-new,
--     empty) client-area account; the portal decides what they can see.
--   * show_consent OFF: it is Vesopa's own site, and nobody needs to grant
--     Vesopa access to Vesopa.
--   * auth_policy code_first: most customers have never set a Vesopa
--     password, and an emailed code is the way in that needs none.
--
-- Sign-in methods, grants and scopes are copied from the back office, as
-- schema_024 does. The secret is NOT made here: it is minted with
-- scripts/mint-client-secret.js vesopasoftware-portal <file> straight into a
-- 0600 file (tool/deploy_client_area_vesopa_connect.py does this), so the
-- plaintext never passes through a terminal or this file.
--
-- The live site is the bare domain (no www: its canonical links and BASE_URL
-- are https://vesopasoftware.com), so that is what is registered. Redirect
-- URIs are matched exactly.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @bo := (SELECT id FROM applications WHERE slug = 'vesopa-backoffice' LIMIT 1);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type,
   app_display_name, is_first_party, show_consent, allow_self_enroll,
   auth_policy, subject_type, access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Software client area', 'vesopasoftware-portal',
       'Your projects with Vesopa Software: progress, quotes, files and invoices.', 'web',
       'Vesopa Software', 1, 0, 1, 'code_first', 'public',
       COALESCE((SELECT access_token_ttl FROM applications WHERE id = @bo), 900),
       COALESCE((SELECT refresh_token_ttl FROM applications WHERE id = @bo), 2592000),
       'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopasoftware-portal');

SET @portal := (SELECT id FROM applications WHERE slug = 'vesopasoftware-portal' LIMIT 1);

-- Open to every Vesopa account, first-party, confidential — even if somebody
-- edited it by hand.
UPDATE applications
   SET allow_self_enroll = 1, show_consent = 0, is_first_party = 1, client_type = 'web'
 WHERE id = @portal;

INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT @portal, m.method, m.enabled, m.sort
  FROM application_auth_methods m
 WHERE m.application_id = @bo AND @portal IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_auth_methods x
                    WHERE x.application_id = @portal AND x.method = m.method);

INSERT INTO application_grants (application_id, grant_type)
SELECT @portal, g.grant_type
  FROM application_grants g
 WHERE g.application_id = @bo AND @portal IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_grants x
                    WHERE x.application_id = @portal AND x.grant_type = g.grant_type);

INSERT INTO application_scopes (application_id, scope_id)
SELECT @portal, s.scope_id
  FROM application_scopes s
 WHERE s.application_id = @bo AND @portal IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_scopes x
                    WHERE x.application_id = @portal AND x.scope_id = s.scope_id);

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @portal, 'https://vesopasoftware.com/portal/auth/vesopa/callback', 'login'
 WHERE @portal IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_redirect_uris r
                    WHERE r.application_id = @portal
                      AND r.uri = 'https://vesopasoftware.com/portal/auth/vesopa/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @portal, 'https://vesopasoftware.com/portal/login', 'logout'
 WHERE @portal IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_redirect_uris r
                    WHERE r.application_id = @portal
                      AND r.uri = 'https://vesopasoftware.com/portal/login');
