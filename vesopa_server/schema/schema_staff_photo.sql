-- ---------------------------------------------------------------------------
-- A photo per member of staff (2026-10-27, owner): uploaded in the back office
-- (Staff > Edit), shown when they sign on, on the till and in Vesopa Go.
-- Re-runnable: adds the column only when it is missing; nothing is removed.
-- ---------------------------------------------------------------------------
ALTER TABLE bo_clarks ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500) NULL;
