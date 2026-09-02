-- Vesopa Kitchen: screens instead of (or as well as) a printer.
--
-- A station — kp1…kp6 — has always meant "a printer somewhere in the kitchen".
-- This lets a station mean a *screen* instead, or both, without changing what a
-- station is or how a product is routed to one. The routing already works and
-- venues already understand it; all that is new is where the ticket comes out.
--
-- Nothing in here is required for a venue that never opens the kitchen app.
-- Which stations deliver to a screen rather than a printer is a separate
-- migration — schema_till_kitchen.sql — because it alters the till-settings row
-- and so has to be applied after the file that creates it. See the note at the
-- top of that file.
--
-- Target is MySQL 5.7 / MariaDB. Everything here is CREATE TABLE IF NOT EXISTS,
-- so deploy.sh can run the whole schema_*.sql set on every deploy without this
-- failing the second time.
--
-- Collation note, the same one schema_staff_idle.sql makes: `office` is an
-- email address and gets joined to backoffice_users.email, which is
-- utf8mb4_general_ci. The live server's default for a bare utf8mb4 column is
-- uca1400_ai_ci, which does not compare against it — an "Illegal mix of
-- collations" that never reproduces on a dev box. So it is stated explicitly on
-- every column that holds one.

-- ---------------------------------------------------------------------------
-- Who may sign into a kitchen screen.
--
-- A fourth credential, rather than reusing one of the three this platform
-- already has. A back-office session opens the whole office and does not belong
-- on a wall above a fryer; a terminal token is issued at commissioning and is
-- specific to a till; a staff PIN is four shared digits and is attribution, not
-- a login.
--
-- Created by the back office, per the brief. The password is bcrypt from the
-- first row — unlike backoffice_users there is no plaintext history here to be
-- compatible with, so there is no reason to allow one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_kitchen_users (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4
               COLLATE utf8mb4_general_ci NOT NULL,

  -- What gets typed on the on-screen keyboard. Not an email: a chef signing a
  -- wall screen in with a full address, on a keyboard drawn on glass, with
  -- flour on their hands, is a sign-in that will not happen. "grill" is.
  username     VARCHAR(60) CHARACTER SET utf8mb4
               COLLATE utf8mb4_general_ci NOT NULL,

  password     VARCHAR(255) NOT NULL,

  -- Shown on the screen's info panel, so a support call can establish which
  -- login is on which wall.
  display_name VARCHAR(120) NULL,

  active       TINYINT(1) NOT NULL DEFAULT 1,
  last_seen_at DATETIME NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Per office, not global: two venues may both have a login called "kitchen".
  UNIQUE KEY uq_kitchen_user (office, username),
  INDEX idx_kitchen_user_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- A named board.
--
-- Which stations it watches, and how it behaves. Owned by the back office for
-- the same reason station names are: so "the grill screen" means one thing in
-- the venue, and changing it does not involve climbing onto a stool with a
-- keyboard.
--
-- Which profile a given machine *is* stays on that machine — picked once at
-- sign-in and kept in its own preferences. That is the same split the till
-- already draws between printer names (the venue's) and printer hardware (the
-- terminal's).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_kitchen_screens (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,
  name        VARCHAR(80) NOT NULL,

  -- Comma-separated station keys, the same format and the same vocabulary as
  -- bo_products.printer_routes. Empty means every station, which is what a
  -- one-screen kitchen wants and saves it having to tick six boxes.
  stations    VARCHAR(64) NULL,

  -- How many cards across. 0 means "work it out from the screen width", which
  -- is right for almost everybody; a venue with an unusual panel can pin it.
  columns_count  TINYINT NOT NULL DEFAULT 0,

  -- When an open ticket turns amber, and then red. Seconds.
  warn_seconds   INT NOT NULL DEFAULT 480,
  late_seconds   INT NOT NULL DEFAULT 900,

  -- How long a completed order stays on the Completed tab, and so how long it
  -- can still be recalled. Minutes.
  recall_minutes INT NOT NULL DEFAULT 60,

  -- Whether a new ticket makes a noise. Off for a screen at the pass, where the
  -- person is already looking at it; on for one in a corner.
  sound       TINYINT(1) NOT NULL DEFAULT 1,

  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_kitchen_screen (office, name),
  INDEX idx_kitchen_screen_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- The ticket itself: one row per *fire*, not per station.
--
-- A printer gets one ticket per station because paper cannot be filtered. A
-- screen can, so the till sends everything that fired once and each screen
-- draws the lines for the stations it watches. That is what makes one order
-- one card on a small kitchen's single screen, and the same order appear on
-- both the grill and the fryer screens — with only their own lines — in a large
-- one. Same data, no configuration.
--
-- `id` is the UUID the till mints, exactly as epos_orders does, so a terminal
-- retrying after a dropped connection re-sends the same id and INSERT IGNORE
-- turns the duplicate into a no-op rather than a second round of food.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_kitchen_tickets (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4
               COLLATE utf8mb4_general_ci NOT NULL,

  -- The bill this came off. Not a foreign key: a table saved but not yet
  -- settled has no row in epos_orders, and the kitchen has to have the food
  -- long before the money arrives.
  order_id     CHAR(36) NOT NULL,

  -- What the kitchen calls the order — the number a chef reads out and a
  -- clerk can find. Free text because the till composes it.
  ticket_no    VARCHAR(40) NULL,

  -- sale | table | reprint. Why it fired, which the kitchen genuinely works
  -- differently: a saved table is food to start against a bill that stays
  -- open, a sale is food already paid for, a reprint is neither.
  kind         VARCHAR(16) NOT NULL DEFAULT 'sale',

  table_number INT NULL,
  room_name    VARCHAR(120) NULL,
  staff_name   VARCHAR(80) CHARACTER SET utf8mb4
               COLLATE utf8mb4_general_ci NULL,
  covers       INT NULL,
  note         VARCHAR(500) NULL,

  -- Pushed to the front of the board regardless of age. Set from the screen,
  -- not the till: the kitchen decides what it is cooking next.
  rushed       TINYINT(1) NOT NULL DEFAULT 0,

  -- When the till fired it, as against when the row landed. They differ by the
  -- length of an outage, and the elapsed clock on the board must count from the
  -- first — a ticket held up by the network is *late*, and hiding that is the
  -- one thing the board must not do.
  placed_at    DATETIME NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_kitchen_ticket_office (office, placed_at),
  INDEX idx_kitchen_ticket_order (order_id),

  -- For the retention sweep in src/kitchen.js, which deletes by age across
  -- every office at once. The composite index above cannot serve a bare
  -- `placed_at <` predicate — its leading column is the office — so without
  -- this the hourly tidy-up is a full table scan of the one table that grows.
  INDEX idx_kitchen_ticket_age (placed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS epos_kitchen_ticket_lines (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  ticket_id  CHAR(36) NOT NULL,

  -- Preserves the order the clerk rang them in. A kitchen reads a ticket top to
  -- bottom and a re-sorted ticket is a re-plated dish.
  seq        INT NOT NULL DEFAULT 0,

  quantity   DOUBLE NOT NULL DEFAULT 1,
  name       VARCHAR(255) NOT NULL,

  -- The modifier line, in red on the board: "no tomato", "extra sausage". The
  -- one thing on the card that is not the recipe, and the reason a ticket gets
  -- read at all.
  note       VARCHAR(500) NULL,

  -- Which stations this line went to, comma separated, same vocabulary as
  -- bo_products.printer_routes. This is what each screen filters on.
  stations   VARCHAR(64) NULL,

  CONSTRAINT fk_kitchen_line_ticket FOREIGN KEY (ticket_id)
    REFERENCES epos_kitchen_tickets(id) ON DELETE CASCADE,
  INDEX idx_kitchen_line_ticket (ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Per-station progress.
--
-- Bumping on the grill screen closes the grill's row and nothing else. The
-- ticket leaves the Open tab when the last station closes — so the pass can see
-- the fryer is still working, and a kitchen with one screen never meets the
-- distinction at all.
--
-- Recall re-opens every station, which is the only useful reading of "that went
-- out wrong".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_kitchen_ticket_stations (
  ticket_id  CHAR(36) NOT NULL,
  station    VARCHAR(16) NOT NULL,

  -- open | done. A state, not a counter, so bumping twice is bumping once and
  -- a retried request over a flaky link cannot half-finish an order.
  status     VARCHAR(8) NOT NULL DEFAULT 'open',
  done_at    DATETIME NULL,
  done_by    VARCHAR(120) NULL,

  PRIMARY KEY (ticket_id, station),
  CONSTRAINT fk_kitchen_state_ticket FOREIGN KEY (ticket_id)
    REFERENCES epos_kitchen_tickets(id) ON DELETE CASCADE,
  INDEX idx_kitchen_state_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
