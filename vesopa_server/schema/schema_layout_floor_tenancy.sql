-- Reconnect floor plans to their office.
--
-- The designer's create routes never set `office_id`, so every room and table
-- drawn in the back office was saved with a NULL office. The till reads
-- /till/floor, which joins office_id -> offices.contact_email, so those rows
-- matched no office and never reached a terminal: the "table plan is not
-- syncing with the back office" report. src/programming.js now sets the office
-- on write; this repairs what the old code already orphaned.
--
-- A table always belongs to its room's office, so tables are fixed from rooms.
UPDATE floor_tables t
  JOIN floor_rooms r ON r.id = t.room_id
   SET t.office_id = r.office_id
 WHERE t.office_id IS NULL
   AND r.office_id IS NOT NULL;

-- Rooms that are still orphaned can only be attributed when there is exactly
-- one office to attribute them to. On a multi-tenant install this deliberately
-- does nothing rather than guessing and handing one venue another's layout —
-- those rooms need assigning by hand.
UPDATE floor_rooms
   SET office_id = (SELECT id FROM offices LIMIT 1)
 WHERE office_id IS NULL
   AND (SELECT COUNT(*) FROM offices) = 1;

-- Then sweep the tables again, for rooms the statement above just adopted.
UPDATE floor_tables t
  JOIN floor_rooms r ON r.id = t.room_id
   SET t.office_id = r.office_id
 WHERE t.office_id IS NULL
   AND r.office_id IS NOT NULL;
