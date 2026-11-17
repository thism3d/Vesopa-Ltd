-- go.vesopa.com/ai (2026-11-17): Vesopa AI in the browser, for a PC or a
-- laptop, signed in with Go's own Vesopa Auth client (PKCE). Its return
-- address is the page itself; the back office exchanges the code
-- (go_advisor.js /api/go/ai/web/exchange), never the browser.
--
-- Adds rows only; re-runnable.

SET @go := (SELECT id FROM applications WHERE slug = 'vesopa-go' AND deleted_at IS NULL LIMIT 1);

INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, 'https://go.vesopa.com/ai/', 'login' FROM DUAL WHERE @go IS NOT NULL;
INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, 'https://go.vesopaepos.com/ai/', 'login' FROM DUAL WHERE @go IS NOT NULL;

SELECT CONCAT('vesopa-go web Vesopa AI redirects=', COUNT(*)) FROM application_redirect_uris
 WHERE application_id = @go AND uri LIKE 'https://go.vesopa%/ai/';
