-- Vesopa Kitchen: white-label branding for the screen itself.
--
-- The venue already has a branding row — `epos_branding`, created by
-- schema_branding.sql — and this extends it rather than starting a second one.
-- One row per office is already the right shape, and a venue that has set its
-- logo once should not have to find a different page to set it again.
--
-- These are *separate columns* from the receipt's `venue_name` / `logo_url`
-- rather than a reuse of them, which is the whole point of the file. A kitchen
-- screen and a printed receipt are read by different people for different
-- reasons: a reseller white-labelling the screen above a pass must not silently
-- restyle every VAT receipt the venue hands a customer. Where a kitchen column
-- is left empty the app falls back to the receipt's value, and then to the
-- built-in Vesopa mark — so a venue that sets nothing sees exactly what it sees
-- today, and one that sets only a logo keeps its own name.
--
-- Applied after schema_branding.sql, which `sort` guarantees: 'b' < 'k'. That
-- ordering is not incidental — see the migration-rename note in
-- vesopa_epos_kitchen/docs/architecture.md for what happens when it is got
-- wrong.
--
-- Target is MySQL 5.7 / MariaDB, which has no `ADD COLUMN IF NOT EXISTS`, so
-- the additions go through a guard procedure that checks information_schema
-- first. That keeps this file safe for deploy.sh to re-run on every deploy.

DROP PROCEDURE IF EXISTS vesopa_add_kitchen_branding_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_kitchen_branding_column(
  IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'epos_branding'
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `epos_branding` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- The branding row may not exist at all for a venue that has never opened the
-- receipt designer. Nothing here creates one: the kitchen read falls back all
-- the way to the built-in mark when the row is missing, and inventing an empty
-- row per office would put a write in a read path for no gain.

-- Whether the animated start screen is shown at all.
--
-- On by default because a venue that has branded its screen wants to see it,
-- and off is one toggle away for the kitchen that would rather have the board a
-- second sooner. The splash never delays the board's *fetch* — see
-- ui/splash_screen.dart — so this is a presentation choice, not a speed one.
CALL vesopa_add_kitchen_branding_column(
  'kitchen_splash_enabled', "TINYINT(1) NOT NULL DEFAULT 1");

-- How long the start screen holds once its animation has finished, in
-- milliseconds. Clamped hard at both ends by the server (see src/kitchen.js):
-- a reseller who types 60000 into this box has taken a kitchen off the air for
-- a minute on every restart, which is not a branding decision they should be
-- able to make by accident.
CALL vesopa_add_kitchen_branding_column(
  'kitchen_splash_ms', "SMALLINT UNSIGNED NOT NULL DEFAULT 1800");

-- What the screen calls itself. Empty falls back to "Vesopa Kitchen".
CALL vesopa_add_kitchen_branding_column(
  'kitchen_app_name', "VARCHAR(40) NOT NULL DEFAULT ''");

-- The line under it. Empty falls back to the venue's trading name, and then to
-- nothing — a start screen with a logo and a name on it is already complete.
CALL vesopa_add_kitchen_branding_column(
  'kitchen_tagline', "VARCHAR(80) NOT NULL DEFAULT ''");

-- The mark. Empty falls back to `logo_url` (the venue's receipt logo) and then
-- to the bundled Vesopa Kitchen mark.
CALL vesopa_add_kitchen_branding_column(
  'kitchen_logo_url', "VARCHAR(255) NULL");

-- Two colours, as `#RRGGBB`. Empty falls back to the built-in palette in
-- ui/theme.dart. Validated server-side rather than trusted: this string is
-- parsed by every screen in the venue and a malformed one must not be able to
-- leave a kitchen looking at a crash instead of a board.
CALL vesopa_add_kitchen_branding_column(
  'kitchen_splash_bg', "VARCHAR(7) NOT NULL DEFAULT ''");
CALL vesopa_add_kitchen_branding_column(
  'kitchen_accent', "VARCHAR(7) NOT NULL DEFAULT ''");

-- Whether "Powered by Vesopa" sits at the foot of the start screen. On by
-- default; a reseller licensed to remove it turns it off here.
CALL vesopa_add_kitchen_branding_column(
  'kitchen_show_powered_by', "TINYINT(1) NOT NULL DEFAULT 1");

DROP PROCEDURE IF EXISTS vesopa_add_kitchen_branding_column;
