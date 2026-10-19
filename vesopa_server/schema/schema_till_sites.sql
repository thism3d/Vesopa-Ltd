-- ---------------------------------------------------------------------------
-- Sites within a venue (2026-10-19). Re-runnable.
--
-- Meirion: some customers have two tills on a site, some six or more, and some
-- (Carmarthen Council, Pembrey Country Park) have tills a couple of miles
-- apart. They need to see what the venue takes as a whole, or one site, or one
-- till. A site is a named group of tills; every sale already records its till
-- (epos_orders.terminal), so grouping the tills is all that is stored here.
--
-- Nothing changes for a venue that sets up no sites: its figures read exactly
-- as before, every till under "All sites".
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bo_till_sites (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  address     VARCHAR(160) NULL,
  colour      VARCHAR(9)   NULL,
  sort        INT          NOT NULL DEFAULT 0,
  created_by  VARCHAR(255) NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_till_sites_office (office)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- A till's friendly name and its site. Keyed on the name the till records on
-- every sale (epos_orders.terminal: the computer's name), so it applies to
-- every sale that till has ever taken.
CREATE TABLE IF NOT EXISTS bo_till_names (
  office      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  terminal    VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  label       VARCHAR(80)  NULL,
  site_id     INT          NULL,
  updated_by  VARCHAR(255) NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (office, terminal),
  KEY idx_till_names_site (office, site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
