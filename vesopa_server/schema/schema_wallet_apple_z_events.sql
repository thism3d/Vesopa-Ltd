-- The wallet's own log: what actually happened to every pass.
--
-- WHY THIS TABLE EXISTS
--
-- Everything a pass does after it leaves this server happens on somebody
-- else's phone. There is no app to instrument, no crash report to read, and
-- the customer standing at the counter saying "it didn't work" is describing
-- an event that took place hours ago on a device we cannot see.
--
-- Until now the record of all that was: one `last_error` column per pass and
-- one per device — the LAST failure, overwritten by the next — and Apple's own
-- complaint lines going to the process output, where they rotate away and
-- cannot be read from the back office at all. That is enough to know something
-- is wrong and never enough to know what.
--
-- So this is append-only and per event. "This card was built at 14:02, this
-- phone registered at 14:02, the push at 16:40 was accepted, the one at 18:15
-- came back BadDeviceToken" is a story. A pair of last_error columns is not.
--
-- WHY NOT THE PASS FILE ITSELF
--
-- A `.pkpass` is deliberately built on demand — it is a snapshot carrying the
-- balance that was true when it was signed, and storing it would mean
-- invalidating a file on every sale. What is kept here is the DETAIL of each
-- build: when, for whom, which serial, how large, and what went wrong. That is
-- what a support call needs, and it does not go stale.
--
-- Sorted last of the wallet files on purpose. `schema_wallet_apple_z_events`
-- sorts after `schema_wallet_apple_push`, and the deploy applies every file in
-- name order — see the note in that file about the ordering being load-bearing.
--
-- Target is MySQL 5.7 / MariaDB. Every statement is guarded and safe to re-run;
-- the deploy applies all of them every time.

CREATE TABLE IF NOT EXISTS epos_wallet_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The tenant. Every read is scoped by it, like every other wallet table:
  -- one venue must never see another's cards. Never nullable, because a row
  -- that belongs to nobody would be visible to everybody or to no one, and
  -- both are wrong.
  office        VARCHAR(190) NOT NULL,

  -- What happened: built, downloaded, registered, unregistered, refreshed,
  -- pushed, push_failed, device_log, error. Kept as a string rather than an
  -- ENUM so a new kind of event is a deploy and not a migration.
  event         VARCHAR(32)  NOT NULL,

  -- Which card. `serial` is Apple's, and is what the phone and the update
  -- service both speak; the pass row's own id may not exist yet at the moment
  -- of the first build, so this is the join that always works.
  kind          VARCHAR(16)      NULL,
  subject_id    VARCHAR(64)      NULL,
  serial_number VARCHAR(64)      NULL,
  device_id     VARCHAR(64)      NULL,

  -- The human-readable line. For a device_log it is Apple's own words, which
  -- is the single most useful string in this whole subsystem.
  detail        VARCHAR(500)     NULL,

  -- Size of the signed pass, for a build. A pass that suddenly halves is a
  -- venue whose artwork stopped loading, and nothing else reports that.
  bytes         INT UNSIGNED     NULL,

  -- How long the build took. Signing shells out to openssl, so this is the
  -- number that moves first when the box is under load.
  ms            INT UNSIGNED     NULL,

  -- Whether it worked. Separate from `event` so "pushed" and "push failed"
  -- can be counted together as attempts.
  ok            TINYINT(1)   NOT NULL DEFAULT 1,

  -- Who asked. Truncated hard: it is for telling an iPhone from a scanner,
  -- not for building a profile of anybody.
  user_agent    VARCHAR(190)     NULL,
  ip            VARCHAR(45)      NULL,

  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The three questions actually asked of this table: what has this venue been
  -- doing lately, what has happened to this one card, and what is failing.
  KEY idx_wallet_events_office (office, created_at),
  KEY idx_wallet_events_serial (serial_number, created_at),
  KEY idx_wallet_events_trouble (office, ok, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
