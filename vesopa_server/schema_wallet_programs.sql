-- One row per programme a venue runs: its own look, its own words, its own code.
--
-- WHY THIS IS A TABLE AND NOT MORE COLUMNS
--
-- epos_wallet_settings holds what a venue is: its name, its logo, the colours
-- its cards default to. That is one row per office and it should stay one row
-- per office.
--
-- What this holds is one row per office *per programme*, because a venue
-- reasonably wants its gift card to look nothing like its staff pass -- gold
-- against charcoal, different wording on the back, its own artwork -- and five
-- sets of every field bolted onto the settings row would be forty columns most
-- of which are blank most of the time.
--
-- EVERY COLUMN IS NULLABLE, AND THAT IS THE DESIGN
--
-- NULL means "whatever the venue's default is", so a programme inherits from
-- epos_wallet_settings until somebody deliberately overrides one field. A venue
-- that never opens this screen has five programmes that all look like its brand,
-- which is the right default and costs no rows at all.
--
-- Sorts after schema_wallet.sql and schema_wallet_venue.sql, both of which it
-- reads. See schema_till_change_window.sql for why the filename is the ordering.
--
-- Target is MySQL 5.7 / MariaDB. Collations pinned: `office` joins against
-- columns written by older migrations, and MariaDB 11.4 resolves a bare utf8mb4
-- to utf8mb4_uca1400_ai_ci, which compares against nothing else without error.

CREATE TABLE IF NOT EXISTS epos_wallet_programs (
  office          VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- 'loyalty' | 'customer' | 'giftcard' | 'staff' | 'promo'. The same five
  -- keys PASS_TYPES uses in src/wallet_google.js, which is where the Apple
  -- identifier and the Google resource for each of them also live.
  kind            VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- The programme's own code, unique across every venue and every programme.
  -- This is what a poster for one specific card carries, and what the back
  -- office previews: /wallet/p/<code>. Unique so that a code identifies one
  -- programme at one venue and can never be ambiguous.
  --
  -- NULL until generated, never '' -- the unique index counts '' as a value and
  -- would let exactly one programme in the estate hold it.
  code            VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,

  -- What this programme is called on the card, when it differs from the venue's
  -- general programme name. "Crown Rewards" against "Crown Gift Card".
  program_name    VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,

  -- The three colours Apple takes and works none of out. NULL inherits.
  hex_background  VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,
  hex_foreground  VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,
  hex_label       VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,

  -- The band of artwork behind the headline value. A public https:// URL, or
  -- NULL for the Vesopa artwork this programme ships with.
  strip_url       VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,

  -- What this programme says on the back of its own card. A gift card's terms
  -- and a staff pass's terms have nothing to do with each other.
  terms           TEXT         CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,

  -- Shown on the lock screen when this programme's pass changes. Apple has no
  -- free-form push for passes: a notification exists only when a field value
  -- actually changes, and this is the sentence shown when it does. `%@` is
  -- replaced by the new value, which is Apple's placeholder and not a typo.
  change_message  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL,

  -- Whether this venue issues this programme at all. Mirrors the five
  -- <kind>_enabled switches already on epos_wallet_settings, which stay
  -- authoritative; this is here so the row can exist while the programme is off.
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,

  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (office, kind),
  UNIQUE KEY uq_wallet_program_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
