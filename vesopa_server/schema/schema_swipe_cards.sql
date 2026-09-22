-- Magnetic swipe cards: staff, loyalty and gift.
--
-- WHAT A VENUE ACTUALLY HAS
--
-- A magnetic stripe reader on the counter, wired to the till and behaving as a
-- keyboard. Swipe a card and it *types*:
--
--     ;999800001?
--
-- A start sentinel, four digits of prefix, a member number, an end sentinel.
-- That is ISO 7811 track 2, and the prefix is the whole trick: it is what tells
-- the till which of three programmes the card belongs to before it looks
-- anything up. Swipe a staff card and somebody signs on; swipe a loyalty card
-- and the member is put on the bill; swipe a gift card and its balance comes
-- up.
--
-- THE NUMBERS BELOW ARE NOT INVENTED
--
-- They are the ones this venue already programmes its cards with, copied from
-- their current system so that every card in every wallet in the town keeps
-- working on the day they switch:
--
--     Clerk (staff)  9999
--     Loyalty        9998
--     Gift           9878
--
-- Their existing system also has a Dallas Key prefix. They do not use it and
-- asked for it to be left out, so there is no column for it. A column for a
-- thing nobody uses is a question every venue after them has to answer.
--
-- Every one of them is editable, because a venue coming from another system
-- arrives with its own cards already programmed and cannot reprogramme them.
--
-- WHY THIS IS A VENUE SETTING AND NOT A TERMINAL ONE
--
-- Cards are programmed once, for the venue, and then carried around in
-- customers' wallets. Two tills in one room that disagreed about what 9998
-- means would be two tills where the same card does different things depending
-- on which end of the bar somebody is standing at -- and the one that is wrong
-- would fail silently, by finding no member and offering to enrol a customer
-- who has been a member for three years.
--
-- The *reader* is wired to the till, which is what the venue asked about. Where
-- the reader is plugged in and where the rules live are different questions.
--
-- Target is MySQL 5.7 / MariaDB. Every statement is guarded and safe to re-run,
-- because deploy.ps1 -Schema runs this file on every deploy.
--
-- NAMED `swipe_cards` RATHER THAN `cards`, AND THAT MATTERS
--
-- deploy.ps1 applies these files in `ls schema_*.sql | sort` order. This one
-- adds columns to epos_customers and reads epos_gift_cards, so it has to run
-- after schema_customers.sql and schema_commerce.sql -- and `cards` sorts
-- before both of them. On a fresh database it would have found no tables to
-- alter, skipped silently, and left a venue without a member_no column until
-- somebody happened to deploy twice.
--
-- The column adders below are guarded against a missing table anyway. That is a
-- second belt rather than the braces: a guard that turns a mis-ordered
-- migration into a silent no-op is exactly the kind of safety that hides the
-- fault it is protecting against.
--
-- Collation note, as in schema_devices.sql: `office` is an email address
-- compared against utf8mb4_general_ci columns elsewhere, so it is stated
-- explicitly rather than inherited from the server default.


