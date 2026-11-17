-- ---------------------------------------------------------------------------
-- Vesopa AI in Vesopa Go (2026-11-17). Re-runnable.
--
-- Who may ask Vesopa AI about the venue's figures: a manager (a member of
-- staff in no permission group, or in a group with is_manager) always may.
-- Anybody else only when a manager or the owner has invited them by email:
-- the email carries a code, the person types it into Go's AI tab while signed
-- on with their own PIN, and from then on that member of staff may ask, for
-- the whole venue or for one site, until the invite is revoked.
--
-- Only a hash of the code is kept. Nothing else is stored: conversations stay
-- on the phone, and the figures are worked out fresh on every question.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS go_ai_invites (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office       VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  email        VARCHAR(255) NOT NULL,
  code_hash    CHAR(64)     NOT NULL,
  -- NULL: every site of the venue. Otherwise bo_till_sites.id.
  site_id      INT          NULL,
  invited_by   VARCHAR(120) NULL,
  -- The member of staff (bo_clarks.id) who redeemed it.
  clerk_id     INT          NULL,
  accepted_at  DATETIME     NULL,
  revoked_at   DATETIME     NULL,
  expires_at   DATETIME     NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_go_ai_invites_office (office),
  KEY idx_go_ai_invites_clerk (office, clerk_id),
  UNIQUE KEY uq_go_ai_invites_code (code_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
