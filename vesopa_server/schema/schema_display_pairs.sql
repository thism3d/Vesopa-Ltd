-- ---------------------------------------------------------------------------
-- Customer displays on another computer (2026-10-17)
-- ---------------------------------------------------------------------------
--
-- The owner: "Display might be used on another computer". Until now a display
-- paired with a till through a folder on the same PC. A display on a different
-- machine pairs through the back office instead (src/display_link.js): the
-- display shows its four-digit code, the till connects it, and this row is
-- what both ends find again after a restart. Basket, settings and status then
-- travel over the back office's WebSocket, between this till and its displays
-- only.

CREATE TABLE IF NOT EXISTS epos_display_pairs (
  office          VARCHAR(191) CHARACTER SET utf8mb4
                  COLLATE utf8mb4_general_ci NOT NULL,
  display_device  VARCHAR(64) NOT NULL,
  display_name    VARCHAR(120) NULL,
  terminal_device VARCHAR(64) NOT NULL,
  terminal_name   VARCHAR(120) NULL,
  paired_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (office, display_device),
  KEY idx_display_pairs_terminal (office, terminal_device)
);
