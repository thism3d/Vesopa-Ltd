-- Modifiers: the question a product asks before it goes on the bill.
--
-- "Which mixer with that gin?", "how would you like the steak?", "single or
-- double?". A product carries an ordered list of groups; each group is one
-- prompt on the till, and the answers hang off the sale line underneath the
-- product they belong to.
--
-- ---------------------------------------------------------------------------
-- Why there is no table of modifier options in here
-- ---------------------------------------------------------------------------
-- A modifier prompt is a grid of buttons. Vesopa already has a grid of
-- buttons: `epos_screens` and `epos_screen_buttons`, with an editor that lays
-- them out, colours them, spans them across cells and syncs them to a till.
-- Building a second, nearly identical table of options would mean a second
-- editor, a second sync path and two places to fix the next layout bug.
--
-- So a group *owns a screen*. `epos_screens.surface` was put there for exactly
-- this — its own comment says "Always 'sale' today", left deliberately so a
-- second kind of screen would cost a value rather than a migration. Modifier
-- screens are `surface = 'modifier'`, they never appear in the sale-screen
-- picker, and every button kind already defined works inside one: a product
-- button adds a priced modifier, a blank leaves a gap.
--
-- This is also how the reference back office does it. Its modifier group list
-- has an "Update Screen" key per row that opens the same button designer the
-- sale screens use, at a modifier-flavoured URL.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- `schema_screens_modifiers.sql`, not `schema_modifiers.sql`, and the reason is
-- the one schema_screens.sql warns about at length: these files run in sort
-- order, and 'mo' sorts *before* 'sc'. A foreign key to `epos_screens` from a
-- file named schema_modifiers.sql would run before that table existed —
-- working on every server that already had it, failing on every fresh
-- database. Named this way it sorts immediately after its parent, as
-- schema_screens_bars.sql already does.
--
-- Target is MySQL 5.7 / MariaDB. Everything is CREATE TABLE IF NOT EXISTS, so
-- deploy.sh can run it on every deploy.
--
-- Collation note, as in schema_screens.sql: `office` is an email address
-- compared against utf8mb4_general_ci columns, so it is stated explicitly
-- rather than left to the server's default.

-- ---------------------------------------------------------------------------
-- One question.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_modifier_groups (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,

  -- What the till puts at the top of the prompt: "Mixers", "How is it cooked?".
  name        VARCHAR(60) NOT NULL,

  -- How many answers this question will accept.
  --
  -- These two numbers are the whole behaviour of the prompt, and the till reads
  -- them rather than a pile of booleans:
  --
  --   min_select = 0  the prompt can be dismissed. The till shows Skip.
  --   min_select > 0  it cannot. Skip is not offered and Done stays disabled
  --                   until enough is chosen.
  --   max_select = 1  choosing an answer *is* the confirmation — the prompt
  --                   closes on the tap and the next group opens. This is the
  --                   common case and the reason a mixer takes one press.
  --   max_select > 1  answers accumulate and the operator presses Done.
  --
  -- 0 for max_select means no ceiling: "any of these, as many as you like".
  min_select  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_select  TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- The grid of answers. Null is a group nobody has laid out yet: it is a valid
  -- state — the venue made the group and has not filled it in — and the till
  -- treats an empty group as nothing to ask and moves on, rather than stalling
  -- the sale on an empty box.
  --
  -- SET NULL rather than CASCADE: deleting a layout must not delete the
  -- question, or a mis-click in the screen editor would silently unhook the
  -- modifiers from every product using this group.
  screen_id   INT NULL,

  sort_order  INT NOT NULL DEFAULT 0,

  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP,

  -- Per office, so two venues may both have a group called "Mixers".
  UNIQUE KEY uq_modifier_group_name (office, name),
  INDEX idx_modifier_group_office (office, sort_order),

  CONSTRAINT fk_modifier_group_screen FOREIGN KEY (screen_id)
    REFERENCES epos_screens (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Which questions a product asks, and in what order.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_product_modifiers (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,

  -- The catalogue's PLU, not bo_products.id — the same choice, for the same
  -- reason, as epos_screen_buttons.plu_id: it is what the till rings up and
  -- what survives a re-imported catalogue. Deliberately no foreign key, so a
  -- product deleted in the back office cannot take a venue's modifier wiring
  -- with it.
  plu_id      INT NOT NULL,

  group_id    INT NOT NULL,

  -- Groups chain in this order: singles-or-doubles before the mixer, because
  -- that is the order the bar asks in. Ordering is the point of this column
  -- and the reason this is not a comma-separated field on the product.
  sort_order  INT NOT NULL DEFAULT 0,

  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Asking the same question twice about one product is always a mistake.
  UNIQUE KEY uq_product_modifier (office, plu_id, group_id),
  INDEX idx_product_modifier_plu (office, plu_id, sort_order),

  -- The link goes when the question does.
  CONSTRAINT fk_product_modifier_group FOREIGN KEY (group_id)
    REFERENCES epos_modifier_groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
