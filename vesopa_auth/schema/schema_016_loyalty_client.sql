-- ---------------------------------------------------------------------------
-- Vesopa Loyalty: the OAuth client a venue's members sign in with.
--
-- WHAT IT IS FOR
--
-- A venue's loyalty app signs members in with an emailed code by default. A
-- venue that already issues Vesopa accounts -- a members' club, a staff canteen,
-- a society -- wants "Continue with Vesopa" instead, so its people have one set
-- of credentials rather than two.
--
-- WHY IT IS A CLIENT OF ITS OWN and not the till's
--
-- The people signing in here are a venue's CUSTOMERS, not its staff. Sharing the
-- till's client would mean every member appeared in the till application's
-- directory, would inherit the till's scopes and roles, and would be counted
-- against the till's licence. Vesopa EPOS and Vesopa Express shared a client
-- once and the reasons it was wrong were the same ones.
--
-- GRANTS, SCOPES AND ROLES ARE SET HERE, not left for later.
--
-- schema_014 created three clients and gave them none of these, which is what
-- made Vesopa Express answer `unauthorized_client` on a machine where the till
-- signed in perfectly. A client without grant rows cannot use the authorization
-- code flow at all. See schema_015, which was the repair.
--
-- WHAT IS DELIBERATELY DIFFERENT FROM THE TILL
--
--   * show_consent is ON. The till is a first-party app a venue installs on its
--     own hardware; this asks a MEMBER OF THE PUBLIC to connect their personal
--     Vesopa account to a venue's app. That is exactly the case a consent screen
--     is for, and skipping it because we happen to own both ends would be
--     helping ourselves to somebody's identity quietly.
--   * auth_policy is code_first. The people using it are customers who may never
--     have set a password, and leading with one they have not got is how a
--     sign-in gets abandoned.
--   * The redirect URIs cover both shapes the app ships in: a web address under
--     the menu host for the browser build, and a loopback for the Windows,
--     Android and iPhone builds, which open the system browser and listen on a
--     port of their own exactly as the till and the kiosk do.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

-- The till, whose grants, scopes and roles are copied rather than retyped.
SET @till := (SELECT id FROM applications WHERE slug = 'vesopa-epos' LIMIT 1);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type, app_scheme,
   app_display_name, is_first_party, show_consent, auth_policy, subject_type,
   access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Loyalty', 'vesopa-loyalty',
       'A venue''s own loyalty card, points and news.', 'spa', 'vesopa-loyalty',
       'Vesopa Loyalty', 1, 1, 'code_first', 'public', 900, 2592000,
       'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-loyalty');

SET @loyalty := (SELECT id FROM applications WHERE slug = 'vesopa-loyalty' LIMIT 1);


-- ---------------------------------------------------------------------------
-- How it may be signed in to
-- ---------------------------------------------------------------------------

INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT @loyalty, m.method, m.enabled, m.sort
  FROM application_auth_methods m
 WHERE m.application_id = 1
   AND @loyalty IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_auth_methods x
      WHERE x.application_id = @loyalty AND x.method = m.method);


-- ---------------------------------------------------------------------------
-- What it may do. The three schema_014 forgot.
-- ---------------------------------------------------------------------------

INSERT INTO application_grants (application_id, grant_type)
SELECT @loyalty, g.grant_type
  FROM application_grants g
 WHERE g.application_id = @till
   AND @loyalty IS NOT NULL AND @till IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_grants x
      WHERE x.application_id = @loyalty AND x.grant_type = g.grant_type);

INSERT INTO application_scopes (application_id, scope_id)
SELECT @loyalty, s.scope_id
  FROM application_scopes s
 WHERE s.application_id = @till
   AND @loyalty IS NOT NULL AND @till IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_scopes x
      WHERE x.application_id = @loyalty AND x.scope_id = s.scope_id);

INSERT INTO application_roles (application_id, role_key, name, description, is_default)
SELECT @loyalty, r.role_key, r.name, r.description, r.is_default
  FROM application_roles r
 WHERE r.application_id = @till
   AND @loyalty IS NOT NULL AND @till IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_roles x
      WHERE x.application_id = @loyalty AND x.role_key = r.role_key);


-- ---------------------------------------------------------------------------
-- Where it may send somebody back to
--
-- One address for every venue: the app is one build served at
-- menu.vesopaepos.com/app/<slug>/, and it works out which venue it is from the
-- path it is already on. A redirect URI per venue would mean a row added every
-- time somebody switched an app on, and a venue whose row was missed would meet
-- `invalid_redirect_uri` with nothing in the app to explain it.
--
-- The callback page hands the code back to the app and nothing else, which is
-- why one address can serve them all.
-- ---------------------------------------------------------------------------

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @loyalty, 'https://menu.vesopaepos.com/app/vesopa/callback', 'login'
 WHERE @loyalty IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @loyalty
        AND r.uri = 'https://menu.vesopaepos.com/app/vesopa/callback');

-- The Windows, Android and iPhone builds are native apps and cannot be sent
-- to a web page: they open the system browser and listen on a loopback port
-- the operating system chooses. Port 0 stands for "any" -- registration
-- ignores the port on a loopback address (RFC 8252 section 7.3) -- which is
-- what lets one row serve every machine.
INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @loyalty, 'http://127.0.0.1:0/callback', 'login'
 WHERE @loyalty IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @loyalty AND r.uri = 'http://127.0.0.1:0/callback');

-- Signing out sends somebody back to the app they were in.
INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @loyalty, 'https://menu.vesopaepos.com/app/vesopa/signed-out', 'logout'
 WHERE @loyalty IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @loyalty
        AND r.uri = 'https://menu.vesopaepos.com/app/vesopa/signed-out');
