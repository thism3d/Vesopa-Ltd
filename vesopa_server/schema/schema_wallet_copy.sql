-- What a venue writes on the back of its cards.
--
-- WHY THIS IS A SEPARATE FILE
--
-- schema_wallet.sql created epos_wallet_settings with what a card needs to
-- exist: the colours, the names, the artwork URLs. These eight columns are what
-- it needs to be *useful* — the sentences a customer reads when they turn the
-- card over, and the venue photo that goes behind the strip.
--
-- Every one is nullable with no default, and that is the rule the whole wallet
-- feature is built on: a venue that has filled nothing in still gets a working
-- card. `push()` in src/wallet_apple.js drops an empty value rather than drawing
-- an empty row, so an unfilled column is an absent field, not a blank one.
--
-- ON THE FILENAME
--
-- The design brief asked for this to sort after schema_wallet_venue.sql. It does
-- not — "copy" sorts before "venue" — and it does not need to. These columns go
-- on epos_wallet_settings, which schema_wallet.sql creates, and a full stop
-- sorts before an underscore, so schema_wallet.sql still runs first. That is the
-- only ordering this file actually depends on. The guarded procedure below is a
-- no-op if it ever stops being true, which is the failure this pattern exists to
-- make survivable.
--
-- Target is MySQL 5.7 / MariaDB. Every statement is guarded and safe to re-run.


DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- How the scheme works, in the venue's own words.
-- ---------------------------------------------------------------------------
-- These three are the questions staff are asked at the counter and cannot
-- answer without going to a screen: how do I earn, how do I spend, and what does
-- my tier get me. Putting them on the back of the card means the customer
-- already has the answer in their hand.
--
-- TEXT rather than VARCHAR because a venue will write a paragraph. Apple renders
-- a back field as wrapped text with no length limit worth enforcing here.
CALL vesopa_add_column('epos_wallet_settings', 'earning_text',   'TEXT NULL DEFAULT NULL');
CALL vesopa_add_column('epos_wallet_settings', 'redeeming_text', 'TEXT NULL DEFAULT NULL');
CALL vesopa_add_column('epos_wallet_settings', 'tier_text',      'TEXT NULL DEFAULT NULL');


-- ---------------------------------------------------------------------------
-- What to do when the scan fails.
-- ---------------------------------------------------------------------------
-- The one field on the card that is about the card itself.
--
-- A QR that will not read is the moment the whole feature looks broken — to the
-- customer, who is holding up a queue, and to the member of staff, who has no
-- idea the number under the barcode can simply be typed in. Both of them are
-- looking at the phone, so the instruction belongs on the phone.
--
-- src/wallet_apple.js supplies a sensible default when this is null, because a
-- venue that has not thought about it needs the answer more than one that has.
CALL vesopa_add_column('epos_wallet_settings', 'scanfail_text',  'TEXT NULL DEFAULT NULL');


-- ---------------------------------------------------------------------------
-- Where the venue is, and when it is open.
-- ---------------------------------------------------------------------------
-- Separate from `latitude`/`longitude`, which put the card on the lock screen as
-- somebody walks in. These are for the customer sitting at home deciding whether
-- to come at all, and a postcode is not derivable from a coordinate pair in a
-- form anybody wants to read.
--
-- VARCHAR rather than TEXT: both are one line on the card, and a venue that
-- pastes an essay into "Open" has made the card worse.
CALL vesopa_add_column('epos_wallet_settings', 'address_text', 'VARCHAR(255) NULL DEFAULT NULL');
CALL vesopa_add_column('epos_wallet_settings', 'hours_text',   'VARCHAR(255) NULL DEFAULT NULL');


-- ---------------------------------------------------------------------------
-- When points expire.
-- ---------------------------------------------------------------------------
-- Its own column rather than a line inside `terms`, because it is the single
-- term a customer is most likely to be angry about later. A balance that
-- silently expired is a complaint; one the card warned about is a policy.
CALL vesopa_add_column('epos_wallet_settings', 'expiry_text', 'TEXT NULL DEFAULT NULL');


-- ---------------------------------------------------------------------------
-- The venue's own photograph, behind the strip.
-- ---------------------------------------------------------------------------
-- Stored as a URL beside the other artwork columns, and deliberately NOT used by
-- the Apple half yet.
--
-- Google fetches artwork itself, so a URL is all it ever needs. Apple needs
-- *bytes at an exact pixel size*, and there is no image codec in this project —
-- the note in tools/wallet_art says as much. Until a photo can be resized
-- somewhere (the back office cropper already does this in a browser canvas, so
-- that is the likely home), this column feeds Google's heroImage and the back
-- office preview, and the Apple strip stays the generated artwork.
--
-- The column lands now because the alternative is a second migration on the day
-- the resize is solved, and this one is free.
CALL vesopa_add_column('epos_wallet_settings', 'photo_url', 'VARCHAR(512) NULL DEFAULT NULL');


DROP PROCEDURE IF EXISTS vesopa_add_column;
