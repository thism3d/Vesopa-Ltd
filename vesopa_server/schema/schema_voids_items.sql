-- Item-level voids.
--
-- The till used to void a whole sale, so "£12.40, wrong item rung up" told the
-- manager everything there was to know. It now voids selected lines, and an
-- amount on its own stops being an audit trail: two voids of £4.50 could be a
-- mis-keyed coffee or a bottle of wine walking out of the door.
--
-- `items` is a short human summary written by the till ("2x Flat White,
-- 1x Brownie"); `scope` distinguishes a part-void from cancelling the check.
ALTER TABLE epos_void_log
  ADD COLUMN items VARCHAR(500) NULL AFTER reason,
  ADD COLUMN scope VARCHAR(16)  NOT NULL DEFAULT 'sale' AFTER items;
