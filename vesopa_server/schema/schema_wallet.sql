-- Google Wallet passes: per-office pass branding, and a register of every pass
-- that has been minted for a customer, a member of staff or a promotion.
--
-- Named `schema_wallet.sql` so it sorts last. deploy.sh --schema applies
-- migrations in plain alphabetical order with no dependency tracking, and this
-- file reads `epos_customers`, `epos_promotions` and `bo_clarks` — all created
-- earlier in the sort. See the note at the top of schema_till_change_window.sql
-- for why the filename is the ordering.
--
-- Target is MySQL 5.7 / MariaDB. Collations are pinned on every text column:
-- MariaDB 11.4 resolves a bare `utf8mb4` to utf8mb4_uca1400_ai_ci, and a join
-- between that and utf8mb4_general_ci matches nothing without raising an error.
-- `office` here joins against columns written by the older migrations, so it
-- has to agree with them.

-- ---------------------------------------------------------------------------
-- How this office's passes look and read. One row per tenant.
--
-- The Google-side credentials (issuer ID, service account, signing key) are
-- deliberately NOT here: they belong to Vesopa, not to the merchant, and they
-- live in the environment. What a merchant controls is the artwork and the
-- wording, which is all this table holds.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_wallet_settings (
  office            VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  enabled           TINYINT(1)   NOT NULL DEFAULT 0,

  -- What the pass calls itself. `program_name` is the big line on a loyalty
  -- card ("Vesopa Rewards"); `issuer_name` is the venue underneath it.
  program_name      VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  issuer_name       VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- Artwork. Google fetches these itself, so they must be public HTTPS URLs
  -- with no sign-in in front of them — a logo behind the back-office session
  -- will simply never render on the card.
  --
  -- logo: 1:1, at least 660x660, masked into a circle by Wallet.
  -- hero: 3:1 or wider, 1032x336 is the reference size.
  logo_url          VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  hero_url          VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- Card colour. Left blank, Google picks the dominant colour out of the logo,
  -- which is usually right and occasionally awful.
  hex_background    VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  homepage_url      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  support_phone     VARCHAR(40)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  terms             TEXT         CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,

  -- Which of the five passes this office issues. A venue may well want a
  -- loyalty card and nothing else.
  loyalty_enabled   TINYINT(1)   NOT NULL DEFAULT 1,
  customer_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
  giftcard_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
  staff_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  promo_enabled     TINYINT(1)   NOT NULL DEFAULT 0,

  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- The classes registered at Google, one per office per kind.
--
-- A class is the template — the logo, the programme name, the layout. It is
-- created once and then updated in place; the objects (individual cards) point
-- at it. Recording the state here means the back office can say "your loyalty
-- card is live, your staff card is still in draft" without calling Google on
-- every page load.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_wallet_classes (
  office        VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- 'loyalty' | 'customer' | 'giftcard' | 'staff' | 'promo'
  kind          VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- The full Google class id, "<issuerId>.<suffix>".
  class_id      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  -- Google's own reviewStatus: DRAFT | UNDER_REVIEW | APPROVED | REJECTED.
  -- A DRAFT class still works, but only for accounts on the issuer's test
  -- list — which is exactly what makes "it works for me" so misleading here.
  review_status VARCHAR(24)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  last_error    VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  synced_at     TIMESTAMP    NULL DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (office, kind),
  UNIQUE KEY uq_wallet_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Every pass minted, so a card can be found again.
--
-- `subject_id` is whatever the pass is about: an epos_customers.id for a
-- loyalty or customer card, a bo_clarks.id for a staff card, an
-- epos_promotions.id for an offer. It is a plain VARCHAR rather than a foreign
-- key because those three live in tables with three different id types, one of
-- which (bo_clarks) predates this schema entirely.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epos_wallet_passes (
  id           CHAR(36)     CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL PRIMARY KEY,
  office       VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  kind         VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  subject_id   VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- The full Google object id, "<issuerId>.<suffix>". Derived from the office,
  -- kind and subject, so re-issuing a pass to the same person updates the card
  -- already in their wallet instead of adding a second one.
  object_id    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,

  -- What the barcode encodes. The same number the swipe card carries, so one
  -- customer scanning a phone and another handing over plastic arrive at the
  -- till as the same lookup.
  card_number  VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',

  -- 'pending'  — minted here, not yet pushed to Google
  -- 'active'   — Google has the object
  -- 'expired'  — object set to EXPIRED (staff left, promo ended)
  state        VARCHAR(16)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',

  -- The pay.google.com/gp/v/save/... link. Kept so the back office can show a
  -- QR again without re-signing, and so a receipt can reprint the same link.
  save_url     TEXT         CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,

  last_error   VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL,
  synced_at    TIMESTAMP    NULL DEFAULT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_wallet_pass (office, kind, subject_id),
  UNIQUE KEY uq_wallet_object (object_id),
  KEY idx_wallet_pass_office (office, kind),
  KEY idx_wallet_pass_card (office, card_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
