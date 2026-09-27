-- ---------------------------------------------------------------------------
-- Metric Membership: the client Metric Group's members and staff sign in with.
--
-- WHAT IT IS FOR
--
-- metric.vesopa.com is a white-label membership for Metric Group (a Vesopa
-- customer): a driver registers their car registrations and Metric's ANPR
-- barriers let those cars in and out (vesopa_metric, vesopa_metric_server).
-- Members sign in with Continue with Vesopa on every platform, and Metric's
-- staff use the same door into the console at metric.vesopa.com/admin (who
-- is staff is decided by that server, not by a role here).
--
-- Shaped like the loyalty client, for the same reasons:
--
--   * PUBLIC, with PKCE: the Windows, Android and iPhone builds are native
--     apps on somebody's own device and can keep no secret. client_type
--     'native', as schema_018 settled for loyalty.
--   * allow_self_enroll ON: any driver with a Vesopa account, or who makes
--     one, may sign in. A new member opens no barrier until Metric approves
--     them on the console.
--   * show_consent ON: a personal account joined to a customer's app, asked
--     properly, and named as Metric's.
--   * auth_policy code_first: drivers may never have set a password.
--
-- The client_id is minted here; the deploy reads it back
--   SELECT client_id FROM applications WHERE slug = 'vesopa-metric';
-- into the server's .env (VESOPA_METRIC_CLIENT_ID) and the app builds
-- (--dart-define=VESOPA_METRIC_CLIENT_ID=...). No secret is needed.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @bo := (SELECT id FROM applications WHERE slug = 'vesopa-backoffice' LIMIT 1);
SET @loyalty := (SELECT id FROM applications WHERE slug = 'vesopa-loyalty' LIMIT 1);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type, app_scheme,
   app_display_name, is_first_party, show_consent, allow_self_enroll,
   auth_policy, subject_type, access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Metric Membership', 'vesopa-metric',
       'Register your car and Metric''s barriers open for you.', 'native', 'vesopa-metric',
       'Metric Membership', 1, 1, 1, 'code_first', 'public', 900, 2592000, 'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-metric');

SET @metric := (SELECT id FROM applications WHERE slug = 'vesopa-metric' LIMIT 1);

-- Open, public and asked properly, even if somebody edited it by hand.
UPDATE applications SET allow_self_enroll = 1, show_consent = 1, client_type = 'native' WHERE id = @metric;

-- The same ways in as the loyalty app (an emailed code first).
INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT @metric, m.method, m.enabled, m.sort
  FROM application_auth_methods m
 WHERE m.application_id = COALESCE(@loyalty, @bo)
   AND @metric IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_auth_methods x
      WHERE x.application_id = @metric AND x.method = m.method);

INSERT INTO application_grants (application_id, grant_type)
SELECT @metric, g.grant_type
  FROM application_grants g
 WHERE g.application_id = COALESCE(@loyalty, @bo)
   AND @metric IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_grants x
      WHERE x.application_id = @metric AND x.grant_type = g.grant_type);

INSERT INTO application_scopes (application_id, scope_id)
SELECT @metric, s.scope_id
  FROM application_scopes s
 WHERE s.application_id = COALESCE(@loyalty, @bo)
   AND @metric IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_scopes x
      WHERE x.application_id = @metric AND x.scope_id = s.scope_id);

-- The web app and the console come back to the server, which hands a
-- member's code to the app in its own tab (vesopa_metric_server/src/admin.js).
INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @metric, 'https://metric.vesopa.com/auth/callback', 'login'
 WHERE @metric IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @metric AND r.uri = 'https://metric.vesopa.com/auth/callback');

-- The Windows, Android and iPhone builds: the system browser, then a loopback
-- port the operating system picks (RFC 8252 section 7.3), as loyalty does.
INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @metric, 'http://127.0.0.1:0/callback', 'login'
 WHERE @metric IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @metric AND r.uri = 'http://127.0.0.1:0/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @metric, 'https://metric.vesopa.com/', 'logout'
 WHERE @metric IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @metric AND r.uri = 'https://metric.vesopa.com/');
