-- Dine-in: the venue's public address, its tables' public addresses, and the
-- orders customers place from their own phones.
--
-- THIS FILE MUST SORT AFTER schema_layout.sql. That is why it is called
-- schema_menu_dinein and not schema_dinein: deploy.sh applies these in `sort`
-- order, and this file ALTERs floor_rooms and floor_tables, which schema_layout
-- creates. Named schema_dinein it sorted between schema_devices and schema_dojo
-- — before those tables existed on a fresh install — and the deploy loop
-- swallows a failure with "(skipped: already applied or not needed)", so the
-- columns would simply never have appeared and nothing would have said so.
--
-- WHAT THIS IS FOR
--
-- A customer sits down, points their phone at the code on the table, reads the
-- menu, orders, and the till is told. No app to install, no account to make,
-- and — deliberately — no payment: the bill is settled at the till exactly as
-- it always was. See docs/dine-in.md.
--
-- THE ONE RULE THAT SHAPES EVERY TABLE HERE
--
-- Names change and ids do not.
--
-- A venue will rename itself, renumber its tables when it puts a partition in,
-- and re-letter the whole room for a wedding. Every one of those is ordinary,
-- and not one of them may invalidate a code already printed and stood on a
-- table, or detach an order from the table that placed it.
--
-- So nothing customer-facing is keyed on anything a human chooses:
--
--   * A table's public address is `floor_tables.public_id` — 32 random hex
--     characters, minted once, never reused, and never derived from the table
--     number. Renumber table 5 to 12 and its code still opens table 12.
--   * An order references `floor_tables.id`. Renaming, renumbering and moving
--     the table between rooms all leave the order pointing at the same table.
--   * The venue's slug is a *lookup*, not an identity. Change it and old links
--     stop resolving, which is the honest behaviour for a web address somebody
--     chose to change; the table codes, which carry `public_id` and not the
--     slug, keep working regardless.
--
-- The code on the table therefore outlives every rename the venue will ever do,
-- which is the whole point: it is printed, laminated and screwed down.

