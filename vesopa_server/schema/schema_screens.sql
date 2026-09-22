-- Screen programming: a venue's own sale-screen layouts.
--
-- Two tables, and a column on the till-settings row saying which screen a
-- venue's tills open on. See vesopa_epos/docs/screen-programming.md for the
-- design, and for why the *Default* screen is deliberately not a row in here.
--
-- This file creates its own tables and alters nothing, which is what makes it
-- safe wherever `sort` happens to place it. That is not a given here:
--
--     schema_screens.sql        <- this file
--     schema_staff_idle.sql     <- epos_till_settings is created HERE, after us
--
-- 'sc' sorts before 'st', so anything in this file that touched
-- epos_till_settings would run before that table existed — failing on a fresh
-- database and succeeding on every server that already had it. Invisible in
-- testing, found by the first new venue. That is exactly the failure documented
-- in vesopa_epos_kitchen/docs/architecture.md under "The migration rename",
-- which cost a venue its printer names.
--
-- So the one column this feature needs on that row — `home_screen_id` — lives
-- in schema_till_screens.sql instead, with the four other migrations that
-- extend it.
--
-- Target is MySQL 5.7 / MariaDB. Everything is CREATE TABLE IF NOT EXISTS, so
-- deploy.sh can run it on every deploy.
--
-- Collation note, as in schema_kitchen.sql: `office` is an email address and
-- gets compared against columns that are utf8mb4_general_ci, so it is stated
-- explicitly rather than left to the server's default.

-- ---------------------------------------------------------------------------
-- A page of buttons.
--
-- Rows and columns are the screen's own, not the till's: a venue that wants a
-- dense 8x6 of spirits and a roomy 4x3 of food can have both, and each is laid
-- out into whatever space the terminal has. That is the whole reason buttons
-- are grid cells rather than pixel rectangles — see the design doc, §2.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_screens (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,

  name        VARCHAR(60) NOT NULL,

  -- Which till screen this lays out. Always 'sale' today.
  --
  -- Here from the first migration on purpose: the decision not to make the pay
  -- page programmable is a product decision, not a data one, and leaving room
  -- for it costs a column now against a migration later. See the design doc, §4.
  surface     VARCHAR(16) NOT NULL DEFAULT 'sale',

  grid_rows   TINYINT UNSIGNED NOT NULL DEFAULT 5,
  grid_cols   TINYINT UNSIGNED NOT NULL DEFAULT 6,

  sort_order  INT NOT NULL DEFAULT 0,

  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP,

  -- Per office, so two venues may both have a screen called "Drinks".
  UNIQUE KEY uq_screen_name (office, surface, name),
  INDEX idx_screen_office (office, surface, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- One button.
--
-- Every button on the screen is one of these, whatever it does — a product, a
-- jump to another page, or a till function. The reference back office proves
-- that vocabulary is sufficient: everything on its screen is one of them, and
-- the column of category buttons down its right-hand side is simply four page
-- links stacked, not a separate kind of thing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_screen_buttons (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  screen_id    INT NOT NULL,

  -- Denormalised from the screen so every read and every write can be scoped to
  -- one office without a join. The tenancy check is the thing that must never
  -- be accidentally omitted, so it is made cheap.
  office       VARCHAR(190) CHARACTER SET utf8mb4
               COLLATE utf8mb4_general_ci NOT NULL,

  grid_row     TINYINT UNSIGNED NOT NULL,
  grid_col     TINYINT UNSIGNED NOT NULL,
  row_span     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  col_span     TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- product | page | function | blank
  kind         VARCHAR(16) NOT NULL DEFAULT 'blank',

  -- kind = product. The catalogue's PLU rather than bo_products.id, because
  -- that is what the till rings up and what a re-imported catalogue preserves.
  -- Deliberately no foreign key: a product deleted in the back office must
  -- leave a button that says so, not take a row out from under a venue's
  -- layout. The till renders an unresolvable button as unavailable.
  plu_id       INT NULL,

  -- kind = page.
  target_screen_id INT NULL,

  -- kind = function. A short key the till maps to an action ('qty',
  -- 'price_check', 'discount'). A string rather than an enum so a till running
  -- an older build ignores a function it does not know instead of failing to
  -- parse the screen.
  function_key VARCHAR(32) NULL,

  -- Null means "use the product's or the page's own name". Set means the venue
  -- has typed something shorter — "1/2 PINTS" over a page called "Half Pints".
  label        VARCHAR(40) NULL,

  -- #RRGGBB, both. Null means the till's own palette decides, which is what
  -- keeps an unstyled screen looking like Vesopa rather than looking unfinished.
  fill         VARCHAR(7) NULL,
  ink          VARCHAR(7) NULL,

  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One button per cell. The editor works out spans, but the database is what
  -- guarantees two buttons cannot end up stacked on one cell by a lost race
  -- between two managers saving at once.
  UNIQUE KEY uq_button_cell (screen_id, grid_row, grid_col),
  INDEX idx_button_screen (screen_id),
  INDEX idx_button_office (office),

  -- The buttons go when the screen does. This is the one place a cascade is
  -- right: a button has no meaning without its screen.
  CONSTRAINT fk_button_screen FOREIGN KEY (screen_id)
    REFERENCES epos_screens (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
