-- ===========================================================================
-- Dine-in: add-ons on a QR order line, what to do when an item is off, and
-- the SEO tags a venue writes for itself.
-- ===========================================================================
--
-- SORT ORDER. This alters `dinein_venue` and `dinein_order_lines`, which
-- `schema_menu_dinein.sql` creates. Sorted names:
--
--     schema_menu_dinein.sql            (".", 0x2E)
--     schema_menu_dinein_hours.sql      ("_h")
--     schema_menu_dinein_offers.sql     ("_o" then "f")
--     schema_menu_dinein_ordering.sql   ("_o" then "r")   <- this file
--     schema_menu_dinein_otp.sql        ("_o" then "t")
--
-- so it runs after the file that creates the tables, which is all it needs.
-- Renaming any of them without re-checking that is how the columns silently
-- never appear — the deploy loop swallows a failure as "(skipped: already
-- applied or not needed)".
--
-- RE-RUNNABLE. Every deploy replays every file here.
-- ===========================================================================

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN t VARCHAR(64), IN c VARCHAR(64), IN spec VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD COLUMN `', c, '` ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- An add-on on a QR order line
-- ---------------------------------------------------------------------------
--
-- The same shape the till has used since modifiers went in: an answer is a
-- real order line pointing at the line it belongs to. That is what makes it
-- price, carry VAT, print and report as what it actually is, and it is why the
-- receipt, the kitchen ticket and the customer display already draw it
-- indented — every one of them keys off "does this line name a parent".
--
-- So a QR order carries add-ons the same way rather than inventing a second
-- shape. A menu that modelled them as text on the parent line would be a
-- kitchen ticket that cannot tell "no ice" from the drink's name.
--
-- No foreign key, matching `epos_order_lines`: a parent removed by a manager
-- must leave a line that reads oddly, not a delete that fails.
CALL vesopa_add_column('dinein_order_lines', 'parent_line_id', 'INT NULL');
CALL vesopa_add_column('dinein_order_lines', 'is_modifier',
                       'TINYINT(1) NOT NULL DEFAULT 0');

-- ---------------------------------------------------------------------------
-- What to do if the kitchen cannot make it
-- ---------------------------------------------------------------------------
--
-- Per line, not per order: a customer who would happily lose the side but
-- wants a call about the main course is the ordinary case, and one answer for
-- the whole basket cannot express it.
--
-- 'remove' is the default because it is the answer that needs no one to be
-- reachable. A customer who has walked away from their phone still gets the
-- rest of their food, and the venue is not holding a ticket waiting for a
-- call nobody will answer.
--
--   remove   take it off, make the rest
--   call     ring the customer before making anything
--   refund   make the rest, refund the difference
--
-- VARCHAR and not ENUM: a fourth answer should cost a value, not a migration
-- that rewrites the table while a venue is trading.
CALL vesopa_add_column('dinein_order_lines', 'unavailable_action',
                       "VARCHAR(16) NOT NULL DEFAULT 'remove'");

-- ---------------------------------------------------------------------------
-- The tags a venue's menu page presents itself with
-- ---------------------------------------------------------------------------
--
-- The page already emits description, canonical, og: and twitter: tags — they
-- are not missing, they are *derived*: the description is the venue's tagline
-- and the image is whatever banner happens to be set. That is a reasonable
-- default and a poor answer for a venue that wants its menu to read properly
-- when somebody pastes the link into WhatsApp.
--
-- NULL means "carry on deriving it", so a venue that never opens these fields
-- sees no change at all. Only a value typed here overrides.
CALL vesopa_add_column('dinein_venue', 'meta_title', 'VARCHAR(255) NULL');
CALL vesopa_add_column('dinein_venue', 'meta_description', 'VARCHAR(500) NULL');
CALL vesopa_add_column('dinein_venue', 'meta_image_url', 'VARCHAR(500) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
