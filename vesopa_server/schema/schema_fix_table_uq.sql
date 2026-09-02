-- The unique key was (office_id, table_number), but office_id is NULL until
-- tenancy is wired through, and MySQL does not treat NULLs as equal in a
-- unique index — so every duplicate table number slipped through.
--
-- Key on room + number instead: a table number must be unique within its room,
-- which is what actually matters for placing a bill.
DELETE t1 FROM floor_tables t1
  JOIN floor_tables t2
    ON t1.room_id = t2.room_id
   AND t1.table_number = t2.table_number
   AND t1.id > t2.id;

ALTER TABLE floor_tables DROP INDEX uq_table_number;
ALTER TABLE floor_tables ADD UNIQUE KEY uq_room_table (room_id, table_number);
