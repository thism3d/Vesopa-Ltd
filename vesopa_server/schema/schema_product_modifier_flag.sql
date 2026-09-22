-- A product that is only ever an answer.
--
-- "No ice", "Extra shot", "Well done". Real products with real PLUs, real tax
-- and sometimes a real price — but never a sale on their own. A clerk who rings
-- "No ice" onto an empty bill has made a mistake, and the till has had no way
-- to say so.
--
-- ---------------------------------------------------------------------------
-- Why this is not the modifier feature Vesopa already has
-- ---------------------------------------------------------------------------
-- `epos_modifier_groups` (schema_screens_modifiers.sql) is a *question a
-- product asks*: ring a gin, the till asks "which mixer?", the answer comes off
-- a screen of buttons. That is the right shape when the venue knows in advance
-- that every gin needs a mixer.
--
-- This is the other half, and the venue described it exactly: "you would select
-- say Vodka & Coke and then tap this in the check view and click no ice for it
-- to attach to this product". Nothing was asked. The clerk picked a line that
-- was already on the bill and said something about it — which is a thing that
-- happens after the fact, on any product, and cannot be expressed as a question
-- the product asks when it is rung.
--
-- Both exist, and neither replaces the other.
--
-- ---------------------------------------------------------------------------
-- Why a flag and not a table
-- ---------------------------------------------------------------------------
-- Everything downstream is already built. `epos_order_lines.is_modifier` and
-- `parentLineId` on the till carry it, `epos_kitchen_ticket_lines.is_modifier`
-- carries it to the board, and the receipt builder, the kitchen ticket and the
-- customer display all indent it (see schema_screens_modifiers_lines.sql). What
-- was missing was upstream: a way for the back office to say which products may
-- only ever arrive that way.
--
-- So one boolean on the product. Zero for every existing row, which is true:
-- before this, every product was sellable on its own.
--
-- ---------------------------------------------------------------------------
-- File name
-- ---------------------------------------------------------------------------
-- Sorts after schema.sql, which creates bo_products, and after
-- schema_commerce.sql ('co' < 'pr') which is where the other late product
-- columns went. It sits with schema_product_media.sql and
-- schema_product_printing.sql, which alter the same table for the same reason.
--
-- MySQL 5.7 / MariaDB have no ADD COLUMN IF NOT EXISTS, so this goes through
-- the usual guard and is safe to run on every deploy.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

CALL vesopa_add_column('bo_products', 'is_modifier',
                       'TINYINT(1) NOT NULL DEFAULT 0');

DROP PROCEDURE IF EXISTS vesopa_add_column;
