-- ===========================================================================
-- Allergens: the fourteen a UK venue is required to declare.
-- ===========================================================================
--
-- Nothing in Vesopa has ever carried an allergen. A venue serving food in the
-- UK has to be able to say what is in it, and a member of staff asked "does
-- this have nuts in it" at a counter should not be reading the answer off a
-- laminated sheet under the till.
--
-- SORT ORDER. This alters three tables created in three different places:
--
--     bo_products                 the original database (backup/Backup_v1.0.0)
--     epos_kitchen_ticket_lines   schema_kitchen.sql          ("k")
--     dinein_items                schema_menu_dinein.sql      ("m")
--
-- so the file has to sort after BOTH of the last two. "schema_product_…" ("p")
-- does, and sits with the other late product columns — schema_product_media,
-- schema_product_printing, schema_product_modifier_flag. A name starting
-- "schema_kitchen_…" would NOT: it would run before dinein_items existed, and
-- the deploy loop swallows that as "(skipped)".
--
-- WHY A LIST OF CODES AND NOT FREE TEXT
--
-- Free text cannot be searched, cannot be translated, and cannot be shown as a
-- consistent chip on four different screens. The fourteen are fixed by law
-- (Food Information Regulations 2014), so the set does not drift, and a code
-- means the same thing in the back office, on the menu, on the kitchen ticket
-- and on the customer display. The labels live in src/allergens.js — one
-- module, so no app hardcodes its own spelling of "Cereals containing gluten".
--
-- TEXT and not JSON: MariaDB's JSON is an alias for LONGTEXT with a check
-- constraint, and dinein_venue.theme_json already stores JSON as TEXT here.
-- Matching that keeps one convention rather than two.
--
-- NULL vs '[]' — the distinction carries weight
--
--   NULL   nobody has said. On dinein_items this means "inherit whatever the
--          linked product declares", so a venue fills the catalogue in once.
--   '[]'   somebody has looked and this contains none of the fourteen. That is
--          an answer, and it must not be confused with an unanswered question.
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

-- The catalogue's answer. This is the one a venue maintains.
CALL vesopa_add_column('bo_products', 'allergens', 'TEXT NULL');

-- The menu's override, for the rare item whose menu entry differs from the
-- catalogue row it points at. NULL inherits.
CALL vesopa_add_column('dinein_items', 'allergens', 'TEXT NULL');

-- A snapshot, taken when the ticket is written.
--
-- Deliberately copied rather than joined. A kitchen board runs on its own
-- device, on a venue's own network, and has to keep working when the line is
-- down — and more than that, a ticket is a record of what was sent to the
-- kitchen at the time. A product edited at four o'clock must not silently
-- rewrite what the two o'clock ticket said.
CALL vesopa_add_column('epos_kitchen_ticket_lines', 'allergens', 'TEXT NULL');

DROP PROCEDURE IF EXISTS vesopa_add_column;
