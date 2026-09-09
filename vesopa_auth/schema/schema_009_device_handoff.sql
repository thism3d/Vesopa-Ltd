-- ---------------------------------------------------------------------------
-- How a desktop application gets its code back.
--
-- THE FLOW THE OWNER DESCRIBED, which is the one everybody already knows from
-- signing in to VS Code with Google:
--
--   the app shows "Continue with Vesopa" and opens the system browser
--   the browser shows the account chooser and the consent screen
--   it lands on a page ON THIS DOMAIN that says it worked
--   the operating system asks "Open Vesopa EPOS?" and the app takes over
--   remove the link later and the app finds itself signed out and asks again
--
-- Two things had to exist for that, and this file adds the second.
--
-- RFC 8252 loopback (`http://127.0.0.1:<port>/callback`) already worked and is
-- still the safer of the two — the code is delivered to a port only that
-- process is listening on. Its weakness is presentational: the browser is left
-- sitting on a bare page served by a local process, on an `http://` address,
-- which looks broken to anybody who reads their address bar.
--
-- The handoff page fixes that, and its own weakness is worth writing down
-- rather than discovering: A CUSTOM SCHEME CAN BE CLAIMED BY ANY APPLICATION ON
-- THE MACHINE. Whoever registers `vesopa-epos://` receives the code. That is
-- survivable only because PKCE is mandatory here: the code is worthless without
-- the verifier, which never leaves the process that started the sign-in. An
-- imposter gets a code it cannot spend. Without PKCE this design would be an
-- account takeover, which is exactly why the authorize endpoint refuses a
-- client that does not send a challenge.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_ddl    TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_column)
  THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_ddl);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- applications.app_scheme — what the handoff page hands off TO.
--
-- `vesopa-epos`, without the `://`. Stored per application because two Vesopa
-- desktop products on one machine must not answer each other's sign-ins.
--
-- Empty means this application does not use the handoff page, and the page
-- refuses rather than guessing — a default scheme would be a default target for
-- somebody else's authorisation code.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('applications', 'app_scheme',
  "VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER client_type");

-- ---------------------------------------------------------------------------
-- applications.app_name_for_dialog — what the operating system's prompt says.
--
-- The browser asks "Open <something>?" using the registered handler's name, and
-- the page beside it should say the same words. A page that says "Vesopa EPOS"
-- next to a dialog that says "vesopaepos.exe" is a page people cancel.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('applications', 'app_display_name',
  "VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER app_scheme");


-- ---------------------------------------------------------------------------
-- The till gets the scheme and the handoff address.
--
-- Registered as an ordinary redirect URI, because that is exactly what it is —
-- exact-string matched like every other, with no special case in the matching
-- code. The loopback entry stays: the app may use either, and an older build
-- that only knows loopback keeps working through the whole soak.
-- ---------------------------------------------------------------------------
UPDATE applications
   SET app_scheme = 'vesopa-epos',
       app_display_name = 'Vesopa EPOS'
 WHERE slug = 'vesopa-epos' AND app_scheme = '';

-- The client id is IN the registered URI, and that is deliberate.
--
-- The handoff page has to know which application it is handing back to, and
-- the authorisation code does not say. The alternatives were reading it out of
-- `state` (which is the app's own opaque value and none of our business) or
-- special-casing our own domain inside the redirect matcher (which is the one
-- piece of code that should have no special cases at all).
--
-- Putting it in the registered URI needs neither. Matching stays exact string
-- equality — the app sends this URI character for character, including the
-- query — and the page reads a parameter that was registered by an
-- administrator rather than supplied by whoever opened the link.
INSERT IGNORE INTO application_redirect_uris (application_id, uri, kind)
SELECT id, CONCAT('https://auth.vesopa.com/device/callback?client_id=', client_id), 'login'
  FROM applications WHERE slug = 'vesopa-epos';
