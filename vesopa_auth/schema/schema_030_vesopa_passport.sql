-- passport.vesopa.com (2026-11-26): Vesopa Passport, where an owner opens
-- their Vesopa account and verifies their identity (owner: "only verification
-- and account opening goes there"). It signs in with Go's own Vesopa Auth
-- client (PKCE), as go.vesopa.com/signup does; its return address is /flow,
-- which is also Stripe Identity's return URL.
--
-- Adds rows only; re-runnable.

SET @go := (SELECT id FROM applications WHERE slug = 'vesopa-go' AND deleted_at IS NULL LIMIT 1);

INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, 'https://passport.vesopa.com/flow/', 'login' FROM DUAL WHERE @go IS NOT NULL;
INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, 'https://passport.vesopa.com/flow', 'login' FROM DUAL WHERE @go IS NOT NULL;

SELECT CONCAT('vesopa-go passport redirects=', COUNT(*)) FROM application_redirect_uris
 WHERE application_id = @go AND uri LIKE 'https://passport.vesopa.com/flow%';
