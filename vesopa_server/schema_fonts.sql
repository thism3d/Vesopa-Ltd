-- Fonts a venue has uploaded for its own tills.
--
-- The sixteen built-in families are files in the tree (public/assets/fonts,
-- fetched by tool/fetch_fonts.js) and have no row here: they are the same for
-- every venue, they cannot be deleted, and a table row per venue per built-in
-- font would be sixteen rows of nothing.
--
-- This holds only what a venue added — its brand font — which is per-office,
-- deletable, and has to be looked up before anything can be served.
--
-- CREATE TABLE IF NOT EXISTS and nothing else, so this file is safe wherever
-- `sort` places it and safe to re-run on every deploy. Target is MySQL 5.7 /
-- MariaDB.
--
-- Collation stated explicitly, as in schema_screens.sql: `office` is an email
-- address compared against utf8mb4_general_ci columns elsewhere, and leaving it
-- to the server's default is how a join starts failing on one machine only.

CREATE TABLE IF NOT EXISTS epos_fonts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  office      VARCHAR(190) CHARACTER SET utf8mb4
              COLLATE utf8mb4_general_ci NOT NULL,

  -- What the manager sees, and what a button stores. Not the filename: two
  -- venues may both upload "Brand Sans" and each means its own file.
  family      VARCHAR(64) NOT NULL,

  -- The stable key a button holds and the till caches under. Slugged from the
  -- family on upload, and unique per office — so renaming the file on disk
  -- never orphans the buttons that point at it.
  slug        VARCHAR(64) NOT NULL,

  -- 400 or 700. A family is one row per weight, so a venue can upload a bold
  -- later without re-uploading the regular.
  weight      SMALLINT UNSIGNED NOT NULL DEFAULT 400,

  -- Under public/uploads/fonts. Kept rather than derived, because the
  -- extension varies (.ttf or .otf) and guessing it is how a font 404s.
  file_name   VARCHAR(190) NOT NULL,
  byte_size   INT UNSIGNED NOT NULL DEFAULT 0,

  -- Who to ask when a foundry writes. See public/assets/fonts/LICENSES.md for
  -- why an uploaded font is the venue's responsibility and not ours.
  uploaded_by VARCHAR(190) NULL,

  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One file per weight per family per venue. Re-uploading a weight replaces
  -- it rather than leaving two rows racing to be found first.
  UNIQUE KEY uq_font_weight (office, slug, weight),
  INDEX idx_font_office (office, family)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
