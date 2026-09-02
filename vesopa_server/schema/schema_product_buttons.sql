-- The till's local schema has these; MySQL never did, so button layout and
-- kitchen routing could be set on a terminal but never synced or managed
-- centrally. Stage 1 requires assigning products to specific buttons.
ALTER TABLE bo_products
  ADD COLUMN button_position INT NULL,
  ADD COLUMN button_color    VARCHAR(16) NULL,
  ADD COLUMN printer_route   VARCHAR(32) NULL;
