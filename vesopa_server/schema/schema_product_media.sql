-- An emoji and/or an uploaded image per product, shown on the till button.
ALTER TABLE bo_products
  ADD COLUMN emoji     VARCHAR(16)  NULL,
  ADD COLUMN image_url VARCHAR(500) NULL;
