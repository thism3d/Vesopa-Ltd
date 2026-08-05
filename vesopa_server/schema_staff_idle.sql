-- Idle screen, staff sign-on, and per-line staff attribution (v1.3.1.0).
--
-- Target is MySQL 5.7 / MariaDB, neither of which has `ADD COLUMN IF NOT
-- EXISTS` everywhere we need it, so column additions go through the same guard
-- procedure the other migrations use. Safe to re-run.
--
-- Collation note: `office` is an email address, and every email column in this
-- database that gets joined to another one has to agree on collation. The live
-- server's default for a bare `utf8mb4` column is `uca1400_ai_ci`, which does
-- not compare against the `utf8mb4_general_ci` that backoffice_users.email and
-- bo_clarks.email use — an "Illegal mix of collations" error that never shows
-- up on a dev box with different server defaults. So it is stated explicitly
-- here rather than inherited.

-- ---------------------------------------------------------------------------
-- Idempotent column adder.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
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

-- ---------------------------------------------------------------------------
-- Till behaviour, per office (tenant). One row, created on first save.
--
-- Separate from epos_branding, which is "what the venue prints around the
-- sale". This is how the terminal behaves between sales — a different thing on
-- a different clock, and a venue that changes its idle picture should not be
-- rewriting its VAT number's row to do it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_till_settings (
  office              VARCHAR(190) CHARACTER SET utf8mb4
                      COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,

  -- Idle screen (the screen saver).
  idle_enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  -- Uploaded via /api/till-settings/idle-image. NULL means the built-in
  -- branded Vesopa screen, which is drawn rather than loaded and so can never
  -- fail to render.
  idle_image_url      VARCHAR(255) NULL,
  -- Show it as soon as a sale completes, not only after the inactivity timer.
  idle_after_sale     TINYINT(1)   NOT NULL DEFAULT 1,
  -- Whether touching the idle screen asks for a PIN, or just returns to the
  -- till. Off is for fast-service counters where a PIN per customer costs more
  -- than the attribution is worth.
  idle_require_pin    TINYINT(1)   NOT NULL DEFAULT 1,
  -- Optional line under the logo, e.g. "Touch to begin".
  idle_message        VARCHAR(160) NOT NULL DEFAULT 'Touch to begin',

  -- Sign the current staff member off after this many seconds of no touching.
  -- 0 disables it. Advisory only: it never closes the cash session and never
  -- discards the bill on screen.
  signoff_seconds     INT          NOT NULL DEFAULT 180,

  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Per-line staff attribution.
--
-- A bill saved to a table and added to across a shift needs to show who put
-- each item on it and when — otherwise "who rang this up?" has one answer per
-- sale, which is no answer at all on a table that three people served.
--
-- Nullable, so lines already in the database and tills on the previous version
-- keep inserting exactly as before.
-- ---------------------------------------------------------------------------
-- The COLLATE is not optional, and not only on columns that hold an email.
-- `added_by` holds a staff name, and the obvious report to write against it
-- groups sales by that name joined to bo_clarks.clark_name — which is
-- utf8mb4_general_ci. Declared bare, this column inherits the live server's
-- utf8mb4 default of uca1400_ai_ci, that join becomes "Illegal mix of
-- collations", and none of it reproduces on a dev box with different defaults.
CALL vesopa_add_column(
  'epos_order_lines', 'added_by',
  'VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL');
CALL vesopa_add_column('epos_order_lines', 'added_at', 'DATETIME NULL');

-- Which staff member (bo_clarks.id) served the sale, alongside the clerk_name
-- that already prints on the receipt. The id is what a report should group by;
-- a name can be edited or repeated.
CALL vesopa_add_column('epos_orders', 'staff_id', 'INT NULL');

-- ---------------------------------------------------------------------------
-- Repair, for the run where `added_by` was created without its COLLATE.
--
-- vesopa_add_column only ever *adds*, so correcting the DDL above does nothing
-- to a column that already exists — this is what actually moves it. Fires only
-- when the collation is wrong, so it is a no-op on every subsequent run and can
-- never fire twice against a table that has grown.
--
-- MODIFY restates the whole type, so the length and nullability are repeated
-- exactly as declared above; getting either wrong here would truncate data.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS vesopa_fix_added_by_collation;
DELIMITER //
CREATE PROCEDURE vesopa_fix_added_by_collation()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'epos_order_lines'
      AND COLUMN_NAME = 'added_by'
      AND COLLATION_NAME <> 'utf8mb4_general_ci'
  ) THEN
    ALTER TABLE epos_order_lines
      MODIFY added_by VARCHAR(80) CHARACTER SET utf8mb4
             COLLATE utf8mb4_general_ci NULL;
  END IF;
END //
DELIMITER ;
CALL vesopa_fix_added_by_collation();
DROP PROCEDURE IF EXISTS vesopa_fix_added_by_collation;

-- ---------------------------------------------------------------------------
-- bo_clarks is a legacy table this project does not own the DDL for (it
-- predates both apps and vesopa_web's admin panel still writes to it), so it
-- is only extended, never redefined.
--
-- `active` lets a venue retire someone without deleting the rows their sales
-- are attributed to.
-- ---------------------------------------------------------------------------
-- Single-quoted like every other call in this file: with ANSI_QUOTES enabled a
-- double-quoted literal is read as an identifier, and the ALTER would fail.
CALL vesopa_add_column('bo_clarks', 'active', 'TINYINT(1) NOT NULL DEFAULT 1');

DROP PROCEDURE IF EXISTS vesopa_add_column;
