-- How a member signs in to a venue's loyalty app, and what they can prove.
--
-- WHY THIS EXISTS
--
-- The app had exactly one way in: an email address and a six-digit code sent to
-- it. That is a good default and a bad only-option. A venue with a lot of older
-- members wants a password they can save in a browser; a venue running a
-- members' club wants the Vesopa account it already issues; a venue that takes
-- phone numbers at the till wants to text the code instead.
--
-- SHAPED LIKE VESOPA AUTH ON PURPOSE. auth.vesopa.com answers the same question
-- with one ROW per way in (`application_auth_methods`) plus a policy column
-- saying which one LEADS. A column per method would mean a migration and a
-- template edit every time somebody wants another one, and this table is going
-- to grow. See vesopa_auth/schema/schema.sql.
--
-- A VENUE THAT HAS NEVER LOOKED AT THIS STILL WORKS. No rows means "the default"
-- -- email and a code -- not "no way in". src/loyalty_auth.js reads it that way,
-- so nothing has to be backfilled and a venue can never lock its own members out
-- by leaving a page alone.
--
-- Target is MySQL 5.7 / MariaDB. Guarded, and safe to re-run.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER //
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;


-- ---------------------------------------------------------------------------
-- What the venue allows
-- ---------------------------------------------------------------------------

-- Which way in LEADS. Never what is possible -- that is the rows below -- only
-- what the app puts in front of somebody first.
--   code_first     an email address, then a code. The default.
--   password_first an email address and a password, with the code underneath.
--   vesopa_first   Continue with Vesopa, with the rest underneath.
CALL vesopa_add_column('epos_loyalty_app', 'auth_policy',
  "VARCHAR(24) NOT NULL DEFAULT 'code_first'");

-- May a member change their own name, email and phone in the app? A venue whose
-- membership is its books -- a club with subscriptions -- wants the answer no.
CALL vesopa_add_column('epos_loyalty_app', 'self_service',
  'TINYINT(1) NOT NULL DEFAULT 1');


-- One row per way in. Absent means "not offered"; the reader supplies the
-- default set for a venue with no rows at all.
--
--   code_email   a six-digit code, emailed          (the default)
--   password     an email address and a password
--   code_sms     a six-digit code, texted           (needs POSTCODER_API_KEY)
--   passkey      a passkey on the member's device   (browsers only)
--   vesopa       Continue with Vesopa               (needs an OAuth client)
CREATE TABLE IF NOT EXISTS epos_loyalty_app_methods (
  office      VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  method      VARCHAR(24)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order  INT          NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (office, method)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- What a member can prove
-- ---------------------------------------------------------------------------

-- A password, where the venue offers them and the member set one.
--
-- NULL is the ordinary state and is not "no password yet, ask them to make
-- one". Most members will never set one, and the sign-in page must not nag: a
-- member with no password is offered the code, which is what they already use.
CALL vesopa_add_column('epos_customers', 'password_hash', 'VARCHAR(255) NULL');
CALL vesopa_add_column('epos_customers', 'password_set_at', 'DATETIME NULL');

-- A phone number the member proved, as opposed to one a till typed in. Only a
-- proved number may be texted a sign-in code -- otherwise a mistyped digit at
-- the till is a way into somebody else's card.
CALL vesopa_add_column('epos_customers', 'phone_verified_at', 'DATETIME NULL');

-- Which Vesopa account this membership is linked to, where the member signed in
-- with one. The subject claim, not the email: an email can be changed at
-- auth.vesopa.com and the link must survive it.
CALL vesopa_add_column('epos_customers', 'vesopa_sub', 'VARCHAR(64) NULL');


-- A passkey belonging to a member. Separate from `user_passkeys` in Vesopa Auth
-- on purpose: a member of a venue's loyalty scheme is not a Vesopa account, and
-- joining the two would make every customer of every venue an account holder.
CREATE TABLE IF NOT EXISTS epos_loyalty_passkeys (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  office        VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  customer_id   CHAR(36)     NOT NULL,
  -- Base64url, as the browser gives it. Unique across the table: a credential
  -- belongs to one membership and a sign-in looks it up by this alone.
  credential_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  public_key    TEXT         NOT NULL,
  counter       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  transports    VARCHAR(120) NULL,
  -- What the member called it, or what the browser said it was.
  name          VARCHAR(80)  NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at  DATETIME     NULL,
  revoked_at    DATETIME     NULL,
  UNIQUE KEY uq_loyalty_passkey_credential (credential_id),
  KEY idx_loyalty_passkey_customer (office, customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- A WebAuthn challenge, in flight. Single use and short lived: the whole point
-- of the ceremony is that the same challenge cannot be replayed.
CREATE TABLE IF NOT EXISTS epos_loyalty_webauthn_challenges (
  challenge    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- register | signin
  purpose      VARCHAR(16)  NOT NULL,
  customer_id  CHAR(36)     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME     NOT NULL,
  consumed_at  DATETIME     NULL,
  KEY idx_loyalty_challenge_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------------
-- Codes by text as well as by email
-- ---------------------------------------------------------------------------

-- The codes table was built for email and the column is called `email`. Rather
-- than widen it into a "destination" and rewrite every query, a texted code
-- carries the number here and says so in `channel`.
--
-- Postcoder generates, sends AND checks a texted code, so there is no hash to
-- store for one: `reference` holds theirs and verifying is a call out. Exactly
-- how Vesopa Auth does it -- see vesopa_auth/src/challenges.js.
CALL vesopa_add_column('epos_loyalty_app_codes', 'channel',
  "VARCHAR(8) NOT NULL DEFAULT 'email'");
CALL vesopa_add_column('epos_loyalty_app_codes', 'phone', 'VARCHAR(32) NULL');
CALL vesopa_add_column('epos_loyalty_app_codes', 'reference', 'VARCHAR(120) NULL');


-- ---------------------------------------------------------------------------
-- News with pictures and video
-- ---------------------------------------------------------------------------

-- A message could carry one image. A venue announcing a new dish wants to show
-- it moving, and one that has filmed the room wants that on the news page.
CALL vesopa_add_column('epos_push_messages', 'video_url', 'VARCHAR(500) NULL');

-- Where the video is not a file we hold: a YouTube or Vimeo address, shown as a
-- thumbnail that opens out. Kept apart from video_url so the app knows whether
-- it may play the thing itself or must hand it to a browser.
CALL vesopa_add_column('epos_push_messages', 'video_embed_url', 'VARCHAR(500) NULL');


DROP PROCEDURE IF EXISTS vesopa_add_column;
