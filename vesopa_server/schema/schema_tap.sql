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
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY tap_office_created (office, created_at),
  KEY tap_intent (intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
