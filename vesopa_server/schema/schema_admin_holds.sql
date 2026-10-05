-- Licence holds: a pause or a removal set from admin.vesopa.com (2026-10-05).
--
-- "I saw no way to add, remove or pause new licenses of everything including
-- every module and options." (owner, 2026-10-05)
--
-- One row per venue and item. The item is a device app (till, kitchen,
-- display, express), a module (module:memberships, module:gym_door,
-- module:vehicle_access) or the Loyalty app (loyalty_app).
--
-- A GRACE DAY, THEN IT STOPS. The owner chose this on 2026-10-05. A hold is
-- written with `grace_until` a day ahead; until then the devices say the
-- licence is paused and when it stops, and after it the item behaves as if it
-- were never sold. Nothing is deleted: resuming lifts the row and everything
-- the venue had is still there.
--
-- No row means no hold, which is every venue today, so deploying this changes
-- nothing until somebody pauses something. Safe to re-run.

CREATE TABLE IF NOT EXISTS bo_admin_holds (
  office       VARCHAR(190) NOT NULL,
  item         VARCHAR(40)  NOT NULL,
  -- paused (can be resumed) or removed (taken off the invoice as well).
  state        VARCHAR(8)   NOT NULL DEFAULT 'paused',
  reason       VARCHAR(255) NULL,
  held_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  grace_until  DATETIME     NOT NULL,
  held_by      VARCHAR(190) NULL,
  PRIMARY KEY (office, item)
);
