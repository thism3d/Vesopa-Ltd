-- ---------------------------------------------------------------------------
-- Vesopa Go is licensed per venue: a venue has no Go seats until it is offered
-- them (src/licences.js, OPT_IN). The owner turned it on for The Vesopa Kitchen
-- (office 9, the test venue) on 2026-10-27: ten devices. Re-runnable: it adds
-- the row only when the venue has none, and never changes or removes one.
-- More venues are given Go from admin.vesopa.com (Licences), not here.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO bo_licence_limits (office, kind, seats, updated_by)
SELECT contact_email, 'go', 10, 'Vesopa Go launch (The Vesopa Kitchen)'
  FROM offices
 WHERE id = 9 AND contact_email IS NOT NULL AND contact_email <> '';
