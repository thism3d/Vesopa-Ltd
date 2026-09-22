-- ---------------------------------------------------------------------------
-- Vesopa Gift, the shop: the client a BUYER signs in with.
--
-- WHAT IT IS FOR
--
-- gift.vesopaepos.com sells vouchers and tickets to members of the public.
-- Nobody has to sign in to buy. Somebody who does -- Continue with Vesopa on
-- the shop -- gets a page of everything bought with, or sent to, their address:
-- balances, tickets, resend, Add to Wallet. That is a member of the public
-- connecting their personal Vesopa account to a shop, and it is the loyalty
-- client's situation exactly, so this client is shaped like that one:
--
--   * a client of its own, not the console's (schema_017). The console's door
--     is shut -- allow_self_enroll 0 -- and its members are the owner and the
--     venues' managers. Buyers must never appear in that directory, hold its
--     roles, or open its door.
--   * allow_self_enroll ON: anyone with a Vesopa account, or who makes one, may
--     sign in. There is nothing to protect but their own purchases.
--   * show_consent ON: a personal account joined to a shop, asked properly.
--   * auth_policy code_first: buyers may never have set a password.
--
-- A confidential web client, like the console's: the shop has a server that
-- keeps the secret. Its secret is NOT here -- scripts/mint-client-secret.js
-- writes one on the server, and it goes into the shop's .env as
-- VESOPA_AUTH_SHOP_CLIENT_SECRET.
--
-- No roles: a buyer is a buyer.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @bo := (SELECT id FROM applications WHERE slug = 'vesopa-backoffice' LIMIT 1);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type,
   app_display_name, is_first_party, show_consent, allow_self_enroll,
   auth_policy, subject_type, access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa Gift Shop', 'vesopa-gift-shop',
       'Your vouchers and tickets from the venues you buy from.', 'web',
       'Vesopa Gift', 1, 1, 1, 'code_first', 'public', 900, 2592000, 'active', 4
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopa-gift-shop');

SET @shop := (SELECT id FROM applications WHERE slug = 'vesopa-gift-shop' LIMIT 1);

-- Open, and asked properly, even if somebody edited it by hand.
UPDATE applications SET allow_self_enroll = 1, show_consent = 1 WHERE id = @shop;

INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT @shop, m.method, m.enabled, m.sort
  FROM application_auth_methods m
 WHERE m.application_id = @bo
   AND @shop IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_auth_methods x
      WHERE x.application_id = @shop AND x.method = m.method);

INSERT INTO application_grants (application_id, grant_type)
SELECT @shop, g.grant_type
  FROM application_grants g
 WHERE g.application_id = @bo
   AND @shop IS NOT NULL AND @bo IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_grants x
      WHERE x.application_id = @shop AND x.grant_type = g.grant_type);

INSERT INTO application_scopes (application_id, scope_id)
SELECT @shop, s.scope_id
  FROM application_scopes s
 WHERE s.application_id = @bo
   AND @shop IS NOT NULL AND @bo IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_scopes x
      WHERE x.application_id = @shop AND x.scope_id = s.scope_id);

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @shop, 'https://gift.vesopaepos.com/account/callback', 'login'
 WHERE @shop IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @shop AND r.uri = 'https://gift.vesopaepos.com/account/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @shop, 'https://gift.vesopaepos.com/account/signed-out', 'logout'
 WHERE @shop IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @shop AND r.uri = 'https://gift.vesopaepos.com/account/signed-out');
