-- ---------------------------------------------------------------------------
-- Vesopa Gift: the client its staff console signs in with.
--
-- WHAT IT IS FOR
--
-- Vesopa Gift is the online voucher and ticket shop. Its console -- the owner's
-- list of venues, and each venue's orders, designs and events -- sits at
-- gift.vesopaepos.com/admin and signs in with Continue with Vesopa, like every
-- other Vesopa product. The shop itself signs nobody in: a buyer is a member of
-- the public with a card, not an account holder.
--
-- THE DOOR IS SHUT
--
-- allow_self_enroll is 0. Auth refuses to sign anybody into an application that
-- has it off unless they already hold a membership row, so the console is
-- closed to everybody who has not been invited -- other Vesopa staff included.
-- The owner decided the product stays hidden until he chooses who sees it, and
-- this column is the whole of that decision: no list to hide a link from, no
-- check to forget, because the sign-in itself turns people away.
--
-- ROLES, three of them, none given by default:
--
--   owner    every venue; switches a venue's shop on and off; decides who else
--            may come in
--   support  every venue; finds a voucher, resends it, refunds an order
--   venue    the venues the owner has named for this person, and nothing else
--
-- A confidential web client like the back office's own (application 13): the
-- console has a server that keeps the secret. Its grants, scopes and sign-in
-- methods are copied from the back office rather than retyped -- the thing
-- schema_014 forgot and schema_015 repaired.
--
-- The secret is NOT here. scripts/mint-client-secret.js makes one on the server
-- and writes it to a file only root can read; a secret in a migration would be
-- a secret in the repository.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @bo := (SELECT id FROM applications WHERE slug = 'vesopa-backoffice' LIMIT 1);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type,
   app_display_name, is_first_party, show_consent, allow_self_enroll,
   auth_policy, subject_type, access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Gift', 'vesopa-gift',
       'Vouchers and tickets sold on a venue''s own page, spent at the till.', 'web',
       'Vesopa Gift', 1, 0, 0, 'password_first', 'public', 900, 2592000, 'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-gift');

SET @gift := (SELECT id FROM applications WHERE slug = 'vesopa-gift' LIMIT 1);

-- The door stays shut even if somebody edited it open by hand: re-running this
-- file puts it back.
UPDATE applications SET allow_self_enroll = 0 WHERE id = @gift;

-- ---------------------------------------------------------------------------
-- How it may be signed in to, what it may do, what it may know
-- ---------------------------------------------------------------------------

INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT @gift, m.method, m.enabled, m.sort
  FROM application_auth_methods m
 WHERE m.application_id = @bo
   AND @gift IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_auth_methods x
      WHERE x.application_id = @gift AND x.method = m.method);

INSERT INTO application_grants (application_id, grant_type)
SELECT @gift, g.grant_type
  FROM application_grants g
 WHERE g.application_id = @bo
   AND @gift IS NOT NULL AND @bo IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_grants x
      WHERE x.application_id = @gift AND x.grant_type = g.grant_type);

INSERT INTO application_scopes (application_id, scope_id)
SELECT @gift, s.scope_id
  FROM application_scopes s
 WHERE s.application_id = @bo
   AND @gift IS NOT NULL AND @bo IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_scopes x
      WHERE x.application_id = @gift AND x.scope_id = s.scope_id);

-- ---------------------------------------------------------------------------
-- The three roles
-- ---------------------------------------------------------------------------

INSERT INTO application_roles (application_id, role_key, name, description, is_default)
SELECT @gift, r.role_key, r.name, r.description, 0
  FROM (
    SELECT 'owner' AS role_key, 'Owner' AS name,
           'Every venue. Switches shops on and off, and decides who else comes in.' AS description
    UNION ALL
    SELECT 'support', 'Support',
           'Every venue. Finds a voucher, resends it, refunds an order.'
    UNION ALL
    SELECT 'venue', 'Venue manager',
           'Only the venues the owner has named for them.'
  ) r
 WHERE @gift IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_roles x
      WHERE x.application_id = @gift AND x.role_key = r.role_key);

-- ---------------------------------------------------------------------------
-- Where it may send somebody back to
-- ---------------------------------------------------------------------------

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @gift, 'https://gift.vesopaepos.com/admin/callback', 'login'
 WHERE @gift IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @gift AND r.uri = 'https://gift.vesopaepos.com/admin/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @gift, 'https://gift.vesopaepos.com/admin', 'logout'
 WHERE @gift IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @gift AND r.uri = 'https://gift.vesopaepos.com/admin');

-- ---------------------------------------------------------------------------
-- The first two people
--
-- The owner, whose product it is, with the owner role. And the one account
-- every Vesopa test is run as -- manager@vesopa.co.uk -- as a venue manager,
-- so the console can be tested end to end without anybody signing in as the
-- owner. Found by their email identity, never by a user id typed in here.
-- ---------------------------------------------------------------------------

INSERT INTO application_members (application_id, user_id, status)
SELECT @gift, i.user_id, 'active'
  FROM user_identities i
 WHERE i.type = 'email'
   AND i.identifier_norm IN ('info@vesopasoftware.com', 'manager@vesopa.co.uk')
   AND i.revoked_at IS NULL
   AND @gift IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_members m
      WHERE m.application_id = @gift AND m.user_id = i.user_id);

INSERT INTO application_member_roles (member_id, role_id)
SELECT m.id, r.id
  FROM application_members m
  JOIN user_identities i ON i.user_id = m.user_id AND i.type = 'email' AND i.revoked_at IS NULL
  JOIN application_roles r ON r.application_id = m.application_id
 WHERE m.application_id = @gift
   AND ((i.identifier_norm = 'info@vesopasoftware.com' AND r.role_key = 'owner')
     OR (i.identifier_norm = 'manager@vesopa.co.uk' AND r.role_key = 'venue'))
   AND NOT EXISTS (
     SELECT 1 FROM application_member_roles x
      WHERE x.member_id = m.id AND x.role_id = r.id);
