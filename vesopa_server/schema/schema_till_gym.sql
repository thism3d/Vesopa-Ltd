-- The gym door: a card in, the same card out, and a record of who was in.
--
-- WHAT THE VENUE ACTUALLY HAS
--
-- A till in a gym that nobody stands behind. A member arrives, swipes their
-- card, and walks in; on the way out they swipe the same card again. Nobody is
-- there to tap "OK", which is the single fact that shapes everything below:
--
--   * the card gets its OWN prefix, so a gym card can never be mistaken for a
--     loyalty card and open the enrol-a-member form at an unmanned counter;
--   * a swipe is an EVENT with a time on it, not an instruction to change some
--     current state, so a swipe that reached the server late still lands in the
--     right place in the day;
--   * and every judgement that could need a human -- an expired card, a member
--     who forgot to swipe out -- has an answer that needs nobody.
--
-- WHY A SEPARATE SETTINGS TABLE AND NOT A COLUMN ON epos_till_settings
--
-- Because the switch has to be able to say "this venue is not a gym", and mean
-- it, for the overwhelming majority of venues that are pubs. `enabled` defaults
-- to 0 and nothing gym-shaped appears at a till or in the back office until
-- somebody turns it on -- which is the venue's own requirement, stated twice.
-- A column on the till settings row would have put nine gym fields on every
-- pub in the estate.
--
-- WHY THE VISIT IS A ROW AND NOT A FLAG ON THE CUSTOMER
--
-- "Create a report of how frequently members have been using the gym." A flag
-- saying who is in right now answers today at nine in the morning and nothing
-- else, for ever. A row per visit answers that question and every other one:
-- how often, how long, which days, who has stopped coming.
--
-- SORT ORDER
--
-- Files in this folder apply in `ls | sort` order and there are no numeric
-- prefixes, so a file must sort after whatever creates the tables it touches.
-- This one reads epos_customers (schema_customers.sql) and alters
-- epos_card_settings (schema_swipe_cards.sql); `till_gym` sorts after both,
-- and after schema_staff_idle.sql, which is where epos_till_settings is made.
--
-- RE-RUNNABLE, AND WHY THAT IS NOT OPTIONAL
--
-- The deploy applies every file in this folder on every deploy. A bare
-- `ALTER TABLE ... ADD COLUMN` fails the second time, and because MySQL applies
-- a multi-clause ALTER as a single statement, a duplicate-column error rolls
-- back the clauses that had already succeeded -- so a database that already
-- held one of these columns would get none of the others, for ever. See
-- schema_order_cols.sql, where that was found out the expensive way.


-- ---------------------------------------------------------------------------
-- Idempotent column and index adders. Each file defines its own, because the
-- file before it drops them on its last line.
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
-- The fifth programme: a gym card.
-- ---------------------------------------------------------------------------
-- Empty by default, exactly as `membership_prefix` is, and for the same reason:
-- an empty prefix matches nothing, so no venue gains a programme it has not
-- asked for.
--
-- IT HAS TO BE ITS OWN PREFIX, AND THAT IS THE VENUE'S POINT
--
-- "Maybe another prefix for Gym Members Cards due to it being unmanned and
-- can't have pop ups." A gym card sharing the loyalty prefix would be read as a
-- loyalty card: an unknown one would open the enrol-a-member form on a till
-- with nobody behind it, and a known one would put a member on a bill that does
-- not exist. Its own prefix is what lets the till decide, before it looks
-- anything up, that this swipe is a door and not a sale.
CALL vesopa_add_column(
  'epos_card_settings', 'gym_prefix', "VARCHAR(8) NOT NULL DEFAULT ''");


