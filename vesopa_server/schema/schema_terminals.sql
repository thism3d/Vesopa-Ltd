-- Terminals that know about each other.
--
-- Everything before this file treated a till as an island. It kept its own
-- open bills in its own SQLite file and posted a sale to the server only once
-- the money was taken, which is exactly right for the thing that must keep
-- working with the broadband down -- and exactly wrong for a dining room with
-- two terminals in it. Table 6 saved at the bar could not be recalled at the
-- station by the door; a clerk who started a round on one till and walked to
-- the other found an empty bill; and a manager had no way to tell who was on
-- shift, let alone for how long.
--
-- Three ideas, one rule: a bill, a clerk and a shift are properties of the
-- venue, not of the machine that happens to be nearest.
--
-- The offline rule is unchanged and non-negotiable. None of this is on the
-- path that takes money. A terminal that cannot reach the server rings up,
-- prints and settles exactly as it did before; it simply cannot see the other
-- terminal's tables while it is cut off, and says so rather than pretending.
--
-- Target is MySQL 5.7 / MariaDB. Everything is CREATE TABLE IF NOT EXISTS, so
-- deploy.sh can run it on every deploy.
--
-- Collation note, as in schema_screens.sql: `office` is an email address
-- compared against utf8mb4_general_ci columns, so it is stated explicitly
-- rather than left to the server's default.


