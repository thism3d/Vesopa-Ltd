-- Vesopa Express: the self-service ordering kiosk.
--
-- WHAT THE VENUE GETS
--
-- A portrait touchscreen by the door. A customer taps "Start order", chooses
-- eat in or take away, builds a basket from the venue's own menu, pays on the
-- Dojo card machine beside the screen, and walks away with a collection
-- number. The kitchen gets the ticket, the till is told, and a screen over the
-- counter shows the number moving from Preparing to Ready.
--
-- THREE THINGS SHAPE EVERY TABLE BELOW
--
--   1. OFF BY DEFAULT. Nearly every venue on this platform is a pub with a
--      till and a bar, and a kiosk is something they have to ask for.
--      `enabled` is 0 until a manager turns it on in the back office; until
--      then a kiosk cannot be commissioned and one already set up shows a calm
--      "switched off" screen instead of a menu. The back-office page itself is
--      always reachable -- see the Gym for what happened when it was not.
--
--   2. NOTHING IS A SALE UNTIL THE MONEY IS IN. A kiosk order starts life as a
--      request with a number on it. Only when Dojo reports the payment
--      captured does the server write the sale, raise the kitchen ticket and
--      tell the till -- in that order, once, whatever retries or restarts
--      happen in between. So an abandoned basket, a declined card or a kiosk
--      unplugged mid-payment leaves nothing in the takings and nothing on the
--      pass. The state lives on the order row, not in the kiosk's memory.
--
--   3. THE SECRET STAYS ON THE SERVER. The kiosk is a public client on a
--      screen in a room full of strangers. It never holds a Dojo key: the
--      server creates the payment and talks to the card machine, and the kiosk
--      only ever asks the server how it is going.
--
-- SORT ORDER. `till_express` sorts after schema_staff_idle.sql (which creates
-- epos_till_settings) and schema_kitchen.sql, and it creates everything else it
-- touches itself.
--
-- RE-RUNNABLE. Every deploy replays every file in this folder. Tables are
-- CREATE TABLE IF NOT EXISTS; anything added later goes through the guarded
-- adders below, defined here because the previous file drops them.
--
-- COLLATION. Every `office` column is declared utf8mb4_general_ci explicitly,
-- like the other tenancy columns -- the legacy tables carry the server default,
-- and a query joining the two directly is a 500 on live only. Bind the office
-- as a parameter instead.


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
-- Whether this venue runs kiosks at all, and how they behave.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_express_settings (
  office              VARCHAR(190) CHARACTER SET utf8mb4
                      COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,

  -- OFF. The answer for every venue that has not asked for a kiosk.
  enabled             TINYINT(1)   NOT NULL DEFAULT 0,

  -- Which of the two questions the first screen asks. A takeaway counter with
  -- no seating turns eat-in off and the question disappears; with both off
  -- the kiosk would have no way to start an order, so the server refuses to
  -- save that.
  eat_in              TINYINT(1)   NOT NULL DEFAULT 1,
  take_away           TINYINT(1)   NOT NULL DEFAULT 1,

  -- How a customer may pay. Card is the kiosk's whole point. "Pay at the
  -- counter" sends the order to the till as an unpaid request -- through the
  -- same dine-in queue a QR order uses, so the till accepts it and takes the
  -- money exactly as it already does -- and is off unless the venue wants it.
  pay_card            TINYINT(1)   NOT NULL DEFAULT 1,
  pay_counter         TINYINT(1)   NOT NULL DEFAULT 0,

  -- No money, no kitchen, no sale: for a kiosk standing in a showroom or
  -- being set up. Every screen says DEMO while this is on.
  demo_mode           TINYINT(1)   NOT NULL DEFAULT 0,

  -- Ask for a first name to call out. Optional by default; the number is
  -- what the board shows either way.
  ask_name            TINYINT(1)   NOT NULL DEFAULT 0,

  -- Seconds without a touch before the kiosk asks "Still there?" and then
  -- clears the basket. A basket left on the screen is the next customer's
  -- problem and the last customer's privacy.
  idle_seconds        SMALLINT     NOT NULL DEFAULT 60,

  -- The collection numbers, which go round. Short on purpose: a number is
  -- read off a screen across a room and called over an extractor fan.
  number_start        SMALLINT     NOT NULL DEFAULT 1,
  number_end          SMALLINT     NOT NULL DEFAULT 999,

  -- The attract screen.
  welcome_title       VARCHAR(120) NULL,
  welcome_subtitle    VARCHAR(200) NULL,
  welcome_image_url   VARCHAR(500) NULL,

  -- "May we suggest", as dine-in menu item ids, comma separated. Items that
  -- are sold out or have left the menu are skipped when the kiosk asks.
  upsell_items        VARCHAR(500) NULL,

  -- Where a kiosk order is announced. The kitchen gets a ticket on every
  -- screen watching the product's station; the till raises a card and a
  -- Windows toast. The collection board is a web page for any TV, reached by
  -- a secret address so a venue can put it on a smart TV without a sign-in.
  notify_till         TINYINT(1)   NOT NULL DEFAULT 1,
  notify_kitchen      TINYINT(1)   NOT NULL DEFAULT 1,
  board_enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  board_token         CHAR(32)     NULL,

  -- Leaving kiosk mode. A passcode a manager sets here, stored as PBKDF2 --
  -- never in clear, never returned. The kiosk gets the salt and the hash so it
  -- can still be exited when the network is down; a passcode that only works
  -- online is a kiosk nobody can get out of on the day the line fails.
  exit_salt           CHAR(32)     NULL,
  exit_hash           CHAR(64)     NULL,

  -- The venue's own Dojo secret key, encrypted with EXPRESS_SECRET_KEY from
  -- the server's environment. Blank means "use the platform key", which is
  -- the sandbox key while this is in testing. Only the last four characters
  -- are ever shown back.
  dojo_key_enc        TEXT         NULL,
  dojo_key_hint       VARCHAR(12)  NULL,

  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- The kiosks themselves.
-- ---------------------------------------------------------------------------
-- A kiosk is commissioned once, by a manager, with Continue with Vesopa, and
-- then runs for months with nobody signed in. Its token is long-lived for the
-- same reason a till's is -- and so it can be taken away without waiting for
-- that token to expire, every kiosk request checks `revoked_at` here. A stolen
-- kiosk is switched off from the back office in one click.
CREATE TABLE IF NOT EXISTS epos_express_kiosks (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  office            VARCHAR(190) CHARACTER SET utf8mb4
                    COLLATE utf8mb4_general_ci NOT NULL,

  -- What staff call it: "Kiosk by the door". Also the terminal name on every
  -- sale it takes, so reports can tell the kiosk's takings from the bar's.
  name              VARCHAR(80)  NOT NULL,

  -- The Dojo card machine beside this screen. Blank means no card machine,
  -- and the kiosk offers only what does not need one.
  dojo_terminal_id  VARCHAR(64)  NULL,

  commissioned_by   VARCHAR(190) NULL,
  commissioned_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      DATETIME     NULL,
  app_version       VARCHAR(40)  NULL,
  screen            VARCHAR(40)  NULL,
  revoked_at        DATETIME     NULL,

  KEY idx_express_kiosk_office (office, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- One row per kiosk order, from basket to collection.
-- ---------------------------------------------------------------------------
-- status:
--   awaiting_payment  priced and numbered; the card machine has been asked
--   paid              the money is in; sale, ticket and notifications done
--   ready             the kitchen has finished it (or somebody said so)
--   collected         handed over; off the board
--   counter           pay at the counter: sent to the till's queue unpaid
--   demo              demo mode; went nowhere
--   cancelled         the customer stopped before paying
--   failed            declined, or the card machine gave up
--
-- The lines are kept as a JSON snapshot of what the customer was shown and
-- charged. The sale's own lines are written to epos_order_lines like any
-- other sale, so every report reads them from the usual place; this copy is
-- what the kiosk and the board draw from.
CREATE TABLE IF NOT EXISTS epos_express_orders (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,

  -- What the kiosk polls with. Random, like a dine-in order's: an id a
  -- stranger could guess would let them watch somebody else's payment.
  public_id         CHAR(32)     NOT NULL,

  office            VARCHAR(190) CHARACTER SET utf8mb4
                    COLLATE utf8mb4_general_ci NOT NULL,
  kiosk_id          CHAR(36)     NULL,

  -- The kiosk's own id for this basket. A kiosk that loses its connection
  -- while sending an order sends it again with the same id, and gets the same
  -- order and the same number back rather than a second one.
  client_ref        CHAR(36)     NULL,

  number            SMALLINT     NOT NULL,
  business_date     DATE         NOT NULL,

  order_type        VARCHAR(12)  NOT NULL DEFAULT 'take_away',
  payment           VARCHAR(12)  NOT NULL DEFAULT 'card',
  status            VARCHAR(20)  NOT NULL DEFAULT 'awaiting_payment',
  status_note       VARCHAR(300) NULL,

  customer_name     VARCHAR(60)  NULL,

  subtotal_minor    INT          NOT NULL DEFAULT 0,
  discount_minor    INT          NOT NULL DEFAULT 0,
  total_minor       INT          NOT NULL DEFAULT 0,
  tax_minor         INT          NOT NULL DEFAULT 0,
  lines_json        MEDIUMTEXT   NULL,

  -- The payment, as Dojo knows it. The intent id is created ONCE and reused
  -- on every retry: Dojo ignores Idempotency-Key, so a second POST would be a
  -- second charge.
  dojo_intent_id    VARCHAR(64)  NULL,
  dojo_session_id   VARCHAR(64)  NULL,
  dojo_status       VARCHAR(40)  NULL,
  dojo_prompt       VARCHAR(40)  NULL,
  dojo_terminal_id  VARCHAR(64)  NULL,

  -- What it became.
  sale_id           VARCHAR(64)  NULL,
  ticket_id         VARCHAR(64)  NULL,
  dinein_order_id   INT          NULL,

  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at           DATETIME     NULL,
  ready_at          DATETIME     NULL,
  collected_at      DATETIME     NULL,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_express_public (public_id),
  UNIQUE KEY uq_express_client (kiosk_id, client_ref),
  -- The board and the back office: today's orders for one venue by state.
  KEY idx_express_office_day (office, business_date, status),
  -- A webhook or a reconciliation looking a payment up by Dojo's id.
  KEY idx_express_intent (dojo_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- The collection-number counter, one row per venue per day.
-- ---------------------------------------------------------------------------
-- A counter row rather than MAX(number)+1, because two kiosks finishing a
-- basket in the same second would both read the same maximum. The increment
-- is one atomic statement (INSERT ... ON DUPLICATE KEY UPDATE with
-- LAST_INSERT_ID), so no two orders in a day can be handed the same number
-- until the counter has gone all the way round.
CREATE TABLE IF NOT EXISTS epos_express_counters (
  office            VARCHAR(190) CHARACTER SET utf8mb4
                    COLLATE utf8mb4_general_ci NOT NULL,
  business_date     DATE         NOT NULL,
  last_number       INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (office, business_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Later columns join here, through the guard, so a database that already has
-- these tables picks them up on the next deploy. The call below is the
-- pattern; it changes nothing on a table that already has the index.
CALL vesopa_add_index(
  'epos_express_orders', 'idx_express_kiosk', '`kiosk_id`, `created_at`');


-- ---------------------------------------------------------------------------
-- 11 September 2026: the receipt, the kitchen printers, and meals.
-- ---------------------------------------------------------------------------

-- A ticket from the kiosk's own printer, once the order is placed:
--   always  printed every time, the McDonald's way -- the number on paper is
--           what the customer holds while they wait
--   ask     "Print a receipt?" on the number screen (the default: paper for
--           whoever wants it, and none for whoever does not)
--   never   the number is on the screen and on the board, and that is all
-- A kiosk with no printer set up prints nothing whatever this says.
CALL vesopa_add_column('epos_express_settings', 'receipt_mode',
  "VARCHAR(8) NOT NULL DEFAULT 'ask'");


-- Kiosk tickets for kitchen stations that PRINT.
--
-- A station set to Screen gets its ticket on Vesopa Kitchen straight from the
-- server. A station set to Printer is a printer plugged into a till -- printers
-- are set up per till, not per venue -- so only a till can print it. One row
-- per paid kiosk order per printing station, and a till claims the stations it
-- has a printer for with one UPDATE, so two tills never print the same ticket.
--
-- status:
--   waiting   nobody has taken it
--   claimed   a till took it and is printing (a claim older than two minutes
--             with no answer is taken to be a till that died, and is offered
--             again)
--   printed   done
--   failed    the till tried and the printer said no; offered again, up to
--             five attempts, so another till -- or the same one after somebody
--             loads paper -- can print it
--   expired   nobody printed it within thirty minutes. Not printed late: a
--             till switched on at six must not print lunch.
CREATE TABLE IF NOT EXISTS epos_express_prints (
  order_id          BIGINT       NOT NULL,
  office            VARCHAR(190) CHARACTER SET utf8mb4
                    COLLATE utf8mb4_general_ci NOT NULL,
  station           VARCHAR(8)   NOT NULL,
  status            VARCHAR(10)  NOT NULL DEFAULT 'waiting',
  claim_id          CHAR(36)     NULL,
  claimed_by        VARCHAR(120) NULL,
  claimed_at        DATETIME     NULL,
  printed_at        DATETIME     NULL,
  attempts          TINYINT      NOT NULL DEFAULT 0,
  error             VARCHAR(300) NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id, station),
  KEY idx_express_prints_queue (office, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- "Make it a meal": which meals a dish on the menu offers.
--
-- A meal is a PRODUCT in the catalogue -- "Cheeseburger Meal", with its own
-- price -- whose own modifier questions are the steps ("Choose your side",
-- "Choose your drink"), answered by products priced as the upgrade. That is
-- exactly how the till sells a meal at the counter, so the kiosk, the till and
-- every report agree on what a meal costs, and there is no second price list.
-- This table only says which meal products a dish offers, and what to call
-- each one when there is more than one size ("Regular", "Large").
--
-- On dinein_items because the kiosk sells from the Dine-in menu, and the QR
-- table menu can offer the same meals later without another table.
CREATE TABLE IF NOT EXISTS dinein_item_meals (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  office_id   INT          NOT NULL,
  item_id     INT          NOT NULL,
  plu_id      INT          NOT NULL,
  label       VARCHAR(40)  NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  UNIQUE KEY uq_dinein_item_meal (item_id, plu_id),
  KEY idx_dinein_item_meals_office (office_id, item_id),
  -- A dish taken off the menu takes its meals with it.
  CONSTRAINT fk_dinein_item_meal_item FOREIGN KEY (item_id)
    REFERENCES dinein_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
