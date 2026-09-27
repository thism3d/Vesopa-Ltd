-- ===========================================================================
-- Each person's dashboard layout (2026-09-24)
-- ===========================================================================
--
-- "Be able to move widgets around on the dashboard, so customers can choose
-- what they see first." One row per venue and person: the cards in their
-- order, width and visibility, as JSON (see src/dashboard_layout.js and
-- public/dashboard.js). No foreign keys: a row for a person who has gone is
-- a few hundred bytes and harms nothing.
--
-- `office` in utf8mb4_general_ci like every other office column, so a join to
-- one never mixes collations. Re-runnable.

CREATE TABLE IF NOT EXISTS bo_dashboard_layouts (
  office      VARCHAR(190)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  person      VARCHAR(120)  NOT NULL,
  layout      TEXT          NOT NULL,
  updated_at  DATETIME      NOT NULL,
  PRIMARY KEY (office, person)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
