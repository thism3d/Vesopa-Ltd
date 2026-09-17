-- ---------------------------------------------------------------------------
-- A member's location is never stored (owner's decision, 2026-09-17).
--
-- "Offers when I'm nearby" used to keep each member's latest position --
-- latitude, longitude and accuracy -- for up to 24 hours, so a "near us now"
-- message could find who was close. The owner's privacy policy says the
-- location is used on the spot and never saved, so the code now does exactly
-- that: when the app sends a position, the server checks it against the
-- venue's own area there and then and throws the coordinates away. All it
-- keeps is a yes/no -- this member was near this venue at this time -- for
-- the three hours a nearby offer can use it (NEAR_HOURS in src/loyalty_app.js),
-- then that goes too.
--
-- epos_customer_locations is left in place, empty, so an older server still
-- running during a deploy does not fail; nothing writes to it any more.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS epos_customer_near (
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id  CHAR(36)     NOT NULL,
  near_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (office, customer_id),
  KEY idx_customer_near_at (near_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every position ever kept goes now.
DELETE FROM epos_customer_locations;
