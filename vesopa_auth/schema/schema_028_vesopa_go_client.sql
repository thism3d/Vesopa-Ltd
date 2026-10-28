-- Vesopa Go, the phone app for Vesopa EPOS venues (vesopa_go/), as an
-- application of its own (2026-10-27).
--
-- A copy of the till's native "Vesopa EPOS" client, because a Go phone signs in
-- the way a till does (Continue with Vesopa, PKCE, a loopback redirect) and is
-- commissioned as one of the venue's tills. Its own client id lets the back
-- office tell a Go phone from a till (terminal_vesopa.js, VESOPA_AUTH_GO_CLIENT_ID),
-- and the sign-in page names the right app.
--
-- Copied, not typed out: every column the till's client has (including ones
-- later migrations added) comes across, then the few that make it Go's own are
-- set. The sector salt is kept, so a person has the same pairwise subject in Go
-- as in the till. Its redirect URIs, grants and scopes are copied too.
--
-- Re-runnable: nothing happens once slug vesopa-go exists. Adds rows only;
-- changes and deletes nothing. Ends by printing Go's client id.

SET @epos := (SELECT id FROM applications WHERE name = 'Vesopa EPOS' AND client_type = 'native' AND deleted_at IS NULL ORDER BY id LIMIT 1);
SET @have := (SELECT id FROM applications WHERE slug = 'vesopa-go' LIMIT 1);

DROP TEMPORARY TABLE IF EXISTS go_app;
CREATE TEMPORARY TABLE go_app AS SELECT * FROM applications WHERE id = @epos AND @have IS NULL;
UPDATE go_app SET
  id = 0,
  client_id = REPLACE(UUID(), '-', ''),
  name = 'Vesopa Go',
  slug = 'vesopa-go',
  description = 'Take orders and payments anywhere, at the counter or the table, for Vesopa EPOS venues.',
  created_at = NOW(),
  updated_at = NOW();
INSERT INTO applications SELECT * FROM go_app;
SET @go := COALESCE(@have, (SELECT id FROM applications WHERE slug = 'vesopa-go' LIMIT 1));
DROP TEMPORARY TABLE IF EXISTS go_app;

INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, uri, kind FROM application_redirect_uris WHERE application_id = @epos AND @go IS NOT NULL;
-- iPhone and iPad sign in with Apple's own sheet, answering on Go's own
-- address (2026-10-28): the loopback port stalled in Safari's in-app view.
INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
  SELECT @go, 'com.vesopa.go:/oauth/callback', 'login' FROM DUAL WHERE @go IS NOT NULL;
INSERT IGNORE INTO application_grants (application_id, grant_type)
  SELECT @go, grant_type FROM application_grants WHERE application_id = @epos AND @go IS NOT NULL;
INSERT IGNORE INTO application_scopes (application_id, scope_id)
  SELECT @go, scope_id FROM application_scopes WHERE application_id = @epos AND @go IS NOT NULL;

SELECT CONCAT('vesopa-go client_id=', client_id) FROM applications WHERE id = @go;
