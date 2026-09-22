-- Back-office password resets.
--
-- Only a SHA-256 of the token is stored. The raw token exists in exactly two
-- places — the email and the link the user clicks — so a dump of this table
-- does not let anyone take over an account.
--
-- Collations are pinned. On the live MariaDB a bare `CHARSET=utf8mb4` resolves
-- to uca1400_ai_ci, which does not compare equal to the utf8mb4_unicode_ci /
-- utf8mb4_general_ci on the older tables; anything joining or comparing across
-- the two then fails with "Illegal mix of collations". Naming it here keeps
-- this table consistent with backoffice_users no matter which server runs it.

CREATE TABLE IF NOT EXISTS backoffice_password_resets (
  id           INT AUTO_INCREMENT PRIMARY KEY,

  -- No FOREIGN KEY: backoffice_users is a legacy PHP table whose id column
  -- type and engine vary between installs, and a constraint that fails to
  -- create would take the whole migration down with it. The lookup is by id
  -- and always re-checks the user still exists.
  user_id      INT NOT NULL,

  -- Hex SHA-256 — fixed width, ASCII, so CHAR(64) compares exactly.
  token_hash   CHAR(64) NOT NULL,

  expires_at   DATETIME NOT NULL,
  used_at      DATETIME NULL,
  requested_ip VARCHAR(45) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_reset_token (token_hash),
  INDEX idx_reset_user (user_id, used_at),
  INDEX idx_reset_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
