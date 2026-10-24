-- ---------------------------------------------------------------------------
-- The vesopaepos.com customer account: Continue with Vesopa at /account.
--
-- vesopaepos.com/account is where a venue sees its Vesopa EPOS subscription,
-- invoices and hardware orders, and opens its back office (vesopa_web,
-- src/routes/shop.js). It also signs in by an emailed one-time link; this
-- client puts Continue with Vesopa beside it, so a customer uses the same
-- Vesopa account everywhere: website, back office and tills.
--
-- Shaped exactly like the Vesopa Software client area (schema_026):
-- confidential first-party 'web' client, allow_self_enroll ON (any Vesopa
-- account; the page only ever shows what belongs to that verified email),
-- show_consent OFF, auth_policy code_first. Sign-in methods, grants and scopes
-- are copied from the back office. The owner (2026-10-24): the application
-- belongs to info@vesopasoftware.com, so created_by is that account when it
-- exists.
--
-- The secret is minted with scripts/mint-client-secret.js vesopaepos-account
-- <file> into a 0600 file (tool/deploy_vesopaepos_account_connect.py).
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @bo := (SELECT id FROM applications WHERE slug = 'vesopa-backoffice' LIMIT 1);
SET @owner := COALESCE((SELECT user_id FROM user_identities WHERE type = 'email' AND LOWER(identifier) = 'info@vesopasoftware.com' AND revoked_at IS NULL LIMIT 1), 4);

INSERT INTO applications
  (organisation_id, client_id, name, slug, description, client_type,
   app_display_name, is_first_party, show_consent, allow_self_enroll,
   auth_policy, subject_type, access_token_ttl, refresh_token_ttl, status, created_by)
SELECT 1, REPLACE(UUID(), '-', ''), 'Vesopa EPOS customer account', 'vesopaepos-account',
       'Your Vesopa EPOS subscription, invoices and hardware orders, and the way into your back office.', 'web',
       'Vesopa EPOS', 1, 0, 1, 'code_first', 'public',
       COALESCE((SELECT access_token_ttl FROM applications WHERE id = @bo), 900),
       COALESCE((SELECT refresh_token_ttl FROM applications WHERE id = @bo), 2592000),
       'active', @owner
 WHERE NOT EXISTS (SELECT 1 FROM applications WHERE slug = 'vesopaepos-account');

SET @acct := (SELECT id FROM applications WHERE slug = 'vesopaepos-account' LIMIT 1);

-- Open to every Vesopa account, first-party, confidential, owned by
-- info@vesopasoftware.com.
UPDATE applications
   SET allow_self_enroll = 1, show_consent = 0, is_first_party = 1, client_type = 'web', created_by = @owner
 WHERE id = @acct;

INSERT INTO application_auth_methods (application_id, method, enabled, sort)
SELECT @acct, m.method, m.enabled, m.sort
  FROM application_auth_methods m
 WHERE m.application_id = @bo AND @acct IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_auth_methods x
                    WHERE x.application_id = @acct AND x.method = m.method);

INSERT INTO application_grants (application_id, grant_type)
SELECT @acct, g.grant_type
  FROM application_grants g
 WHERE g.application_id = @bo AND @acct IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_grants x
                    WHERE x.application_id = @acct AND x.grant_type = g.grant_type);

INSERT INTO application_scopes (application_id, scope_id)
SELECT @acct, s.scope_id
  FROM application_scopes s
 WHERE s.application_id = @bo AND @acct IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_scopes x
                    WHERE x.application_id = @acct AND x.scope_id = s.scope_id);

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @acct, 'https://vesopaepos.com/account/auth/vesopa/callback', 'login'
 WHERE @acct IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_redirect_uris r
                    WHERE r.application_id = @acct
                      AND r.uri = 'https://vesopaepos.com/account/auth/vesopa/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @acct, 'https://vesopaepos.com/account', 'logout'
 WHERE @acct IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_redirect_uris r
                    WHERE r.application_id = @acct
                      AND r.uri = 'https://vesopaepos.com/account');
