-- ---------------------------------------------------------------------------
-- Vesopa Tap: card payments taken on a clerk's phone (src/tap.js). Re-runnable.
-- ---------------------------------------------------------------------------

-- One row per tender a phone asks for. `id` is the phone's own id for the
-- payment, so a request sent twice finds the intent it already made: Dojo
-- ignore Idempotency-Key, and a second intent would be a second charge.
-- `state` moves once, from waiting, guarded in the UPDATE.
CREATE TABLE IF NOT EXISTS epos_tap_payments (
  id            VARCHAR(64)  NOT NULL PRIMARY KEY,
  office        VARCHAR(255) NOT NULL,
  terminal      VARCHAR(128) NULL,                 -- the phone's till seat
  intent_id     VARCHAR(64)  NOT NULL,
  amount_minor  INT          NOT NULL,             -- the bill's share, pence
  tip_minor     INT          NOT NULL DEFAULT 0,   -- on top, pence
  bill_ref      VARCHAR(64)  NULL,                 -- the open bill it pays towards
  clerk         VARCHAR(120) NULL,
  state         VARCHAR(12)  NOT NULL DEFAULT 'waiting',  -- waiting | paid | failed | cancelled | refunded
  dojo_status   VARCHAR(24)  NULL,
  environment   VARCHAR(8)   NOT NULL DEFAULT 'sandbox',  -- sandbox | live
  via           VARCHAR(8)   NOT NULL DEFAULT 'tap',      -- tap (the phone) | machine (a Dojo card machine)
  session_id    VARCHAR(64)  NULL,                        -- the card machine's terminal session
  refunded_minor INT         NOT NULL DEFAULT 0,          -- refunded so far, pence
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY tap_office_created (office, created_at),
  KEY tap_intent (intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A venue's Vesopa Tap settings, set in the back office (Vesopa Tap > Settings)
-- and read by its phones (/api/tap/config). No row = the defaults in tap.js:
-- on, tips on at 10 / 12.5 / 15%, service charge none / 10 / 12.5%, cash allowed.
CREATE TABLE IF NOT EXISTS epos_tap_settings (
  office            VARCHAR(255) NOT NULL PRIMARY KEY,
  enabled           TINYINT(1)   NOT NULL DEFAULT 1,
  tips_enabled      TINYINT(1)   NOT NULL DEFAULT 1,
  tip_percents      VARCHAR(40)  NOT NULL DEFAULT '10,12.5,15',
  service_percents  VARCHAR(40)  NOT NULL DEFAULT '0,10,12.5',
  allow_cash        TINYINT(1)   NOT NULL DEFAULT 1,
  receipt_email     TINYINT(1)   NOT NULL DEFAULT 1,
  updated_by        VARCHAR(255) NULL,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
