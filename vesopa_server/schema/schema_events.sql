-- Events & tickets: matches and club nights, tickets bought online, the gate.
--
-- The Events & tickets module (src/modules.js, src/events.js). Asked for by
-- Pontardawe RFC (2026-10-11): tickets for home matches and events bought on
-- pontardawerfc.com, with the club managing them in the back office and the
-- till scanning them at the gate.
--
--   epos_events               a match or an event, on a day, at a place
--   epos_event_ticket_types   what it sells: Adult, Junior, Member...
--   epos_event_orders         one purchase, paid online (Dojo) or issued here
--   epos_event_tickets        one ticket each, with the code its QR carries
--   epos_event_settings       per venue: its WRU club and its website
--
-- `office` is the venue's contact email, as in every memberships table, so
-- the till's token (which carries it) needs no lookup. Times are UK local
-- wall-clock DATETIMEs: a 2:30 kick-off is 14:30 whatever the server's clock
-- says, which is how the WRU publishes them and how the club reads them.
--
-- Re-runnable: the deploy applies every file in this folder on every deploy.

CREATE TABLE IF NOT EXISTS epos_events (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  title          VARCHAR(160) NOT NULL,
  description    TEXT         NULL,
  kind           VARCHAR(8)   NOT NULL DEFAULT 'event',
  starts_at      DATETIME     NOT NULL,
  ends_at        DATETIME     NULL,
  location       VARCHAR(200) NULL,
  image_url      VARCHAR(500) NULL,
  on_sale        TINYINT(1)   NOT NULL DEFAULT 0,
  published      TINYINT(1)   NOT NULL DEFAULT 0,
  -- The WRU's fixture id for a match brought in from its fixture list, so a
  -- second import moves the kick-off rather than adding the match twice.
  -- NULL for anything made by hand; MySQL lets any number of rows hold NULL
  -- in a unique index.
  wru_fixture_id INT          NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_events_wru (office, wru_fixture_id),
  KEY idx_events_office (office, starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- `capacity` NULL is unlimited. What counts against it is every ticket of a
-- paid order plus what pending orders younger than half an hour have asked
-- for (src/events.js), so two people cannot both be sold the last ticket
-- while one of them is on the card page.
CREATE TABLE IF NOT EXISTS epos_event_ticket_types (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  event_id       INT          NOT NULL,
  name           VARCHAR(80)  NOT NULL,
  price_minor    INT          NOT NULL DEFAULT 0,
  capacity       INT          NULL,
  max_per_order  INT          NOT NULL DEFAULT 10,
  sort           INT          NOT NULL DEFAULT 0,
  KEY idx_ett_event (event_id, sort)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per purchase. `public_id` is what the buyer's browser holds (the
-- return page reads the order by it), so it is random and unguessable.
-- `items` is what was asked for, as JSON [{ticket_type_id, qty, price_minor}];
-- the tickets themselves are only made once the order is paid. `applied_at`
-- is claimed with a conditional UPDATE so tickets are issued, and emailed,
-- once however many times the return page is opened.
CREATE TABLE IF NOT EXISTS epos_event_orders (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  public_id      CHAR(32)     NOT NULL,
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL,
  event_id       INT          NOT NULL,
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40)  NULL,
  items          TEXT         NULL,
  total_minor    INT          NOT NULL DEFAULT 0,
  status         VARCHAR(12)  NOT NULL DEFAULT 'pending',
  source         VARCHAR(12)  NOT NULL DEFAULT 'online',
  dojo_intent_id VARCHAR(80)  NULL,
  issued_by      VARCHAR(190) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at        DATETIME     NULL,
  applied_at     DATETIME     NULL,
  UNIQUE KEY uq_eorders_public (public_id),
  KEY idx_eorders_event (event_id, status),
  KEY idx_eorders_office (office, created_at),
  KEY idx_eorders_intent (dojo_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- `code` is ten characters of base32 (no 0/O, 1/I), which is what the QR
-- carries as "VT:<code>" and what a steward can type when a phone screen will
-- not scan. `checked_in_at` is set once, by a conditional UPDATE: a second
-- scan of the same ticket is told when the first one was.
CREATE TABLE IF NOT EXISTS epos_event_tickets (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id       BIGINT       NOT NULL,
  event_id       INT          NOT NULL,
  ticket_type_id INT          NOT NULL,
  code           CHAR(10)     NOT NULL,
  holder         VARCHAR(120) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_in_at  DATETIME     NULL,
  checked_in_by  VARCHAR(120) NULL,
  UNIQUE KEY uq_etickets_code (code),
  KEY idx_etickets_order (order_id),
  KEY idx_etickets_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per venue. Empty means the defaults in src/events.js (Pontardawe RFC's WRU
-- club and website); a row here overrides them.
--   wru_org_id     the club's organisation id on api.wru.wales
--   home_name      what a match is called after: "<home_name> v Penlan"
--   site_origins   the websites a buyer may be sent back to after paying,
--                  comma separated (https://pontardawerfc.com,...)
--   location       where a home match is, for the ticket
CREATE TABLE IF NOT EXISTS epos_event_settings (
  office         VARCHAR(190) CHARACTER SET utf8mb4
                 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  wru_org_id     INT          NULL,
  home_name      VARCHAR(80)  NULL,
  site_origins   VARCHAR(1000) NULL,
  location       VARCHAR(200) NULL,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
