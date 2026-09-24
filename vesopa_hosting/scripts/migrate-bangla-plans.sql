-- Bangla for the copy that lives in the database, not in the i18n catalogue.
--
-- A plan's name, tagline, badge and feature list are text an admin types.
-- They are not translatable keys, so `npm run i18n:check` reported the Bangla
-- "complete" while the Bangla home page went on saying "Starter", "One
-- website, done properly." and seven English feature lines in the middle of a
-- Bangla page. The same is true of an email plan's name and features.
--
-- Written with IF NOT EXISTS so the deploy can apply it every time.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS name_bn VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER name;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tagline_bn VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER tagline;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS badge_bn VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER badge;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS features_bn TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL AFTER features;

ALTER TABLE email_plans ADD COLUMN IF NOT EXISTS name_bn VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER name;
ALTER TABLE email_plans ADD COLUMN IF NOT EXISTS tagline_bn VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '' AFTER tagline;
ALTER TABLE email_plans ADD COLUMN IF NOT EXISTS features_bn TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL AFTER features;
