-- ===========================================================================
-- Gift cards that are sold somewhere else, held before they are spent, and
-- given back when a sale is undone.
-- ===========================================================================
--
-- WHAT THIS IS FOR
--
-- Gift cards have lived in epos_gift_cards since schema_commerce.sql, issued
-- from the back office and spent at the till. Three things are new:
--
--   * A card can be issued by another system -- the online gift shop -- which
--     must never make two cards for one payment when it retries. So a card can
--     carry the caller's own reference, unique per venue.
--   * A till can HOLD part of a balance while a bill is open, spend it when the
--     sale completes, and give it back when the tender is undone. Before this,
--     tendering a card spent it on the spot and Undo never put it back.
--   * A card can be not-yet-spendable: an online order over the venue's limit
--     waits a day before it can be used, which is the one thing that makes a
--     stolen card worthless for buying vouchers.
--
-- SORT ORDER. Runs after schema_commerce.sql ('c' < 'g'), which creates both
-- tables this alters.
--
-- COLLATION. epos_gift_cards took the server's default when it was created
-- (utf8mb4_uca1400_ai_ci on live). Nothing here joins a new column to an old
-- one: every query binds the office and the card id as parameters, which take
-- the collation of the column they are compared with. See the note on
-- office collation in schema_swipe_cards.sql.
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

-- ---------------------------------------------------------------------------
-- The card
-- ---------------------------------------------------------------------------

-- Where it came from: the back office, a till, or the gift shop. Reports and
-- the back office's list tell them apart, and a refund from the shop may only
-- touch a card the shop issued.
CALL vesopa_add_column('epos_gift_cards', 'source', 'VARCHAR(16) NOT NULL DEFAULT ''backoffice''');

-- The issuer's own id for the thing that was bought -- one line of one order.
-- NULL for everything issued before, and MySQL allows any number of NULLs in a
-- unique index, so old cards are untouched by the key below.
CALL vesopa_add_column('epos_gift_cards', 'external_ref', 'VARCHAR(80) NULL');

-- What the till shows beside the balance: "Sunday lunch for two" rather than a
-- bare £48, so a clerk rings up the right thing.
CALL vesopa_add_column('epos_gift_cards', 'label', 'VARCHAR(120) NULL');

-- Not spendable before this moment. NULL means now.
CALL vesopa_add_column('epos_gift_cards', 'usable_from', 'DATETIME NULL');

-- The voucher's own picture, as the band across its Wallet pass: the shop sends
-- the design the buyer chose, at Apple's two sizes, and it lands in
-- public/uploads like a venue's own upload would. NULL falls back to the
-- venue's gift-card programme, then its branding.
CALL vesopa_add_column('epos_gift_cards', 'art_strip_url', 'VARCHAR(500) NULL');

CALL vesopa_add_index(
  'epos_gift_cards', 'uq_gift_external',
  'UNIQUE KEY `uq_gift_external` (office, external_ref)'
);

-- ---------------------------------------------------------------------------
-- Money held while a bill is open
-- ---------------------------------------------------------------------------
--
-- A hold does not move the balance. It narrows what is AVAILABLE -- balance
-- minus live holds -- so a second till cannot spend the same money while the
-- first is still ringing the bill up. It turns into a real redemption when the
-- sale completes, and simply lapses if the till never comes back.
CREATE TABLE IF NOT EXISTS epos_gift_card_holds (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  gift_card_id  CHAR(36)     NOT NULL,
  office        VARCHAR(190) NOT NULL,
  amount_minor  INT          NOT NULL,
  order_id      VARCHAR(64)  NULL,
  terminal      VARCHAR(80)  NULL,
  clerk_name    VARCHAR(80)  NULL,
  -- held | captured | released
  status        VARCHAR(12)  NOT NULL DEFAULT 'held',
  txn_id        CHAR(36)     NULL,
  expires_at    DATETIME     NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at    DATETIME     NULL,
  KEY idx_hold_card (gift_card_id, status),
  KEY idx_hold_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which hold a redemption came from, and which redemption a reversal undid.
CALL vesopa_add_column('epos_gift_card_txns', 'hold_id', 'CHAR(36) NULL');
CALL vesopa_add_column('epos_gift_card_txns', 'reverses_txn_id', 'CHAR(36) NULL');

-- ---------------------------------------------------------------------------
-- Till calls that arrived without a till's signature
-- ---------------------------------------------------------------------------
--
-- The gift card, voucher, deposit and loyalty routes a till calls used to be
-- identified by nothing but the venue's contact email. They now accept the
-- till's own signed token. They are not REFUSED without one yet: a till
-- commissioned before v1.3.1.0 has no token to send, and switching the check on
-- blind would stop a venue taking gift cards on a Saturday.
--
-- So every unsigned call is counted here, per venue, route and day. When this
-- table stops growing, COMMERCE_REQUIRE_TERMINAL=1 can be set and nothing in
-- the field will notice.
CREATE TABLE IF NOT EXISTS epos_commerce_unsigned (
  office     VARCHAR(190) NOT NULL,
  route      VARCHAR(40)  NOT NULL,
  reason     VARCHAR(12)  NOT NULL,
  day        DATE         NOT NULL,
  calls      INT          NOT NULL DEFAULT 0,
  last_ip    VARCHAR(45)  NULL,
  last_at    DATETIME     NULL,
  PRIMARY KEY (office, route, reason, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