-- ---------------------------------------------------------------------------
-- Whether this venue runs a gym at all, and how the door behaves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_gym_settings (
  office              VARCHAR(190) CHARACTER SET utf8mb4
                      COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,

  -- OFF. Not "off for now" -- off as the answer for every venue that is not a
  -- gym, which is nearly all of them. Until a manager turns this on there is no
  -- Gym section in the back office, no Gym page on the till, no gym options in
  -- the till's settings, and a gym card is not a kind of card the till knows.
  enabled             TINYINT(1)   NOT NULL DEFAULT 0,

  -- A member who forgot to swipe out is closed off after this long.
  --
  -- Somebody who leaves without swiping would otherwise sit on the board as
  -- "in the gym" until the heat death of the universe, and would contribute a
  -- fourteen-hour visit to the attendance report. Four hours is chosen against
  -- the longest plausible session rather than the average one; the row is
  -- marked as closed automatically, so a report can tell a real visit from a
  -- guess and nobody has to trust the length of one.
  auto_close_hours    SMALLINT     NOT NULL DEFAULT 4,

  -- Two reads of the same card inside this many seconds are one swipe.
  --
  -- The single most important number on this table. A stripe reader that
  -- double-reads, or a member who swipes twice because the first one did not
  -- look like it worked, would otherwise be signed in and straight back out
  -- again -- leaving the gym holding nobody, and the report holding a
  -- three-second visit. Nobody is standing there to notice.
  debounce_seconds    SMALLINT     NOT NULL DEFAULT 45,

  -- Days after the printed expiry date that a card still opens the door.
  --
  -- Zero, so a membership runs to the end of the day it expires on and not a
  -- minute longer. A venue that would rather let somebody in for a week while
  -- the renewal is chased sets this instead of explaining it at the counter --
  -- and the slip still prints on day one, so the chase actually starts.
  grace_days          SMALLINT     NOT NULL DEFAULT 0,

  -- Print a slip when an expired card is swiped.
  --
  -- The venue's own request: "if the gym membership card has expired, can we
  -- get an automated slip printed to say who has expired and when." On, because
  -- an unmanned door with this off has no way whatsoever of telling anybody.
  expiry_slip         TINYINT(1)   NOT NULL DEFAULT 1,

  -- Refuse an expired card rather than record the visit.
  --
  -- OFF, and the default is the honest one. This till is not a turnstile: it
  -- cannot stop anybody walking in, so a record saying the visit did not happen
  -- would simply be false. Off means the member is let in, the visit is
  -- recorded and flagged, and the slip prints. A venue whose door IS locked to
  -- the till turns this on and gets a refusal on screen.
  refuse_expired      TINYINT(1)   NOT NULL DEFAULT 0,

  -- Warn on the board and on the greeting this many days before the date.
  --
  -- Two weeks: long enough that a member who comes twice a week sees it more
  -- than once, short enough that it still reads as news.
  expiring_soon_days  SMALLINT     NOT NULL DEFAULT 14,

  -- How long the greeting stays on the till before the screen clears itself.
  --
  -- It MUST clear itself. A panel with somebody's name and photograph on it,
  -- waiting for a tap that nobody is there to give, is the next member's
  -- greeting covered up by the last member's -- and a stranger's name and face
  -- left facing the room.
  greeting_seconds    SMALLINT     NOT NULL DEFAULT 6,

  -- Show the member's photograph on the greeting.
  --
  -- On where there is one. It is the same photograph the counter uses to check
  -- a membership card against a face, and at an unmanned door it is the only
  -- check there is: the member sees whose card they have just used.
  show_photo          TINYINT(1)   NOT NULL DEFAULT 1,

  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- One row per visit: in, and out.
-- ---------------------------------------------------------------------------
-- Append-mostly. A row is written when somebody swipes in and closed when they
-- swipe out; nothing else edits it except a manager correcting a visit that was
-- left open, and that correction is stamped so a report can tell.
--
-- NO FOREIGN KEY TO epos_customers, deliberately, exactly as epos_card_issues
-- has none: attendance has to survive a member being deleted. ON DELETE CASCADE
-- here would mean removing one member quietly rewrote the gym's attendance
-- history, which is precisely the number somebody would go looking for.
CREATE TABLE IF NOT EXISTS epos_gym_visits (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,

  office            VARCHAR(190) CHARACTER SET utf8mb4
                    COLLATE utf8mb4_general_ci NOT NULL,

  -- The till's own id for the swipe that OPENED this visit, and for the one
  -- that closed it.
  --
  -- These are what make an unmanned door survive a dropped broadband line. A
  -- till with no network queues the swipe on its own disk and sends it when the
  -- link returns; the queue is at-least-once, so the same swipe can arrive
  -- twice. Without these two columns the second copy of "swiped in" opens a
  -- second visit and the member is in the gym twice.
  --
  -- Nullable, and MySQL allows any number of NULLs in a unique index -- so a
  -- visit created from the back office, which has no swipe behind it, is not
  -- competing with anything.
  swipe_id          VARCHAR(64)  NULL,
  left_swipe_id     VARCHAR(64)  NULL,

  -- Who. A customer UUID; the name and number are denormalised beside it for
  -- the same reason epos_card_issues denormalises a name -- renaming somebody
  -- must not rewrite the record of who was in the building on Tuesday.
  customer_id       CHAR(36)     NULL,
  member_no         INT UNSIGNED NULL,
  member_name       VARCHAR(190) NULL,

  -- The card as the reader typed it, prefix included and sentinels excluded --
  -- the same rule as everywhere else a card number is stored. Kept even when
  -- the card belongs to nobody, because "an unknown card was swiped at the
  -- door at 6:04" is the beginning of an answer and a missing row is not.
  card_number       VARCHAR(64)  NOT NULL,

  entered_at        DATETIME     NOT NULL,
  left_at           DATETIME     NULL,

  -- What closed it: 'card' (they swiped out), 'auto' (the sweep, after
  -- auto_close_hours) or 'office' (a manager, by hand). A visit closed by the
  -- sweep is a visit of unknown length, and a report that could not tell the
  -- difference would be quietly averaging in a number nobody measured.
  closed_by         VARCHAR(16)  NULL,

  entered_terminal  VARCHAR(120) NULL,
  left_terminal     VARCHAR(120) NULL,

  -- The membership date as it stood at the moment of entry, and whether that
  -- made this an expired visit.
  --
  -- Stored rather than joined at report time. A member who renews on Friday
  -- must not retrospectively turn Monday's expired entry into a valid one --
  -- the slip was printed, somebody acted on it, and a report that no longer
  -- agrees with the piece of paper is a report nobody believes.
  membership_expiry DATE         NULL,
  expired           TINYINT(1)   NOT NULL DEFAULT 0,

  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_gym_swipe_in  (office, swipe_id),
  UNIQUE KEY uq_gym_swipe_out (office, left_swipe_id),

  -- Who is in the gym right now. The board asks this every few seconds on a
  -- screen somebody is looking at, so it is the one query here that has to be
  -- an index seek rather than a scan of the year.
  KEY idx_gym_open   (office, left_at, entered_at),

  -- How often has this member been coming. The attendance report, and the
  -- "last seen" column beside it.
  KEY idx_gym_member (office, customer_id, entered_at),

  -- A day, a week, a month of the door.
  KEY idx_gym_at     (office, entered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Added separately as well as declared above, so a venue whose epos_gym_visits
-- table was created by an earlier build of this file picks up anything added to
-- it later on the next deploy rather than on a rebuild. There is nothing to add
-- yet; the calls below are the pattern the next change follows.
CALL vesopa_add_index(
  'epos_gym_visits', 'idx_gym_card', '`office`, `card_number`, `entered_at`');


DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
