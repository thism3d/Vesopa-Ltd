-- Explicit display order for the programming tables the back office lets you
-- drag to reorder. bo_finalise_keys already has sort_order; the rest gain one
-- here. Seeded from the current id order so existing rows keep their order the
-- first time the screen loads.
ALTER TABLE bo_tax_rates            ADD COLUMN sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE bo_error_reasons        ADD COLUMN sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE bo_vouchers             ADD COLUMN sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE bo_mix_match            ADD COLUMN sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE bo_product_departments  ADD COLUMN sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE bo_product_groups       ADD COLUMN sort_order INT NOT NULL DEFAULT 0;

-- Seed each row's order from its id so nothing jumps around on first paint.
UPDATE bo_tax_rates           SET sort_order = id WHERE sort_order = 0;
UPDATE bo_error_reasons       SET sort_order = id WHERE sort_order = 0;
UPDATE bo_vouchers            SET sort_order = id WHERE sort_order = 0;
UPDATE bo_mix_match           SET sort_order = id WHERE sort_order = 0;
UPDATE bo_product_departments SET sort_order = id WHERE sort_order = 0;
UPDATE bo_product_groups      SET sort_order = id WHERE sort_order = 0;
