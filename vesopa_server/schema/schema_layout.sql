-- Floor plan: rooms, and the tables positioned within them.
--
-- The designer in the back office writes these rows; the till reads them and
-- renders the same plan. Position is stored so the two always agree — a table
-- the manager drags to the window appears at the window on every terminal.

CREATE TABLE IF NOT EXISTS floor_rooms (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  office_id  INT NULL,
  name       VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rooms_office (office_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS floor_tables (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  room_id     INT NOT NULL,
  office_id   INT NULL,

  -- What the clerk taps. Unique per office: two tables called "5" in one venue
  -- would make a bill impossible to place.
  table_number INT NOT NULL,
  label        VARCHAR(60) NULL,

  -- Position and size on the plan, in grid units rather than pixels, so the
  -- layout survives being rendered on a phone, a tablet and a desktop till at
  -- different scales.
  pos_x   INT NOT NULL DEFAULT 0,
  pos_y   INT NOT NULL DEFAULT 0,
  width   INT NOT NULL DEFAULT 2,
  height  INT NOT NULL DEFAULT 2,

  shape   ENUM('rect','circle') NOT NULL DEFAULT 'rect',
  seats   INT NOT NULL DEFAULT 4,

  CONSTRAINT fk_table_room FOREIGN KEY (room_id)
    REFERENCES floor_rooms(id) ON DELETE CASCADE,
  -- Keyed on the room, NOT on office_id: office_id is nullable, and MySQL does
  -- not treat NULLs as equal in a unique index, so a (office_id, table_number)
  -- key would let every duplicate through.
  UNIQUE KEY uq_room_table (room_id, table_number),
  INDEX idx_tables_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Programming tables the back office needs but the schema never had.

CREATE TABLE IF NOT EXISTS bo_tax_rates (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  office_id  INT NULL,
  name       VARCHAR(80) NOT NULL,
  percentage DOUBLE NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_finalise_keys (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  office_id  INT NULL,
  name       VARCHAR(80) NOT NULL,
  -- cash | card | voucher | account
  kind       VARCHAR(32) NOT NULL DEFAULT 'cash',
  opens_drawer TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_error_reasons (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  office_id INT NULL,
  reason    VARCHAR(160) NOT NULL,
  -- Which action it explains: void | refund | no_sale | discount
  applies_to VARCHAR(32) NOT NULL DEFAULT 'void'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Buy-any-N-for-£X style promotions.
CREATE TABLE IF NOT EXISTS bo_mix_match (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  office_id     INT NULL,
  name          VARCHAR(120) NOT NULL,
  -- How many qualifying items must be in the basket.
  trigger_qty   INT NOT NULL DEFAULT 2,
  -- The price they are sold for together, in pence.
  deal_price_minor INT NOT NULL DEFAULT 0,
  active        TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_mix_match_products (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  mix_match_id INT NOT NULL,
  plu_id       INT NOT NULL,
  CONSTRAINT fk_mm FOREIGN KEY (mix_match_id)
    REFERENCES bo_mix_match(id) ON DELETE CASCADE,
  UNIQUE KEY uq_mm_plu (mix_match_id, plu_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bo_vouchers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  office_id     INT NULL,
  code          VARCHAR(60) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  -- percent | amount
  discount_type VARCHAR(16) NOT NULL DEFAULT 'percent',
  -- Percentage points, or pence, depending on discount_type.
  value         INT NOT NULL DEFAULT 0,
  expires_on    DATE NULL,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_voucher_code (office_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- The defaults a UK venue needs on day one, rather than empty programming
-- screens.
--
-- ONLY ON A TABLE THAT HAS NEVER BEEN SEEDED.
--
-- These were `INSERT IGNORE ... VALUES (1, …)`, keyed on the primary key, and
-- that is not the guard it looks like. schema_tenant_programming.sql copies
-- every unowned row out to each venue and then deletes the unowned ones — so by
-- the next deploy ids 1..4 are free again, IGNORE ignores nothing, and the four
-- template rows are recreated and copied out once more.
--
-- In steady state that is merely wasteful. What makes it wrong is a venue that
-- deletes a default it does not want: "Customer changed their mind" comes back
-- on the next deploy, and comes back every deploy, and nobody can make it stop.
-- That is the "same data being manipulated again and again" that was reported.
--
-- Guarded on the table being empty instead. A fresh install seeds; an
-- established platform is left alone, including the deletions it has made.
-- Re-runnable, which the deploy requires: every schema file is replayed on
-- every deploy and failures are swallowed, so a guard that throws would be a
-- guard nobody hears about.
-- ---------------------------------------------------------------------------
INSERT INTO bo_tax_rates (id, name, percentage, is_default)
SELECT * FROM (
  SELECT 1 AS id, 'Standard VAT' AS name, 20 AS percentage, 1 AS is_default
  UNION ALL SELECT 2, 'Reduced VAT', 5, 0
  UNION ALL SELECT 3, 'Zero rated', 0, 0
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM bo_tax_rates);

INSERT INTO bo_finalise_keys (id, name, kind, opens_drawer, sort_order)
SELECT * FROM (
  SELECT 1 AS id, 'Cash' AS name, 'cash' AS kind, 1 AS opens_drawer, 1 AS sort_order
  UNION ALL SELECT 2, 'Card', 'card', 0, 2
  UNION ALL SELECT 3, 'Voucher', 'voucher', 0, 3
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM bo_finalise_keys);

INSERT INTO bo_error_reasons (id, reason, applies_to)
SELECT * FROM (
  SELECT 1 AS id, 'Customer changed their mind' AS reason, 'void' AS applies_to
  UNION ALL SELECT 2, 'Rung up in error', 'void'
  UNION ALL SELECT 3, 'Item returned', 'refund'
  UNION ALL SELECT 4, 'Manager discount', 'discount'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM bo_error_reasons);
