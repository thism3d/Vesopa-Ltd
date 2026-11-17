-- go.vesopa.com/signup (2026-11-17): a venue signs up for Vesopa Go in the
-- browser with Go's own Vesopa Auth client (PKCE). Its return address is the
-- sign-up page; the back office exchanges the code (go_onboarding.js), so
-- the browser never calls the token endpoint itself.
--
-- Adds rows only; re-runnable.

SET @go := (SELECT id FROM applications WHERE slug = 'vesopa-go' AND deleted_at IS NULL LIMIT 1);

INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, 'https://go.vesopa.com/signup/', 'login' FROM DUAL WHERE @go IS NOT NULL;
INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, 'https://go.vesopaepos.com/signup/', 'login' FROM DUAL WHERE @go IS NOT NULL;

SELECT CONCAT('vesopa-go web sign-up redirects=', COUNT(*)) FROM application_redirect_uris
 WHERE application_id = @go AND uri LIKE 'https://go.vesopa%/signup/';
