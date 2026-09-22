-- ---------------------------------------------------------------------------
-- loyalty.vesopa.com/admin signs in with Continue with Vesopa.
--
-- The loyalty website's editor (vesopa_server/src/loyalty_site.js) uses the
-- same public `vesopa-loyalty` client as the app, with PKCE, and comes back to
-- its own address. Only the addresses in LOYALTY_SITE_ADMINS on the back
-- office (info@vesopasoftware.com) are let in; anybody else who signs in is
-- turned away there.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @loyalty := (SELECT id FROM applications WHERE slug = 'vesopa-loyalty' LIMIT 1);

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @loyalty, 'https://loyalty.vesopa.com/admin/callback', 'login'
 WHERE @loyalty IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @loyalty
        AND r.uri = 'https://loyalty.vesopa.com/admin/callback');
