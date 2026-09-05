-- ---------------------------------------------------------------------------
-- One Apple pass per server, and the venue it belonged to
-- ---------------------------------------------------------------------------
--
-- `epos_wallet_passes.object_id` is the Google object id and carries
-- `UNIQUE KEY uq_wallet_object`. It was declared NOT NULL, and a pass with no
-- Google object -- an Apple-only card, or one issued before Google was set up --
-- was written as ''.
--
-- MySQL lets a unique index hold any number of NULLs and exactly one ''. So the
-- second Apple-only pass issued ANYWHERE on this server collided with the first,
-- and the insert's ON DUPLICATE KEY UPDATE quietly overwrote it. The collision
-- is on object_id alone, so it crossed venues: one office's card record was
-- taken over by another office's, along with its apple_serial -- which is the
-- id the pass already installed on somebody's phone identifies itself by, so
-- that pass then stopped being recognised and stopped updating.
--
-- The visible symptom was a venue reporting that passes were being issued and
-- could not be seen. That was exactly right: their row had been taken.
--
-- Two changes, and the order matters. The column has to accept NULL before the
-- rows holding '' can be moved to it.
--
-- Runs after schema_wallet.sql by name, which is where the table is created.
-- Sorted after schema_wallet_copy.sql and before schema_wallet_programs.sql;
-- neither touches this column, so the position is safe either way.

-- MariaDB has no `MODIFY COLUMN IF ...`, and re-running MODIFY is harmless: it
-- rewrites the column to the definition it already has. Guarded only against
-- the table not existing at all, which is a server that has not run
-- schema_wallet.sql yet and has nothing to migrate.
DROP PROCEDURE IF EXISTS vesopa_wallet_object_null;
DELIMITER $$
CREATE PROCEDURE vesopa_wallet_object_null()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'epos_wallet_passes'
  ) THEN
    ALTER TABLE epos_wallet_passes
      MODIFY object_id VARCHAR(255) CHARACTER SET utf8mb4
             COLLATE utf8mb4_general_ci NULL DEFAULT NULL;

    -- Every pass that never had a Google object. After this they no longer
    -- collide with each other, and a venue can hold as many Apple-only cards as
    -- it has customers.
    UPDATE epos_wallet_passes SET object_id = NULL WHERE object_id = '';
  END IF;
END $$
DELIMITER ;

CALL vesopa_wallet_object_null();
DROP PROCEDURE IF EXISTS vesopa_wallet_object_null;
