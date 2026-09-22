-- ---------------------------------------------------------------------------
-- menu.vesopa.com: the public page's editable content.
--
-- The page itself is src/menu_site.js. What an administrator changes at
-- menu.vesopa.com/admin -- the plans and their prices, the VAT line, the
-- contact address, the demo venue and the kitchen app link -- is one JSON document here, so a
-- new field is a change to the page and its editor, never a migration.
-- With no row, the page shows the defaults written in loyalty_site.js.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS menu_site_settings (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  content     LONGTEXT     NOT NULL,
  updated_by  VARCHAR(190) NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
