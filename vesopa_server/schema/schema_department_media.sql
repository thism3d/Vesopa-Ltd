-- Pictures on category buttons.
--
-- Products have had `emoji` / `image_url` since schema_product_media.sql; the
-- departments that drive the till's right-hand category rail never did, so a
-- category could only ever be a word. A clerk finds "Coffee" by its picture far
-- faster than by reading a column of similar-length words mid-service.
--
-- `button_color` lets the office override the till's built-in per-category
-- colour, which until now was hardcoded by name and so only worked for the
-- handful of names the till happened to know.
-- `emoji` is explicitly utf8mb4. The table's own default is 3-byte utf8, which
-- cannot hold an emoji at all — MySQL rejects the write with
-- ER_TRUNCATED_WRONG_VALUE_FOR_FIELD rather than storing it. bo_products.emoji
-- is already utf8mb4 for the same reason; this matches it.
ALTER TABLE bo_product_departments
  ADD COLUMN emoji        VARCHAR(16) CHARACTER SET utf8mb4
                          COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN image_url    VARCHAR(500) NULL,
  ADD COLUMN button_color VARCHAR(16)  NULL;
