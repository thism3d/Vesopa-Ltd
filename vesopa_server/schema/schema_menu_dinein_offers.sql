-- ===========================================================================
-- Dine-in: offers, promotions, popular items, branding, drafts and domains.
-- ===========================================================================
--
-- SORT ORDER. This alters `dinein_venue` and `dinein_items`, which
-- `schema_menu_dinein.sql` creates. Sorted names:
--
--     schema_menu_dinein.sql          (".", 0x2E)
--     schema_menu_dinein_hours.sql    ("_h")
--     schema_menu_dinein_offers.sql   ("_o")
--
-- so this runs last of the three, which is what it needs. Renaming any of them
-- without re-checking that is how the columns silently never appear — the
-- deploy loop swallows a failure as "(skipped: already applied or not needed)".
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
-- The offer
-- ---------------------------------------------------------------------------
--
-- One offer per venue: a percentage off the whole order once it reaches a
-- minimum spend. That is the shape every delivery app has converged on, and it
-- is the one a customer can work out in their head while holding a phone.
--
-- The percentage is stored, never the discounted prices. Prices come from the
-- catalogue at read time — see the note in dinein.js — and storing a second,
-- already-discounted number is how a menu ends up quoting a price the till has
-- never heard of.
CALL vesopa_add_column('dinein_venue', 'offer_active', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('dinein_venue', 'offer_percent', 'INT NOT NULL DEFAULT 0');
CALL vesopa_add_column('dinein_venue', 'offer_min_spend_minor', 'INT NOT NULL DEFAULT 0');

-- What the venue calls it, if it wants to call it something. Empty means the
-- page writes the sentence itself from the two numbers above, which is what
-- almost every venue will want and none of them should have to type.
CALL vesopa_add_column('dinein_venue', 'offer_label', 'VARCHAR(120) NULL');

-- ---------------------------------------------------------------------------
-- Promotions
-- ---------------------------------------------------------------------------
--
-- Deliberately a different thing from the offer above. An offer changes what
-- somebody pays; a promotion is something a venue wants to say — a quiz night,
-- a new supplier, a Sunday roast that has to be booked. Modelling the two as
-- one thing means either promotions that silently discount or offers nobody
-- can describe.
--
-- Held as JSON on the venue row rather than as a table for the same reason the
-- opening hours are: read on every page load, written whole by one form, and
-- there is no query that wants "every promotion across all venues".
--
-- Shape: [{ "title": "", "body": "", "image_url": "", "until": "YYYY-MM-DD" }]
CALL vesopa_add_column('dinein_venue', 'promotions', 'TEXT NULL');

-- ---------------------------------------------------------------------------
-- Branding
-- ---------------------------------------------------------------------------
--
-- accent_colour already exists and is the one colour the page took. A venue
-- whose brand is navy and cream got a lime button on a white card, which is
-- Vesopa's brand on somebody else's menu.
--
-- The whole palette is here as JSON so that adding a colour later does not mean
-- another migration, and so the whole thing can be previewed and thrown away
-- without touching the columns the live page reads.
--
-- Shape: { "accent": "#…", "onAccent": "#…", "page": "#…", "card": "#…",
--          "ink": "#…", "inkSoft": "#…", "radius": 16, "font": "system" }
CALL vesopa_add_column('dinein_venue', 'theme_json', 'TEXT NULL');

-- ---------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------
--
-- Everything above, as it was last saved without being published.
--
-- A separate column rather than a flag on the live row, because the live row is
-- what a customer standing at a table is reading right now. A venue trying a
-- new colour at four in the afternoon must not be able to publish it by
-- accident, and must be able to come back to it tomorrow.
CALL vesopa_add_column('dinein_venue', 'draft_json', 'TEXT NULL');
CALL vesopa_add_column('dinein_venue', 'draft_saved_at', 'DATETIME NULL');

-- ---------------------------------------------------------------------------
-- The venue's own domain
-- ---------------------------------------------------------------------------
--
-- A venue that owns menu.theirpub.co.uk can point it here and print that on
-- their cards instead of ours.
--
-- Stored lower case and without a scheme or a path — it is matched against the
-- Host header, which carries neither. Unique across the platform: two venues
-- claiming one hostname is a customer reading the wrong menu, so the database
-- refuses it rather than the application remembering to.
CALL vesopa_add_column('dinein_venue', 'custom_domain', 'VARCHAR(190) NULL');

-- Whether we have seen that hostname actually arrive at this server. Until it
-- has, links and printed cards keep using the Vesopa address — a card printed
-- against a domain whose DNS was never pointed here is a table that cannot
-- order.
CALL vesopa_add_column('dinein_venue', 'domain_verified', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL vesopa_add_column('dinein_venue', 'domain_checked_at', 'DATETIME NULL');

-- ---------------------------------------------------------------------------
-- Popular items
-- ---------------------------------------------------------------------------
--
-- Set by the venue, not counted from orders. A venue knows what it wants to
-- sell, and a "most ordered" list computed from a menu that has been live for a
-- week is a list of whatever was at the top of it.
CALL vesopa_add_column('dinein_items', 'is_popular', 'TINYINT(1) NOT NULL DEFAULT 0');

-- What a customer is told about a dish beyond its description: vegetarian,
-- vegan, spicy. One short string, because a tag list is a taxonomy and this is
-- a menu.
CALL vesopa_add_column('dinein_items', 'diet_tag', 'VARCHAR(24) NULL');

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN t VARCHAR(64), IN i VARCHAR(64), IN spec VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND INDEX_NAME = i
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', t, '` ADD ', spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- Unique, and nullable: any number of venues may have no custom domain, and
-- MySQL lets any number of rows hold NULL in a unique index. Exactly the
-- behaviour wanted, and the same reason `slug` is nullable.
CALL vesopa_add_index(
  'dinein_venue', 'uq_dinein_domain', 'UNIQUE KEY `uq_dinein_domain` (custom_domain)'
);
CALL vesopa_add_index(
  'dinein_items', 'idx_dinein_items_popular', 'INDEX `idx_dinein_items_popular` (office_id, is_popular)'
);

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
