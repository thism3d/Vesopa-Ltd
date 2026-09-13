-- ---------------------------------------------------------------------------
-- Finishing the catalogue: every product sellable, every app its own client.
--
-- WHAT WAS WRONG
--
-- Vesopa EPOS, Vesopa Kitchen and Vesopa Express all signed people in through
-- ONE OAuth client -- the till's. Not a decision: `verifyTillToken` was written
-- for the till, and the kitchen and the kiosk reused it because it worked. The
-- evidence is the error a refused KIOSK is given: "that token was not minted
-- for the till".
--
-- Sharing one client costs more than tidiness:
--
--   * the audience check stops meaning anything. Its whole job is "this token
--     was minted for THIS product", and with one client a token issued to
--     commission a till is accepted to commission a kitchen screen or a kiosk;
--   * the consent screen names the wrong product -- somebody setting up a kiosk
--     is asked to authorise "Vesopa EPOS";
--   * per-app policy is wasted. EPOS is `password_first` and Menu is
--     `code_first`, so the mechanism is real and in use -- but a kiosk in a
--     public area cannot be held to a different bar from a till behind a
--     counter, because it is not a separate app;
--   * rotating or revoking EPOS takes the kitchen screens and kiosks with it.
--
-- And `products` was missing `express` and `loyalty` entirely, so neither could
-- be sold, counted or priced.
--
-- WHAT THIS FILE DOES NOT DO
--
-- It does not switch any app over. The new clients are created and sit unused
-- until the server is taught to accept them AND the legacy audience together --
-- see docs/plan-2026-09-13-entitlement-and-admin.md. Every device in the field
-- holds a token minted for the EPOS client; a flag day would leave every
-- kitchen screen and kiosk unable to commission until somebody walked to it.
--
-- Loyalty gets a PRODUCT but no OAuth client, deliberately. Its users are a
-- venue's customers signing in with an emailed code on /loyalty/v1 -- they are
-- not Vesopa accounts, so there is nothing for an OIDC client to do. It still
-- needs a product so it can be sold and licensed.
--
-- Re-runnable: everything is guarded on a slug that already exists.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- 1. The two missing products
-- ---------------------------------------------------------------------------

INSERT INTO products (slug, name, description, mark, tint, manage_url, sort)
SELECT 'express', 'Vesopa Express', 'Self-service kiosks customers order at.',
       'device', 'violet', '', 35
 WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug = 'express');

INSERT INTO products (slug, name, description, mark, tint, manage_url, sort)
SELECT 'loyalty', 'Vesopa Loyalty', 'A venue''s own loyalty card, points and news.',
       'card', 'rose', '', 45
 WHERE NOT EXISTS (SELECT 1 FROM products WHERE slug = 'loyalty');

-- ---------------------------------------------------------------------------
-- 2. An OAuth client per app
--
-- Shaped on the till (application 1): a NATIVE client with no secret, because
-- a kitchen screen and a kiosk are desktop applications that cannot keep one.
-- PKCE is what protects them, as it already protects the till.
-- ---------------------------------------------------------------------------

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type, app_scheme,
   app_display_name, is_first_party, show_consent, auth_policy, subject_type,
   access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Kitchen', 'vesopa-kitchen',
       'Kitchen screens and order routing.', 'native', 'vesopa-kitchen',
       'Vesopa Kitchen', 1, 0, 'password_first', 'public', 900, 2592000,
       'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-kitchen');

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type, app_scheme,
   app_display_name, is_first_party, show_consent, auth_policy, subject_type,
   access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Display', 'vesopa-display',
       'Customer-facing displays.', 'native', 'vesopa-display',
       'Vesopa Display', 1, 0, 'password_first', 'public', 900, 2592000,
       'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-display');

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type, app_scheme,
   app_display_name, is_first_party, show_consent, auth_policy, subject_type,
   access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Express', 'vesopa-express',
       'Self-service kiosks customers order at.', 'native', 'vesopa-express',
       'Vesopa Express', 1, 0, 'password_first', 'public', 900, 2592000,
       'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-express');

-- ---------------------------------------------------------------------------
-- 3. How each may be signed in to
--
-- Copied from the till rather than invented: whatever the till offers is what a
-- machine standing beside it should offer, and a new app with NO method rows
-- would fall back to the global default and quietly offer more ways in than the
-- till does.
-- ---------------------------------------------------------------------------

INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT a.id, m.method, m.enabled, m.sort
  FROM applications a
  JOIN application_auth_methods m ON m.application_id = 1
 WHERE a.slug IN ('vesopa-kitchen', 'vesopa-display', 'vesopa-express')
   AND NOT EXISTS (
     SELECT 1 FROM application_auth_methods x
      WHERE x.application_id = a.id AND x.method = m.method);

-- ---------------------------------------------------------------------------
-- 4. Where each may send somebody back to
--
-- The loopback is how a desktop application receives the answer; port 0 means
-- "whatever port it managed to open", which is the documented native pattern
-- and the one the till already uses. The device callback carries the client id
-- because that is what tells auth which app a code belongs to.
-- ---------------------------------------------------------------------------

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT a.id, 'http://127.0.0.1:0/callback', 'login'
  FROM applications a
 WHERE a.slug IN ('vesopa-kitchen', 'vesopa-display', 'vesopa-express')
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = a.id AND r.uri = 'http://127.0.0.1:0/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT a.id,
       CONCAT('https://auth.vesopa.com/device/callback?client_id=', a.client_id),
       'login'
  FROM applications a
 WHERE a.slug IN ('vesopa-kitchen', 'vesopa-display', 'vesopa-express')
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = a.id AND r.uri LIKE 'https://auth.vesopa.com/device/callback%');

-- ---------------------------------------------------------------------------
-- 5. Vesopa does not ask a venue for permission to talk to Vesopa
--
-- Every one of these is first-party and every one was set to show a consent
-- screen. "One way in, worded Continue with Vesopa" is the rule, and a consent
-- prompt between two Vesopa products breaks it -- it also trains people to
-- click through consent screens, which is the habit that makes a real one
-- worthless.
-- ---------------------------------------------------------------------------

UPDATE applications SET show_consent = 0
 WHERE is_first_party = 1 AND show_consent <> 0;

-- ---------------------------------------------------------------------------
-- 6. A subscription belongs to the company, not to whoever bought it
--
-- All six hang off user 4 with organisation_id NULL, so nothing can answer
-- "what has this VENUE paid for" -- only "what did this person buy". The
-- back office needs the former.
-- ---------------------------------------------------------------------------

UPDATE subscriptions s
   JOIN users u ON u.id = s.user_id
   JOIN organisation_members om ON om.user_id = u.id AND om.role = 'owner'
    SET s.organisation_id = om.organisation_id
  WHERE s.organisation_id IS NULL;

-- ---------------------------------------------------------------------------
-- 7. The head of Vesopa holds every application
--
-- info@vesopasoftware.com (user 4) owns the organisation but was an explicit
-- developer on exactly one app, by accident of who happened to create it.
-- ---------------------------------------------------------------------------

INSERT INTO application_developers (application_id, user_id, role)
SELECT a.id, 4, 'admin'
  FROM applications a
 WHERE a.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM application_developers d
      WHERE d.application_id = a.id AND d.user_id = 4);

UPDATE applications SET created_by = 4 WHERE created_by IS NULL;