-- ---------------------------------------------------------------------------
-- Idempotent column adder. Same procedure the other migrations use.
-- ---------------------------------------------------------------------------
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

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD INDEX `', idx, '` (', cols, ')');
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- What each prefix means in this venue.
-- ---------------------------------------------------------------------------
-- One row per office. Defaults are this venue's live numbers; see the note at
-- the top.
CREATE TABLE IF NOT EXISTS epos_card_settings (
  office            VARCHAR(190) CHARACTER SET utf8mb4
                    COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,

  -- Whether the till listens to the reader at all. A venue with no reader
  -- wired up is not a venue that wants a stray barcode scan signing somebody
  -- on, and the honest way to say "we do not use these" is a switch rather
  -- than three blank prefixes that behave unpredictably.
  enabled           TINYINT(1)   NOT NULL DEFAULT 1,

  -- VARCHAR rather than INT, and that is deliberate: a prefix is a string of
  -- digits that may begin with a zero, and 0998 stored as an integer is 998 --
  -- which matches nothing, on every card the venue owns.
  clerk_prefix      VARCHAR(8)   NOT NULL DEFAULT '9999',
  loyalty_prefix    VARCHAR(8)   NOT NULL DEFAULT '9998',
  gift_prefix       VARCHAR(8)   NOT NULL DEFAULT '9878',

  -- A fourth programme, empty by default. Membership is a different question
  -- from loyalty and always has been -- loyalty is points earned, membership is
  -- a subscription with a date on it, and epos_customers has carried
  -- points_balance and membership_expiry side by side since long before there
  -- was a card to read them with.
  --
  -- Empty rather than a made-up number, because this venue's current system has
  -- three prefixes and no fourth: giving them one would switch on a scheme they
  -- have not asked for and have no cards for. An empty prefix matches nothing.
  membership_prefix VARCHAR(8)   NOT NULL DEFAULT '',

  -- How wide the number after the prefix is when this venue issues a card.
  -- Five, because ;999800001? is what they programme today. Only used for
  -- *writing*: reading accepts whatever width is on the card, because the
  -- cards already in circulation were not necessarily made here.
  number_digits     TINYINT      NOT NULL DEFAULT 5,

  -- Swiping an unknown loyalty card offers to enrol the person holding it.
  -- This is the venue's own request -- "if no member is found it would ask
  -- would you like to create a new member for the card that's been swiped" --
  -- and it is a switch because a venue running a closed scheme, where cards
  -- are issued from the back office only, wants the till to say "not a member"
  -- rather than open a form at the counter.
  auto_enrol        TINYINT(1)   NOT NULL DEFAULT 1,

  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- The next number to hand out.
-- ---------------------------------------------------------------------------
-- One row per office per kind. A counter rather than MAX(number)+1, because
-- MAX+1 hands out a number again the moment a card is deleted -- and the card
-- with that number is still in somebody's wallet. A number that has been issued
-- must never be issued twice, however tidy the gap looks.
CREATE TABLE IF NOT EXISTS epos_card_sequences (
  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  -- 'loyalty' | 'gift' | 'clerk' | 'membership'. Free text, so a programme
  -- invented later does not need a migration to start counting.
  kind          VARCHAR(24)  NOT NULL,

  next_number   INT UNSIGNED NOT NULL DEFAULT 1,

  PRIMARY KEY (office, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- Every card this venue has issued.
-- ---------------------------------------------------------------------------
-- Append-only, like bo_device_log and for the same reason: this is the record
-- that settles "who has card 00042 and when did they get it", and a record the
-- back office can edit settles nothing.
--
-- There is deliberately no foreign key to epos_customers or bo_clarks. A card
-- must still be traceable after the member is deleted -- ON DELETE CASCADE here
-- would mean removing a customer quietly erased the fact that a card was ever
-- put in their hand, which is precisely what somebody would go looking for.
CREATE TABLE IF NOT EXISTS epos_card_issues (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,

  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  -- 'clerk' | 'loyalty' | 'gift' | 'membership'.
  kind          VARCHAR(24)  NOT NULL,

  -- The full number as it is encoded on the stripe, prefix and all -- the thing
  -- the reader will type. Without the sentinels: those are the reader's, not
  -- the card's, and a venue matching a number by eye should not have to squint
  -- past punctuation.
  card_number   VARCHAR(64)  NOT NULL,

  -- Who it was issued to. A customer UUID, a bo_clarks.id, or a gift card id,
  -- depending on `kind` -- which is why this is a string and has no constraint
  -- on it.
  subject_id    VARCHAR(64)  NULL,

  -- The name at the time, denormalised for the same reason bo_device_log
  -- carries a device name: renaming somebody must not rewrite the record of
  -- what they were called when the card was handed over.
  subject_name  VARCHAR(190) NULL,

  issued_by     VARCHAR(190) NULL,
  terminal      VARCHAR(120) NULL,

  -- Set when a card is replaced or cancelled. The row stays: a lost card is a
  -- thing that happened, and the replacement's row is meaningless without it.
  voided_at     DATETIME     NULL,
  void_reason   VARCHAR(190) NULL,

  at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_card_issues_office_at (office, at),
  KEY idx_card_issues_number (office, card_number),
  KEY idx_card_issues_subject (office, kind, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- A staff member's card.
-- ---------------------------------------------------------------------------
-- bo_clarks is a legacy table this project does not own the DDL for, so the
-- column is added the same guarded way schema_staff_idle.sql adds `active`.
--
-- The whole number is stored, prefix included, rather than just the digits
-- after it. Two reasons: a venue that changes its clerk prefix must not
-- silently invalidate every staff card in the building, and matching a swipe
-- becomes one equality check against what the reader typed rather than an
-- arithmetic problem.
CALL vesopa_add_column(
  'bo_clarks', 'swipe_card', 'VARCHAR(64) NULL');
CALL vesopa_add_index(
  'bo_clarks', 'idx_clarks_swipe', '`email`, `swipe_card`');


-- ---------------------------------------------------------------------------
-- A member's number.
-- ---------------------------------------------------------------------------
-- epos_customers already has `card_number` -- the full number on the stripe,
-- which is what a swipe is matched against. This is the human-facing half: the
-- 1 in ;999800001?, the thing a member quotes on the phone and a manager reads
-- off a list.
--
-- Nullable, and every existing customer keeps a NULL. Numbering the whole back
-- catalogue would be inventing membership numbers that were never on a card and
-- never given to anybody; a member gets one when a card is issued to them.
CALL vesopa_add_column('epos_customers', 'member_no', 'INT UNSIGNED NULL');

-- Added separately as well as declared above, so a venue whose epos_card_settings
-- row was created before there was a fourth programme picks the column up on
-- the next deploy rather than on a rebuild.
CALL vesopa_add_column(
  'epos_card_settings', 'membership_prefix',
  "VARCHAR(8) NOT NULL DEFAULT ''");

-- Swiping is a lookup on this and it happens at the counter, mid-sale, with a
-- customer waiting. Not unique: a venue importing a customer book from another
-- system can arrive with duplicates, and refusing the import is a worse answer
-- than showing the clerk two rows and letting them choose.
CALL vesopa_add_index(
  'epos_customers', 'idx_cust_card', '`email_key`, `card_number`');
CALL vesopa_add_index(
  'epos_customers', 'idx_cust_member_no', '`email_key`, `member_no`');


-- ---------------------------------------------------------------------------
-- What the counter is offered when somebody's card is on screen
-- ---------------------------------------------------------------------------
--
-- The two actions a venue takes with a named person -- put their card on their
-- phone, and print them one -- now appear on six back-office lists and at the
-- till. These three switches are how a venue turns off the half it does not do.
--
-- Both buttons default on: a venue issuing cards at all wants both, and a
-- feature that has to be found and switched on before it appears is a feature
-- nobody discovers. `wallet_on_display` defaults on for the opposite reason --
-- the code belongs on the screen facing the customer, and a counter without a
-- second screen falls back to the till's own without being told to.
CALL vesopa_add_column(
  'epos_card_settings', 'till_wallet_button', 'TINYINT(1) NOT NULL DEFAULT 1');
CALL vesopa_add_column(
  'epos_card_settings', 'till_print_button', 'TINYINT(1) NOT NULL DEFAULT 1');
CALL vesopa_add_column(
  'epos_card_settings', 'wallet_on_display', 'TINYINT(1) NOT NULL DEFAULT 1');


DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
