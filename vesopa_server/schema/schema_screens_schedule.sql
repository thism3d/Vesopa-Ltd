-- ===========================================================================
-- Scheduled screen changes (2026-09-24)
-- ===========================================================================
--
-- "Can we add a scheduler to screen programming? ICR Touch do this, where you
-- can schedule the changes to take effect on the date you choose."
--
-- One row per change a manager laid out and asked to go live later. `buttons`
-- is the whole layout as it was in the editor (JSON, the same shape
-- PUT /screens/:id/buttons takes), with the grid size it was drawn at. See
-- src/screen_schedules.js for why it is a copy rather than a diff.
--
-- effective_at is UTC, compared with UTC_TIMESTAMP(), so the server's time
-- zone never matters. `office` has the same collation as epos_screens.office
-- (utf8mb4_general_ci): the join between them must not mix collations.
--
-- status: pending -> applying -> applied | failed; or pending -> cancelled.
--
-- SORT ORDER. After schema_screens.sql, which creates epos_screens ('.' sorts
-- before '_'). No foreign key to epos_screens: a deleted screen marks its
-- pending changes failed with a reason, rather than making them vanish.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS epos_screen_schedules (
  id            CHAR(36)      NOT NULL,
  office        VARCHAR(190)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  screen_id     INT           NOT NULL,
  note          VARCHAR(160)  NULL,
  effective_at  DATETIME      NOT NULL,
  grid_rows     INT           NULL,
  grid_cols     INT           NULL,
  buttons       MEDIUMTEXT    NOT NULL,
  status        VARCHAR(12)   NOT NULL DEFAULT 'pending',
  error         VARCHAR(255)  NULL,
  created_by    VARCHAR(120)  NULL,
  created_at    DATETIME      NOT NULL,
  applied_at    DATETIME      NULL,
  PRIMARY KEY (id),
  KEY idx_screen_schedules_due (status, effective_at),
  KEY idx_screen_schedules_office (office, status, effective_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
