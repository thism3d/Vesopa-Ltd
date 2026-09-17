-- ---------------------------------------------------------------------------
-- menu.vesopaepos.com moved to menu.vesopa.com; gift.vesopaepos.com moved to
-- gift.vesopa.com (2026-09-17). Every callback those hosts used is registered
-- again on the new name. The old ones are KEPT: a sign-in begun on the old
-- address a minute before the move still comes back to it, and the old host
-- 301s onward — so both must be acceptable until the old names are retired.
--
--   vesopa-menu      the QR menu's Continue with Vesopa (dine-in)
--   vesopa-loyalty   the menu website's editor at menu.vesopa.com/admin, which
--                    borrows the loyalty client with PKCE, as loyalty.vesopa.com
--                    does (schema_022)
--   vesopa-gift      the gift console
--   vesopa-gift-shop the gift shop's buyer sign-in
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

-- The columns are utf8mb4_general_ci while the database default is unicode_ci;
-- the procedure's parameters must say general_ci themselves
-- too, or MariaDB refuses the comparison as an illegal mix of collations.
SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

DROP PROCEDURE IF EXISTS vesopa_add_redirect;
DELIMITER //
CREATE PROCEDURE vesopa_add_redirect(IN p_slug VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, IN p_uri VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, IN p_kind VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci)
BEGIN
  DECLARE v_app INT UNSIGNED;
  SET v_app := (SELECT id FROM applications WHERE slug = p_slug LIMIT 1);
  IF v_app IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM application_redirect_uris WHERE application_id = v_app AND uri = p_uri) THEN
    INSERT INTO application_redirect_uris (application_id, uri, kind) VALUES (v_app, p_uri, p_kind);
  END IF;
END //
DELIMITER ;

CALL vesopa_add_redirect('vesopa-menu',      'https://menu.vesopa.com/auth/callback',        'login');
CALL vesopa_add_redirect('vesopa-menu',      'https://menu.vesopa.com/',                     'logout');
CALL vesopa_add_redirect('vesopa-loyalty',   'https://menu.vesopa.com/admin/callback',       'login');
CALL vesopa_add_redirect('vesopa-gift',      'https://gift.vesopa.com/admin/callback',       'login');
CALL vesopa_add_redirect('vesopa-gift',      'https://gift.vesopa.com/admin',                'logout');
CALL vesopa_add_redirect('vesopa-gift-shop', 'https://gift.vesopa.com/account/callback',     'login');
CALL vesopa_add_redirect('vesopa-gift-shop', 'https://gift.vesopa.com/account/signed-out',   'logout');

DROP PROCEDURE IF EXISTS vesopa_add_redirect;
