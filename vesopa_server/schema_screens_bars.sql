-- Screen programming, part two: the bars, and pictures on keys.
--
-- The till's two strips of chrome — the open-bills bar along the top and the
-- action bar along the bottom — become things a venue lays out for itself,
-- instead of two lists hard-coded in sale_page.dart.
--
-- No new tables. A bar *is* a screen: one or two rows of the same buttons the
-- sale grid is made of, told apart by `epos_screens.surface`, which has been
-- sitting there since the first migration waiting for precisely this:
--
--     -- Which till screen this lays out. Always 'sale' today.
--     surface VARCHAR(16) NOT NULL DEFAULT 'sale'
--
-- So 'topbar' and 'bottombar' cost no schema at all, and every piece of
-- machinery already built for screens — the editor, the whole-grid PUT, the
-- socket push, the tenancy scoping, the copy-a-screen route — works on them on
-- the day they exist. The unique key is already (office, surface, name), so a
-- venue may have a sale screen and a bottom bar both called "Main".
--
-- What this file *does* add is two pairs of columns.
--
-- On the button: an emoji and a picture. Until now the only way a key could
-- carry either was to be a product that had one, which meant a page key could
-- never be anything but a word — and the venue that photographed its menu
-- could not put its own picture on the FOOD key that leads to it.
--
-- On the screen: which bars it wants. NULL means "whatever the venue's default
-- is", which is the answer for nearly every screen; set, it lets one page carry
-- a different action bar from the rest. A Drinks page whose bottom bar offers
-- Round and Tab, where the food page offers Covers and Save Table, is a real
-- request and this is what it costs.
--
-- Where the venue's *defaults* live is a different question with a sharp
-- answer: on epos_till_settings, and therefore NOT in this file. See
-- schema_till_bars.sql for why putting them here would break every new venue
-- and no existing one.
--
-- Target is MySQL 5.7 / MariaDB, neither of which has ADD COLUMN IF NOT EXISTS,
-- so this goes through the same guard procedure the other migrations use and is
-- safe to run on every deploy.

DROP PROCEDURE IF EXISTS vesopa_add_screen_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_screen_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- A picture on a key.
--
-- Both nullable and both independent: a key may carry an emoji, a picture, or
-- neither, and when it carries neither a *product* key still falls back to the
-- product's own — which is what stops this feature quietly un-decorating every
-- screen a venue has already programmed.
--
-- image_url is 500 to match bo_products.image_url. It holds a path under
-- /uploads or /assets and nothing else; the server refuses anything off-site,
-- for the reason given on the idle image: a till on a venue's own network with
-- no route to the open internet must not be able to end up drawing a broken
-- frame across its sale screen.
-- ---------------------------------------------------------------------------
CALL vesopa_add_screen_column('epos_screen_buttons', 'emoji', 'VARCHAR(16) NULL');
CALL vesopa_add_screen_column('epos_screen_buttons', 'image_url', 'VARCHAR(500) NULL');

-- ---------------------------------------------------------------------------
-- Which bars this screen wants, when it does not want the venue's.
--
-- No foreign keys, and for the same reason home_screen_id has none: a bar
-- deleted in the back office must leave this pointing at nothing and the till
-- falling back to the default, rather than either refusing the delete or
-- silently cascading a page away. The read resolves it and treats "no such
-- screen" exactly like NULL — the same rule, in the same words, as §2 of
-- vesopa_epos/docs/screen-programming.md.
-- ---------------------------------------------------------------------------
CALL vesopa_add_screen_column('epos_screens', 'top_bar_id', 'INT NULL');
CALL vesopa_add_screen_column('epos_screens', 'bottom_bar_id', 'INT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_screen_column;
