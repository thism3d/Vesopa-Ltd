-- Cash denominations: the note (or coin) keys a clerk taps when a customer
-- pays with cash, and the picture shown on each one.
--
-- Two levels, on purpose:
--   office_id IS NULL  -> the platform default set, seeded below with the Bank
--                         of England King Charles III specimen notes.
--   office_id = <id>   -> that office's own set, which replaces the defaults
--                         entirely once it has any rows.
--
-- A venue that never touches this gets working note keys out of the box; one
-- that deals in a different currency, or wants its own artwork, overrides them
-- without the defaults being edited underneath every other tenant.
--
-- Collation pinned for the same reason as everywhere else: on the live MariaDB
-- a bare `CHARSET=utf8mb4` resolves to uca1400_ai_ci, which will not compare
-- equal to the utf8mb4_unicode_ci on the older tables.

CREATE TABLE IF NOT EXISTS cash_denominations (
  id          INT AUTO_INCREMENT PRIMARY KEY,

  -- NULL is the platform default row. No FK: offices is InnoDB here but the
  -- NULL tenant is deliberately not a real office, so a constraint would have
  -- to be nullable anyway and buys nothing.
  office_id   INT NULL,

  -- Pence. £20 is 2000 — same convention as every other money column, so no
  -- floating point ever touches a denomination.
  value_minor INT NOT NULL,

  -- What the key says when there is no picture, e.g. "£20".
  label       VARCHAR(32) NOT NULL,

  -- Served from this app (/assets/notes/...) or an uploaded file
  -- (/uploads/...). NULL falls back to a plain coloured key on the till.
  image_url   VARCHAR(512) NULL,

  sort_order  INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP,

  -- One row per value per office, so a double POST cannot create two £20 keys.
  UNIQUE KEY uq_denom_office_value (office_id, value_minor),
  INDEX idx_denom_office (office_id, active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The defaults. INSERT IGNORE against the unique key, so re-running this
-- migration is safe and never overwrites artwork an operator has changed.
--
-- Descending order: the biggest note first, because that is the one most often
-- handed over for a bill of any size.
INSERT IGNORE INTO cash_denominations
  (office_id, value_minor, label, image_url, sort_order, active)
VALUES
  (NULL, 5000, '£50', '/assets/notes/gbp-50.jpg', 1, 1),
  (NULL, 2000, '£20', '/assets/notes/gbp-20.jpg', 2, 1),
  (NULL, 1000, '£10', '/assets/notes/gbp-10.jpg', 3, 1),
  (NULL,  500, '£5',  '/assets/notes/gbp-5.jpg',  4, 1);
