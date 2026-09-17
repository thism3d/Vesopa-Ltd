-- Columns the public offers page needs on an existing database.
--
-- schema.sql is applied with CREATE TABLE IF NOT EXISTS, which does nothing to
-- a table that already exists, so a new column on a live install needs this.
-- Written with IF NOT EXISTS so it can be applied as many times as the deploy
-- runs -- the same rule the EPOS server's schema files follow.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS public_offer TINYINT(1) NOT NULL DEFAULT 0 AFTER first_order_only;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS headline VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER public_offer;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS countries VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER headline;
