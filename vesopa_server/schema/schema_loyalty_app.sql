-- The loyalty app.
--
-- "A white-labelled loyalty app that displays a QR code for the customer to
-- scan. Branded for each venue. An API for the customer's points and
-- transaction history. The back office sends push notifications."
--
-- Members, points and their history already exist (epos_customers,
-- epos_loyalty_txns). What is new is the app's own: how it looks for each venue,
-- how a customer signs in to it, where a notification can reach them, and what
-- was sent. See src/loyalty_app.js.
--
-- `office` is an email address compared against utf8mb4_general_ci columns
-- elsewhere, so it is stated explicitly rather than inherited from the server
-- default (the "Illegal mix of collations" that only happens on live).
-- Re-runnable, like every migration here.


-- How the app looks and behaves for one venue.
CREATE TABLE IF NOT EXISTS epos_loyalty_app (
  office            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  enabled           TINYINT(1)   NOT NULL DEFAULT 0,

  -- The app's address: menu.vesopaepos.com/app/<slug>/. Lower case letters,
  -- digits and hyphens. A lookup, not an identity -- see dinein's slug note.
  slug              VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,

  app_name          VARCHAR(80)  NULL,
  welcome_text      VARCHAR(255) NULL,
  logo_url          VARCHAR(500) NULL,   -- wide or square, drawn on the card
  icon_url          VARCHAR(500) NULL,   -- square, the phone's home-screen icon
  hero_url          VARCHAR(500) NULL,

  colour_primary    VARCHAR(16)  NULL,
  colour_accent     VARCHAR(16)  NULL,
  colour_background VARCHAR(16)  NULL,
  colour_text       VARCHAR(16)  NULL,
  font_heading      VARCHAR(80)  NULL,
  font_body         VARCHAR(80)  NULL,

  -- Website, phone, email, Facebook, Instagram... as JSON: {"website": "..."}
  links             TEXT         NULL,

  -- Where the venue is, for "members near the venue now".
  latitude          DECIMAL(9,6) NULL,
  longitude         DECIMAL(9,6) NULL,
  radius_m          INT          NOT NULL DEFAULT 400,

  -- The venue's own Windows app from the Microsoft Store: its WNS credentials
  -- from Partner Center. The secret is sealed (see express_kiosk.js seal()).
  wns_package_sid   VARCHAR(255) NULL,
  wns_secret_enc    VARCHAR(500) NULL,

  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_loyalty_app_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- A six-digit sign-in code sent by email. Stored hashed; a code is good for ten
-- minutes and five tries.
CREATE TABLE IF NOT EXISTS epos_loyalty_app_codes (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  office      VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  email       VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  code_hash   CHAR(64)     NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  expires_at  DATETIME     NOT NULL,
  used_at     DATETIME     NULL,
  ip_address  VARCHAR(64)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_loyalty_codes_email (office, email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- One signed-in phone or PC. The customer's token names this row, so signing
-- out -- here, everywhere, or by the venue -- is a row, not a wait for expiry.
CREATE TABLE IF NOT EXISTS epos_loyalty_app_sessions (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id  CHAR(36)     NOT NULL,
  platform     VARCHAR(16)  NULL,           -- web | windows
  user_agent   VARCHAR(255) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME     NULL,
  revoked_at   DATETIME     NULL,
  KEY idx_loyalty_sessions_customer (office, customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Where a notification can reach one signed-in app: a Web Push subscription
-- or a Windows (WNS) channel. Belongs to the session that registered it and
-- goes with it.
CREATE TABLE IF NOT EXISTS epos_push_channels (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id  CHAR(36)     NOT NULL,
  session_id   CHAR(36)     NULL,
  kind         VARCHAR(16)  NOT NULL,       -- webpush | wns
  endpoint     TEXT         NOT NULL,       -- the push service URL or the WNS channel URI
  endpoint_hash CHAR(64)    NOT NULL,
  p256dh       VARCHAR(255) NULL,           -- Web Push keys
  auth_secret  VARCHAR(255) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_ok_at   DATETIME     NULL,
  fail_count   INT          NOT NULL DEFAULT 0,
  disabled_at  DATETIME     NULL,
  UNIQUE KEY uq_push_endpoint (endpoint_hash),
  KEY idx_push_customer (office, customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- A notification the venue sent, or will send.
CREATE TABLE IF NOT EXISTS epos_push_messages (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  title        VARCHAR(80)  NOT NULL,
  body         VARCHAR(500) NOT NULL,
  image_url    VARCHAR(500) NULL,
  link_url     VARCHAR(500) NULL,
  -- {"kind":"all"} | {"kind":"near"} | {"kind":"tier","tier":"Gold"}
  -- | {"kind":"lapsed","days":30}
  audience     TEXT         NOT NULL,
  -- scheduled | sending | sent | cancelled
  status       VARCHAR(16)  NOT NULL DEFAULT 'scheduled',
  send_at      DATETIME     NOT NULL,
  sent_at      DATETIME     NULL,
  recipients   INT          NOT NULL DEFAULT 0,
  reached_web  INT          NOT NULL DEFAULT 0,
  reached_wns  INT          NOT NULL DEFAULT 0,
  failed       INT          NOT NULL DEFAULT 0,
  created_by   VARCHAR(190) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_push_messages_due (status, send_at),
  KEY idx_push_messages_office (office, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- The app's inbox: a message as one customer received it. Written for every
-- customer a message was for, whether or not a notification reached them, so a
-- customer who said no to notifications still sees it next time they open the
-- app ("software push").
CREATE TABLE IF NOT EXISTS epos_push_inbox (
  message_id   CHAR(36)     NOT NULL,
  customer_id  CHAR(36)     NOT NULL,
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at      DATETIME     NULL,
  PRIMARY KEY (message_id, customer_id),
  KEY idx_push_inbox_customer (office, customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Where a customer last was, only if they allowed it. One row, not a trail,
-- and gone after 24 hours (swept by src/loyalty_app.js).
CREATE TABLE IF NOT EXISTS epos_customer_locations (
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id  CHAR(36)     NOT NULL,
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(9,6) NOT NULL,
  accuracy_m   INT          NULL,
  at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (office, customer_id),
  KEY idx_customer_locations_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
