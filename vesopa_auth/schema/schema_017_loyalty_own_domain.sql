-- ---------------------------------------------------------------------------
-- The loyalty app is moving to its own domain: loyalty.vesopa.com
--
-- WHY IT NEEDS A MIGRATION OF ITS OWN
--
-- A redirect URI that is not registered is refused with `invalid_redirect_uri`,
-- and the refusal happens at auth.vesopa.com before the app is ever reached --
-- so there is nothing in the app to explain it and nothing in its log to find.
-- Registering the new address BEFORE the DNS record exists costs nothing and
-- means the move is a DNS change rather than a DNS change plus an outage.
--
-- BOTH HOSTS STAY REGISTERED. menu.vesopaepos.com is where every venue's app is
-- served today and where any link already printed on a table card points. They
-- can be retired together, once nothing answers on the old one.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @loyalty := (SELECT id FROM applications WHERE slug = 'vesopa-loyalty' LIMIT 1);

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @loyalty, 'https://loyalty.vesopa.com/app/vesopa/callback', 'login'
 WHERE @loyalty IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @loyalty
        AND r.uri = 'https://loyalty.vesopa.com/app/vesopa/callback');

INSERT INTO application_redirect_uris (application_id, uri, kind)
SELECT @loyalty, 'https://loyalty.vesopa.com/app/vesopa/signed-out', 'logout'
 WHERE @loyalty IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM application_redirect_uris r
      WHERE r.application_id = @loyalty
        AND r.uri = 'https://loyalty.vesopa.com/app/vesopa/signed-out');
