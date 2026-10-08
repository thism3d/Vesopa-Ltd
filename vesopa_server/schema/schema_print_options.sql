-- Paper and cutting, the venue's Standard print mode (2026-10-08).
--
-- "The paper is not cutting and no Z report, it's just blank." (Pontardawe
-- RFC, an Xprinter 80mm.) The fault itself was the till's printer connection;
-- this is the other half of the ask: "more printing options, but a default
-- mode for easy operating". Every till printer starts on Standard, and
-- Standard follows these three. A printer that needs something else is set
-- to Custom on its own till.
--
-- On the venue's existing epos_branding row (the Receipt Designer), like the
-- kitchen columns in schema_kitchen_branding.sql. Defaults are what a till
-- does with no setting at all, so deploying this changes no venue's paper.
-- Safe to re-run: MariaDB (the live box) has ADD COLUMN IF NOT EXISTS.

-- full | partial | none
ALTER TABLE epos_branding ADD COLUMN IF NOT EXISTS print_cut VARCHAR(8) NOT NULL DEFAULT 'full';
-- Lines fed before the cut, 0 to 12.
ALTER TABLE epos_branding ADD COLUMN IF NOT EXISTS print_feed_lines TINYINT UNSIGNED NOT NULL DEFAULT 5;
-- ESC B on kitchen tickets, for a printer with a buzzer.
ALTER TABLE epos_branding ADD COLUMN IF NOT EXISTS kitchen_beep TINYINT(1) NOT NULL DEFAULT 0;
