-- ---------------------------------------------------------------------------
-- vesopasoftware_authdb — the moving parts: sessions, devices, codes, tokens,
-- and the log of what happened.
--
-- Same rules as schema.sql: idempotent, and every string column pins its
-- collation. Applied after it, so the foreign keys here can rely on users and
-- applications existing.
--
-- NOTHING IN THIS FILE STORES A SECRET IN A FORM THAT CAN BE USED.
-- Session tokens, refresh tokens, one-time codes, device tokens and API keys
-- are all stored as SHA-256 of the value plus a per-row salt where the value is
-- low-entropy. A dump of these tables is a list of hashes, not a set of keys to
-- the estate. This is not paranoia: a one-time-code table in clear is a live
-- credential list that nobody thinks of as one, which is exactly why it leaks.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;


-- ===========================================================================
-- SIGNING KEYS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- signing_keys — the RSA keys that sign ID tokens and access tokens.
--
-- Rotation needs three states at once, which is why this is a table and not a
-- pair of files: the key currently signing, the previous key which must stay
-- published so tokens already issued still verify, and the next key which is
-- published *before* it starts signing so that a client which cached the JWKS
-- does not reject the first token of the new era.
--
-- The private key is encrypted with the application's KEY_ENCRYPTION_KEY, which
-- lives in the environment. A dumped database cannot mint tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signing_keys (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  kid             CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  algorithm       VARCHAR(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'RS256',
  public_jwk      JSON NOT NULL,
  private_cipher  VARBINARY(8192) NOT NULL,
  status          ENUM('next','active','retired') NOT NULL DEFAULT 'next',
  activated_at    DATETIME NULL,
  retired_at      DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_kid (kid),
  KEY idx_key_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- SESSIONS AND DEVICES
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- devices — "remember me on this device".
--
-- A remembered device is NOT a way in on its own, and that distinction is the
-- whole design. The cookie proves *which* device this is; it does not prove who
-- is holding it. What being remembered buys you is skipping the second factor
-- and a longer session — never skipping the first factor.
--
-- Getting this wrong turns a stolen laptop into a permanent bearer credential
-- for every Vesopa app at once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  token_hash     CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  name           VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  platform       VARCHAR(60)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  browser        VARCHAR(60)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  user_agent     VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  first_ip       VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  last_ip        VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  last_country   CHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- Until when this device may skip the second factor. Not "for ever": a
  -- trusted device is trusted for a while and then asks again.
  trusted_until  DATETIME NULL,

  -- The device secret is rotated every time it is presented, exactly like a
  -- refresh token, and for the same reason: a cookie copied off a machine works
  -- once, and the moment the real device presents the value it has, the two
  -- disagree and we know. A stale hash arriving is not "an old tab" — it is
  -- somebody holding a copy — so it revokes the device and every session on it.
  token_rotated_at  DATETIME NULL,
  reuse_detected_at DATETIME NULL,

  first_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at     DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_device_token (token_hash),
  KEY idx_device_user (user_id, revoked_at),
  CONSTRAINT fk_device_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- sso_sessions — the single sign-on session at auth.vesopa.com.
--
-- This is the thing that makes the second application a one-click sign-in. The
-- browser holds one cookie for this domain; every application's authorisation
-- request is answered against it.
--
-- `amr` and `acr` record HOW the person proved themselves — password, code,
-- passkey, second factor — because an application is allowed to demand more
-- than the session currently carries, and step-up has to know what it already
-- has. Without these two columns "this action needs a second factor" can only
-- be implemented by logging everybody out, which is how people learn to hate a
-- security feature.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sso_sessions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id      CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  user_id        INT UNSIGNED NOT NULL,
  token_hash     CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  device_id      INT UNSIGNED NULL,

  amr            JSON NULL,      -- ["pwd","otp"] — how they proved it, this time
  acr            VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'aal1',

  ip             VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  country        CHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  user_agent     VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- Two clocks. `expires_at` is the hard end of the session; `idle_expires_at`
  -- moves forward as the person uses it. A session that is only bounded by one
  -- of the two is either annoying or dangerous.
  idle_expires_at DATETIME NOT NULL,
  expires_at      DATETIME NOT NULL,

  remembered     TINYINT(1) NOT NULL DEFAULT 0,   -- the tickbox was ticked
  last_seen_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at     DATETIME NULL,
  revoked_reason VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token (token_hash),
  UNIQUE KEY uq_session_public (public_id),
  KEY idx_session_user (user_id, revoked_at),
  KEY idx_session_expiry (expires_at),
  CONSTRAINT fk_session_user   FOREIGN KEY (user_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_session_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- ONE-TIME CODES
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- verification_challenges — emailed codes and SMS OTPs.
--
-- TWO CHANNELS WITH TWO DIFFERENT MECHANISMS, and the table has to hold both.
--
-- Email is ours end to end: we mint the code, hash it with a per-row salt, send
-- it and check it here. `code_hash` is populated.
--
-- Phone is Postcoder's: their API generates and sends the code and their API
-- verifies it. We never see it, and nothing here could check one offline. For
-- an SMS row `code_hash` is empty and `external_ref` holds their reference.
-- That asymmetry is deliberate — the alternative is holding an SMS gateway
-- credential and a list of live codes for the sake of a tidy schema.
--
-- `purpose` matters as much as the code. A code sent to verify a new address
-- must not be accepted as a code to sign in, or "add a colleague's email to my
-- account" becomes "sign in as my colleague".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_challenges (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id      CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  purpose        ENUM('login','register','verify_email','verify_phone','link_identity',
                      'recovery','step_up','change_password','delete_account') NOT NULL,
  channel        ENUM('email','sms') NOT NULL,

  destination      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  destination_norm VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  user_id        INT UNSIGNED NULL,     -- NULL until we know who this is
  application_id INT UNSIGNED NULL,     -- which app the person was heading for

  code_hash      CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  code_salt      CHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  external_ref   VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  attempts       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts   TINYINT UNSIGNED NOT NULL DEFAULT 5,

  ip             VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  user_agent     VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- Postcoder's view of an SMS challenge, which is the only view there is.
  provider_status ENUM('pending','verified','failed','expired') NOT NULL DEFAULT 'pending',

  expires_at     DATETIME NOT NULL,
  consumed_at    DATETIME NULL,
  revoked_at     DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- ONE LIVE CHALLENGE PER DESTINATION AND PURPOSE, enforced here rather than
  -- hoped for in code. Asking for a second code revokes the first, so a person
  -- can never hold two valid codes at once — which is what makes "request a
  -- code twenty times and try them all" not work, and also what stops the
  -- ordinary confusion of a customer typing the first code after the second
  -- arrived.
  live_flag      TINYINT(1) GENERATED ALWAYS AS (
                   IF(consumed_at IS NULL AND revoked_at IS NULL, 1, NULL)) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_challenge_public (public_id),
  UNIQUE KEY uq_challenge_live (destination_norm, purpose, live_flag),
  KEY idx_challenge_dest (destination_norm, purpose, created_at),
  KEY idx_challenge_expiry (expires_at),
  KEY idx_challenge_user (user_id),
  CONSTRAINT fk_challenge_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- webauthn_challenges — the random value a passkey ceremony must answer.
--
-- Server-generated, single use, short-lived, and bound to the session that
-- asked for it. A hard-coded challenge, or one the client is allowed to choose,
-- reduces WebAuthn to "the browser said yes" — which is worth nothing, because
-- anything that can call the API can say yes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  challenge   CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  purpose     ENUM('register','authenticate') NOT NULL,
  user_id     INT UNSIGNED NULL,        -- NULL for a usernameless sign-in
  session_ref CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  ip          VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  expires_at  DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_webauthn_challenge (challenge),
  KEY idx_webauthn_expiry (expires_at),
  CONSTRAINT fk_webauthn_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- oauth_states — the state of a social sign-in while the person is away at
-- Google or Apple.
--
-- `state` defends against CSRF on the callback; `nonce` binds the ID token to
-- this request; `code_verifier` is our PKCE secret for the upstream provider.
-- Kept server-side rather than in a cookie so that Apple's form_post callback —
-- which arrives as a cross-site POST, where a SameSite=Lax cookie is NOT sent —
-- can still be matched. That single detail is why "sign in with Apple" breaks
-- on implementations that keep state in a cookie and works everywhere else.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  state          CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  provider       ENUM('google','apple','microsoft','github') NOT NULL,
  nonce          CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  code_verifier  VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- Why the person went: signing in, or linking a provider to an account they
  -- are already signed in to. Linking must never be able to become signing in.
  intent         ENUM('login','link') NOT NULL DEFAULT 'login',
  user_id        INT UNSIGNED NULL,      -- set for intent = link

  -- Where to put them afterwards. Validated against registered redirect URIs
  -- before it is ever used; an unvalidated return_to is an open redirect.
  return_to      VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  authorize_ref  CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  ip             VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  expires_at     DATETIME NOT NULL,
  consumed_at    DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_oauth_state (state),
  KEY idx_oauth_state_expiry (expires_at),
  CONSTRAINT fk_oauth_state_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- THE OAUTH FLOW ITSELF
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- oauth_authorization_codes — issued at /authorize, spent at /token.
--
-- Single use, sixty seconds, and hashed. `consumed_at` is set inside the same
-- transaction that reads the row, so two simultaneous redemptions cannot both
-- succeed; if a code is presented twice, every token descended from it is
-- revoked, because the second presentation means somebody else has it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code_hash             CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  application_id        INT UNSIGNED NOT NULL,
  user_id               INT UNSIGNED NOT NULL,
  session_id            INT UNSIGNED NULL,

  redirect_uri          VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  scope                 VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  nonce                 VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- PKCE. Required for every client here, confidential ones included: it costs
  -- a public client nothing and it closes code interception for all of them.
  code_challenge        VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  code_challenge_method ENUM('S256','plain') NOT NULL DEFAULT 'S256',

  amr                   JSON NULL,
  acr                   VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  auth_time             DATETIME NULL,

  expires_at            DATETIME NOT NULL,
  consumed_at           DATETIME NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_authcode (code_hash),
  KEY idx_authcode_expiry (expires_at),
  CONSTRAINT fk_authcode_app  FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_authcode_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- oauth_refresh_tokens — rotation with reuse detection.
--
-- HOW THIS ACTUALLY CATCHES A THIEF. Every refresh mints a new token and
-- retires the old one, all of them sharing a `family_id`. A retired token is
-- kept, not deleted. If a retired token is ever presented again, exactly one of
-- two things happened: the legitimate client lost the response and retried, or
-- somebody stole a token. We cannot tell which, so we assume the worse one and
-- revoke the whole family. The honest client is asked to sign in again; the
-- thief gets nothing.
--
-- Deleting spent tokens instead of retiring them makes that detection
-- impossible — a stolen token then looks exactly like an unknown one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash        CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  family_id         CHAR(26) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  parent_id         INT UNSIGNED NULL,

  application_id    INT UNSIGNED NOT NULL,
  user_id           INT UNSIGNED NOT NULL,
  session_id        INT UNSIGNED NULL,
  device_id         INT UNSIGNED NULL,
  scope             VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  issued_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        DATETIME NOT NULL,

  -- `used_at` is the lock. Redemption is a single conditional statement —
  -- UPDATE … SET used_at = NOW() WHERE id = ? AND used_at IS NULL — and the
  -- row count decides: 1 means this caller won and gets the new token, 0 means
  -- somebody already spent it.
  --
  -- 0 is not automatically a thief. A till on a bad connection sends /token
  -- twice and both arrive; if that revokes the family, the pub loses its till
  -- mid-service because the wifi blinked. So a second presentation from the
  -- same device and IP within the grace window returns the successor recorded
  -- in `rotated_to_id` instead. Anything else is treated as theft.
  used_at           DATETIME NULL,
  rotated_to_id     INT UNSIGNED NULL,
  rotated_at        DATETIME NULL,
  revoked_at        DATETIME NULL,
  revoked_reason    VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  reuse_detected_at DATETIME NULL,

  ip                VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_token (token_hash),
  KEY idx_refresh_family (family_id),
  KEY idx_refresh_user (user_id, application_id),
  KEY idx_refresh_expiry (expires_at),
  CONSTRAINT fk_refresh_app  FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- oauth_consents — what the person agreed this application may see.
--
-- Recorded per application per scope, with the moment of agreement, because
-- "you consented" is a claim that has to be evidenced. Revoking is a timestamp,
-- not a delete, for the same reason.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_consents (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  application_id INT UNSIGNED NOT NULL,
  scope          VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  -- Set when the consent screen said "these two apps share your details". The
  -- person agreed to a group, so revoking it must revoke the sharing, not just
  -- one app's access.
  share_group_id INT UNSIGNED NULL,
  granted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at     DATETIME NULL,
  ip             VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  active_flag    TINYINT(1) GENERATED ALWAYS AS (IF(revoked_at IS NULL, 1, NULL)) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_consent_active (user_id, application_id, active_flag),
  KEY idx_consent_app (application_id),
  CONSTRAINT fk_consent_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_consent_app  FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ===========================================================================
-- INVITATIONS, LOGGING, RATE LIMITS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- invitations — the admin's way of bringing somebody in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invitations (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash       CHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  email            VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  email_norm       VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  invited_by       INT UNSIGNED NULL,
  organisation_id  INT UNSIGNED NULL,
  application_id   INT UNSIGNED NULL,
  role_id          INT UNSIGNED NULL,
  grants_developer TINYINT(1) NOT NULL DEFAULT 0,
  message          VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  expires_at       DATETIME NOT NULL,
  accepted_at      DATETIME NULL,
  accepted_user_id INT UNSIGNED NULL,
  revoked_at       DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_invitation_token (token_hash),
  KEY idx_invitation_email (email_norm),
  KEY idx_invitation_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- login_events — every attempt, successful or not.
--
-- This is the analytics panel's raw material and the answer to "was that me?".
-- `identifier_shown` is what the person typed, kept so a support call about
-- "it says no such account" can be answered — with the caveat that it is
-- personal data and falls under the retention policy like everything else.
--
-- A failed attempt has no user_id when the address does not exist. That is not
-- a gap: it is the difference between "somebody guessed a wrong password for a
-- real account" and "somebody is walking through addresses", and the dashboard
-- needs both.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NULL,
  application_id   INT UNSIGNED NULL,
  session_id       INT UNSIGNED NULL,

  -- `tooling` is a session minted on the server by scripts/console-session.js,
  -- for photographing the signed-in pages. It is a real way a session came into
  -- existence, so it is a real method: recording it as anything else would make
  -- the person's own history lie about what happened to their account.
  method           ENUM('password','email_code','sms_otp','passkey','google','apple',
                        'microsoft','github','recovery_code','totp','device','refresh',
                        'tooling') NOT NULL,
  outcome          ENUM('success','failure','challenge','blocked') NOT NULL,
  failure_reason   VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  identifier_shown VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  ip               VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  country          CHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  user_agent       VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  device_id        INT UNSIGNED NULL,

  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_login_user (user_id, created_at),
  KEY idx_login_time (created_at),
  KEY idx_login_app (application_id, created_at),
  KEY idx_login_ip (ip, created_at),
  KEY idx_login_outcome (outcome, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- audit_log — everything that changed, and who changed it.
--
-- Separate from login_events on purpose. One answers "who tried to get in", the
-- other "what did somebody do once inside" — an admin resetting a factor, a
-- developer rotating a secret, a user unlinking a provider. Admin-assisted
-- account recovery is meaningless without this table, because the whole safety
-- of it rests on the action being visible afterwards.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id  INT UNSIGNED NULL,
  actor_type     ENUM('user','admin','developer','system','application') NOT NULL DEFAULT 'user',
  action         VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  target_type    VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  target_id      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  application_id INT UNSIGNED NULL,
  detail         JSON NULL,
  ip             VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  user_agent     VARCHAR(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_audit_actor (actor_user_id, created_at),
  KEY idx_audit_action (action, created_at),
  KEY idx_audit_target (target_type, target_id),
  KEY idx_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- rate_limits — counters, in the database rather than in memory.
--
-- In memory would be faster and would also be per-process: two pm2 workers mean
-- twice the attempts before anybody is locked out, and a restart forgives every
-- attacker instantly. This app runs in fork mode with one instance partly for
-- that reason, but the limiter belongs here anyway so that the count survives a
-- deploy.
--
-- One row per (bucket, key, window). Old rows are swept by the jobs runner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket       VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  subject      VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  window_start DATETIME NOT NULL,
  hits         INT UNSIGNED NOT NULL DEFAULT 1,
  blocked_until DATETIME NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_rate (bucket, subject, window_start),
  KEY idx_rate_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- settings — small pieces of configuration an admin may change without a
-- deploy. Not a dumping ground: anything a developer needs at boot belongs in
-- the environment, where it cannot be edited by somebody who is signed in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  name       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  value      TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