-- ---------------------------------------------------------------------------
-- A bill that has not been paid for yet.
-- ---------------------------------------------------------------------------
-- Deliberately NOT `epos_orders`. That table is the sales ledger: a row in it
-- is takings, it is what every report sums, and putting half-rung baskets in
-- it would poison all of them. This is a scratch pad that a bill passes
-- through on its way there, and a row leaves it the moment the sale lands.
--
-- The whole basket is carried as JSON rather than normalised into lines. Two
-- reasons, and the second is the one that matters:
--
--   * the server never reads inside it -- it stores what one terminal sent and
--     hands it to another verbatim, so a schema for the contents would buy
--     nothing;
--   * a till on a newer build can put a field in the basket that this server
--     has never heard of, and the terminal beside it still receives it intact.
--     A normalised table would silently drop it, which is the worst possible
--     failure for the thing that describes what a customer ordered.
CREATE TABLE IF NOT EXISTS epos_open_bills (
  -- The till's own order UUID, so a bill keeps one identity from the first
  -- item to the receipt, and posting the finished sale can retire this row by
  -- the same key.
  id            CHAR(36) NOT NULL PRIMARY KEY,

  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  -- Which terminal is holding it open right now. A bill belongs to the venue,
  -- but exactly one terminal is editing it at a time -- see `claimed_at`.
  terminal      VARCHAR(120) NULL,

  -- Where it is sitting. A null table_number is a bill in hand at the counter
  -- that has not been parked anywhere; it still syncs, because that is what
  -- lets a basket follow a clerk to the next terminal.
  table_number  INT NULL,
  room_id       INT NULL,
  covers        INT NULL,

  -- Who is on it. staff_id is the one reports group by; the name is carried so
  -- another terminal can draw the table plan without a join it may not be able
  -- to resolve.
  staff_id      INT NULL,
  clerk_name    VARCHAR(120) NULL,

  -- 'open' (in hand on a terminal) or 'parked' (saved to a table and let go).
  status        VARCHAR(16) NOT NULL DEFAULT 'open',

  -- What the customer has ordered, as the till's own order JSON: header fields
  -- plus `lines`. Never parsed here.
  payload       MEDIUMTEXT NOT NULL,

  -- Denormalised out of the payload so a table plan can be drawn without every
  -- terminal parsing every basket in the room.
  total_minor   INT NOT NULL DEFAULT 0,
  line_count    INT NOT NULL DEFAULT 0,

  -- The change feed. Monotonic per office and bumped on every write, so a
  -- terminal asks what has changed since 41 and gets exactly that.
  --
  -- A timestamp cannot do this job: two writes inside the same second are
  -- indistinguishable, and the clocks on two Windows tills in one venue are
  -- not the same clock. `rev` is the server's own counter and is the only
  -- ordering any terminal is allowed to trust.
  rev           BIGINT UNSIGNED NOT NULL,

  claimed_at    DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_open_bills_office_rev (office, rev),
  KEY idx_open_bills_table (office, room_id, table_number),
  KEY idx_open_bills_staff (office, staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- The counter behind `rev`.
-- ---------------------------------------------------------------------------
-- One row per office. AUTO_INCREMENT on the bills table itself cannot do this
-- job: rows leave that table when a sale completes, and InnoDB hands the ids
-- of deleted rows back out after a restart -- a terminal that had seen rev 900
-- would then never be told about rev 880, and a table would sit on the plan
-- for ever.
CREATE TABLE IF NOT EXISTS epos_open_bill_revs (
  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  rev           BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- Bills that have gone away, so a terminal can be told they have.
-- ---------------------------------------------------------------------------
-- A deletion is a change, and a change feed that only ever reports rows which
-- still exist cannot express one. Without this a bill settled at the bar stays
-- on the door terminal's table plan until somebody restarts it.
--
-- Rows are pruned by the feed itself once they are a day old -- far longer
-- than any terminal is realistically offline mid-service, and short enough
-- that this never becomes a table anybody has to think about.
CREATE TABLE IF NOT EXISTS epos_open_bill_tombstones (
  id            CHAR(36) NOT NULL PRIMARY KEY,
  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,
  rev           BIGINT UNSIGNED NOT NULL,
  -- 'settled' | 'cancelled' | 'merged'. Carried so a terminal can say why a
  -- table it was looking at is no longer there.
  reason        VARCHAR(16) NOT NULL DEFAULT 'settled',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tombstones_office_rev (office, rev),
  KEY idx_tombstones_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- Which terminal a clerk is signed on to.
-- ---------------------------------------------------------------------------
-- One row per member of staff, and that is the whole feature: the primary key
-- is (office, staff_id), so signing on somewhere else does not add a session,
-- it moves the one that exists. A clerk cannot be on two tills at once because
-- there is nowhere to record it.
--
-- The reason is not tidiness. A clerk whose PIN is live on two machines has
-- two baskets, and the second one they walk away from is a round of drinks
-- nobody is charged for.
CREATE TABLE IF NOT EXISTS epos_clerk_sessions (
  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,
  staff_id      INT NOT NULL,
  staff_name    VARCHAR(120) NULL,

  -- Where they are standing, named by the till's own terminal name -- the same
  -- string that goes on a receipt, so a manager reading either can match them.
  terminal      VARCHAR(120) NOT NULL,

  -- The bill they had in hand when they last touched a till. This is the
  -- "items follow them" half: signing on at the next terminal hands this id
  -- back, and that terminal pulls the basket out of epos_open_bills.
  basket_id     CHAR(36) NULL,

  signed_on_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (office, staff_id),
  KEY idx_clerk_sessions_terminal (office, terminal)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- Clock in, clock out.
-- ---------------------------------------------------------------------------
-- Separate from the sign-on above, and they are genuinely different questions.
-- Signing on says "I am about to ring something up on this machine"; it
-- happens twenty times a shift and ends every time somebody walks away. A
-- shift is one row that opens when a person arrives and closes when they
-- leave, and it is what a wage is paid against.
--
-- An open shift is a row with a null `clocked_out_at`. There is deliberately
-- no unique constraint forcing one open shift per person: the API enforces
-- that, and a database that refused the row outright would leave a member of
-- staff unable to clock in at the counter with nobody able to explain why.
CREATE TABLE IF NOT EXISTS epos_time_clock (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  office        VARCHAR(190) CHARACTER SET utf8mb4
                COLLATE utf8mb4_general_ci NOT NULL,

  staff_id      INT NOT NULL,
  -- Held rather than joined, so a shift keeps the name it was worked under
  -- even after the person is renamed or removed -- the same rule the sales
  -- ledger already follows for clerk_name.
  staff_name    VARCHAR(120) NULL,

  clocked_in_at   DATETIME NOT NULL,
  clocked_out_at  DATETIME NULL,

  -- Where each end of the shift was recorded. A venue with two terminals does
  -- ask "clocked in at the bar, out at the door".
  in_terminal   VARCHAR(120) NULL,
  out_terminal  VARCHAR(120) NULL,

  -- Only ever set by a manager in the back office, and only on a shift that
  -- was edited after the fact. An unedited row has null here, which is what
  -- makes an edited one worth looking at.
  adjusted_by   VARCHAR(190) NULL,
  note          VARCHAR(255) NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_time_clock_office_in (office, clocked_in_at),
  KEY idx_time_clock_open (office, staff_id, clocked_out_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