-- ---------------------------------------------------------------------------
-- The re-runnable column helper. deploy.sh --schema replays every file on every
-- deploy and promises that is safe, so nothing here may fail on a second run.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(512))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER //
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN spec VARCHAR(512))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND INDEX_NAME = idx
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD ', spec);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- The venue's public face.
-- ---------------------------------------------------------------------------
--
-- Its own table rather than more columns on `offices`, because `offices` is the
-- billing and tenancy record — who pays, whether they are suspended — and this
-- is marketing copy a manager edits on a Tuesday afternoon. Mixing the two puts
-- a venue's phone number in the same row as its suspension reason.
CREATE TABLE IF NOT EXISTS dinein_venue (
  office_id     INT NOT NULL PRIMARY KEY,

  -- The web address: vesopaepos.com/<slug>. Lower case, letters, digits and
  -- hyphens; the application enforces the shape, this enforces uniqueness.
  --
  -- Nullable, because a venue that has not chosen one has not chosen one, and
  -- MySQL lets any number of rows hold NULL in a unique index — which is the
  -- behaviour wanted here and the opposite of what was wanted on floor_tables.
  slug          VARCHAR(64) NULL,

  -- What the customer sees at the top of the menu. Not offices.name, which is
  -- the account name and is often the limited company rather than the pub.
  display_name  VARCHAR(160) NULL,
  tagline       VARCHAR(200) NULL,

  phone         VARCHAR(40) NULL,
  address_line  VARCHAR(255) NULL,
  postcode      VARCHAR(16) NULL,

  -- Somewhere to point "Find us" at. A URL rather than a lat/long pair,
  -- because every venue already has a Google or Apple Maps link for itself and
  -- none of them know their coordinates.
  map_url       VARCHAR(500) NULL,

  logo_url      VARCHAR(500) NULL,
  banner_url    VARCHAR(500) NULL,

  -- The one colour the public pages take their accent from.
  accent_colour VARCHAR(16) NOT NULL DEFAULT '#A5C715',

  -- Whether the public menu answers at all. A venue mid-setup, or one closed
  -- for refurbishment, turns this off and the page says so rather than taking
  -- orders nobody will cook.
  is_published  TINYINT(1) NOT NULL DEFAULT 0,

  -- Whether the menu takes orders, as opposed to only showing the menu. A venue
  -- may want the QR code live months before it is ready to have tickets
  -- arriving at the till, and "look but do not order" is a real state.
  ordering_open TINYINT(1) NOT NULL DEFAULT 0,

  -- Whether a customer must give a name and a number. Both optional by default,
  -- as asked: a dine-in order is attached to a table, and the table is standing
  -- in the room.
  require_name  TINYINT(1) NOT NULL DEFAULT 0,
  require_phone TINYINT(1) NOT NULL DEFAULT 0,

  -- Shown above the menu — "Kitchen closes at 9", "Allergen info at the bar".
  notice        VARCHAR(400) NULL,

  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_dinein_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Rooms that are not rectangles.
-- ---------------------------------------------------------------------------
--
-- The designer drew every room as a box, and real rooms are not boxes: an
-- L-shaped bar wrapping a corner is the commonest floor in the trade, and a
-- venue forced to draw it as a rectangle either loses the corner or gains a
-- quarter of the room that is actually the kitchen.
--
-- `outline` is a JSON array of grid points — [[0,0],[8,0],[8,4],[4,4],[4,7],[0,7]]
-- — walked in order and closed automatically. NULL keeps the old behaviour
-- exactly: a plain rectangle of `cols` x `rows`. Stored as text rather than as
-- MySQL's spatial types because the plan is a diagram, not geography, and
-- nothing will ever ask it a spatial question.
CALL vesopa_add_column('floor_rooms', 'outline', 'TEXT NULL');
CALL vesopa_add_column('floor_rooms', 'cols', 'INT NOT NULL DEFAULT 12');
CALL vesopa_add_column('floor_rooms', 'rows', 'INT NOT NULL DEFAULT 8');

-- ---------------------------------------------------------------------------
-- A table's public address, and its name.
-- ---------------------------------------------------------------------------
--
-- `public_id` is what goes in the QR code. Minted below for every table that
-- already exists, and by the application for every table created after this.
--
-- `name` is what the customer reads — "Booth 3", "Window", "The snug". The till
-- keeps using `table_number` to place a bill, because that is what a clerk taps
-- and it is an integer for good reasons; the name is a label on top of it, and
-- the two are allowed to disagree.
CALL vesopa_add_column('floor_tables', 'public_id', 'CHAR(32) NULL');
CALL vesopa_add_column('floor_tables', 'name', 'VARCHAR(60) NULL');

-- Whether this table takes orders from a phone at all. A venue with a code on
-- every table but a service bar it does not want ordering from turns this off
-- for that one.
CALL vesopa_add_column('floor_tables', 'qr_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');

-- Backfill, and then make it unique.
--
-- Two runs of this are safe: the UPDATE only touches rows that are still NULL,
-- and the unique key is added only when it is absent. The expression is
-- evaluated per row rather than once — a single scalar would give every table
-- the same value and the unique key would then refuse to be created, which is
-- at least the right kind of failure.
--
-- WHY NOT PLAIN UUID()
--
-- Because UUID() is version 1: a timestamp and the server's MAC address. Four
-- tables backfilled together come out as four ids sharing a suffix and
-- differing in the fourth byte, so anybody holding one printed card could read
-- off the codes of the tables either side of them and order onto either. That
-- defeats the only thing this column is for.
--
-- So: SHA2 of the UUID mixed with RAND() and the microsecond clock. The UUID is
-- what guarantees no two rows collide; RAND() is what stops the result being
-- derivable from a neighbouring id. Not RANDOM_BYTES, which would be the
-- obvious answer and needs MySQL 8.0.17 or MariaDB 10.10 — SHA2 has been in
-- both since 5.5, and this file has to apply to whatever the venue is running.
--
-- New tables do not come through here at all: the application mints theirs with
-- crypto.randomUUID(), which is version 4 and properly random. This is only for
-- the rows that already existed.
UPDATE floor_tables
   SET public_id = LEFT(
         SHA2(CONCAT(UUID(), RAND(), NOW(6), CONNECTION_ID(), id), 256), 32)
 WHERE public_id IS NULL OR public_id = '';

CALL vesopa_add_index('floor_tables', 'uq_table_public',
                      'UNIQUE KEY uq_table_public (public_id)');

-- ---------------------------------------------------------------------------
-- What is on the public menu.
-- ---------------------------------------------------------------------------
--
-- A separate menu rather than "every product in the catalogue", because the
-- catalogue contains bar tabs, staff meals, deposits, corkage and a PLU called
-- MISC — and a customer's phone is the one place none of those belong.
--
-- The venue picks what appears, in the order it should appear, with the wording
-- and the picture a customer should see rather than the twelve characters that
-- fit on a receipt.
CREATE TABLE IF NOT EXISTS dinein_sections (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  office_id  INT NOT NULL,

  name       VARCHAR(120) NOT NULL,

  -- The line under the heading — "Served 12 til 3", "All our pizzas are 12in".
  blurb      VARCHAR(300) NULL,

  -- One picture for the whole section, used as the tab image on the scroller.
  image_url  VARCHAR(500) NULL,

  sort_order INT NOT NULL DEFAULT 0,
  active     TINYINT(1) NOT NULL DEFAULT 1,

  INDEX idx_dinein_sections_office (office_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dinein_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  section_id  INT NOT NULL,
  office_id   INT NOT NULL,

  -- The catalogue product this rings up as. The price is read from the
  -- catalogue at order time and never from here: a menu that carried its own
  -- price would be a second price list to keep in step, and the one that went
  -- stale would be the one the customer is looking at.
  plu_id      INT NOT NULL,

  -- What the customer reads, when it should differ from the till button.
  -- "CHK BURG" on a key; "Buttermilk chicken burger" on a phone.
  name        VARCHAR(160) NULL,
  description VARCHAR(500) NULL,
  image_url   VARCHAR(500) NULL,

  -- Sold out for tonight, without deleting it from the menu. A manager taps
  -- this when the kitchen runs out and taps it back in the morning.
  available   TINYINT(1) NOT NULL DEFAULT 1,

  sort_order  INT NOT NULL DEFAULT 0,

  CONSTRAINT fk_dinein_item_section FOREIGN KEY (section_id)
    REFERENCES dinein_sections(id) ON DELETE CASCADE,
  INDEX idx_dinein_items_section (section_id, sort_order),
  INDEX idx_dinein_items_office (office_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- The orders themselves.
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT `orders`. A dine-in order is a *request* until a clerk
-- accepts it; the till's own order is a sale. Writing customer taps straight
-- into the sales tables would put unaccepted, mistaken and duplicate orders
-- into the day's takings, and no amount of status column makes that safe.
--
-- On acceptance the till rings the lines up as an ordinary sale against the
-- table, and this row records that it did. Two tables, one direction, no
-- ambiguity about which one the Z-read reads.
CREATE TABLE IF NOT EXISTS dinein_orders (
  id           INT AUTO_INCREMENT PRIMARY KEY,

  -- What the customer's "check my order" link carries. Random, like the table's
  -- — an order id a stranger could guess would show them somebody else's meal.
  public_id    CHAR(32) NOT NULL,

  office_id    INT NOT NULL,

  -- The table it came from, by internal id. See the note at the top of this
  -- file: this is what survives the table being renamed and renumbered.
  table_id     INT NULL,

  -- What the table was called at the moment the order was placed. Kept as a
  -- string as well as a reference, because a bill printed a week later should
  -- say where the food went even if the room has been re-lettered since.
  table_label  VARCHAR(60) NULL,

  customer_name  VARCHAR(120) NULL,
  customer_phone VARCHAR(40) NULL,
  note           VARCHAR(500) NULL,

  -- placed    : the customer has sent it; the till is showing a notification
  -- accepted  : a clerk has taken it; it is now a sale and is on its way
  -- ready     : the kitchen has made it
  -- served    : it is on the table
  -- rejected  : a clerk refused it, with a reason the customer can read
  -- cancelled : the customer withdrew it before anybody accepted
  status       ENUM('placed','accepted','ready','served','rejected','cancelled')
                 NOT NULL DEFAULT 'placed',
  status_note  VARCHAR(300) NULL,

  -- The sale this became, once a clerk accepted it. Null until then.
  order_id     VARCHAR(64) NULL,

  total_minor  INT NOT NULL DEFAULT 0,

  placed_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at  DATETIME NULL,
  ready_at     DATETIME NULL,
  served_at    DATETIME NULL,

  UNIQUE KEY uq_dinein_order_public (public_id),
  INDEX idx_dinein_orders_office (office_id, status, placed_at),
  INDEX idx_dinein_orders_table (table_id, placed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dinein_order_lines (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  dinein_order_id INT NOT NULL,

  plu_id        INT NOT NULL,

  -- Priced and named at the moment of ordering. The catalogue is the authority
  -- when the order is taken; after that this row is the record of what the
  -- customer was actually shown and charged, which is the thing a dispute is
  -- about.
  name          VARCHAR(160) NOT NULL,
  qty           INT NOT NULL DEFAULT 1,
  unit_price_minor INT NOT NULL DEFAULT 0,

  -- "No onions", "well done". Free text, shown on the kitchen ticket.
  note          VARCHAR(300) NULL,

  CONSTRAINT fk_dinein_line_order FOREIGN KEY (dinein_order_id)
    REFERENCES dinein_orders(id) ON DELETE CASCADE,
  INDEX idx_dinein_lines_order (dinein_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- The printed code.
-- ---------------------------------------------------------------------------
--
-- A saved design rather than a fixed template, because the thing being made is
-- a physical object that has to sit on a particular table in a particular room:
-- an A5 card on a stand, a 60mm sticker on a bar top, an A4 sheet on a wall.
--
-- One design serves many tables — the venue lays it out once and prints the set
-- — so the table's name and code are placeholders filled in at print time
-- rather than baked into the layout.
CREATE TABLE IF NOT EXISTS dinein_qr_designs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  office_id  INT NOT NULL,

  name       VARCHAR(120) NOT NULL,

  -- a4 | a5 | a6 | sticker80 | sticker60 | custom
  page_size  VARCHAR(24) NOT NULL DEFAULT 'a5',
  -- Millimetres, read only when page_size is 'custom'.
  page_w_mm  INT NOT NULL DEFAULT 148,
  page_h_mm  INT NOT NULL DEFAULT 210,

  background VARCHAR(16) NOT NULL DEFAULT '#FFFFFF',

  -- The elements on the card, as JSON: an ordered array of
  -- {kind, x, y, w, h, ...} where kind is one of qr | text | image | table_name
  -- | venue_name | link. Positions are percentages of the page, so one design
  -- prints correctly at every size it is ever sent to.
  --
  -- JSON rather than a row per element: a design is edited and saved whole, is
  -- never queried by element, and a table of fragments would need a
  -- transaction to stay consistent with itself.
  elements   MEDIUMTEXT NULL,

  is_default TINYINT(1) NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
               ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_dinein_designs_office (office_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
