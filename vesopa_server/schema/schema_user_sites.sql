-- More than one site under one login.
--
-- "For customers who have more than one venue, they should be able to manage
-- all of their sites under one login, with a drop-down to select the site."
--
-- A login already has one office (backoffice_users.office_id), and every
-- back-office route finds its venue from the office in the signed session. So a
-- second site is a second office this login is allowed to switch its session
-- to, and nothing more: each site keeps its own products, prices, terminals and
-- hardware settings because every one of those is already keyed by its office.
-- See src/sites.js.
--
-- The home office is not repeated here; this table holds the extra sites.
-- Re-runnable, like every migration here.

CREATE TABLE IF NOT EXISTS bo_user_sites (
  user_id    INT          NOT NULL,
  office_id  INT          NOT NULL,
  added_by   VARCHAR(190) NULL,
  added_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, office_id),
  KEY idx_user_sites_office (office_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
