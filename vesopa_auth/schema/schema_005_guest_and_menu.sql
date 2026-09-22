-- ---------------------------------------------------------------------------
-- Guest use, and the scopes the QR menu actually needs.
--
-- WHY THIS COMES BEFORE THE MENU MIGRATION, and not after.
--
-- menu.vesopaepos serves diners who never sign in. Guest ordering is the
-- default, it is preselected, and every part of that page works without anybody
-- touching an account — an account buys exactly one thing today: the orders you
-- placed, on whatever phone you are holding.
--
-- The failure mode when an identity provider is added to a product like that is
-- well known and quiet: the sign-in becomes load-bearing by accident. Somebody
-- puts the OIDC check one layer too high, or the "who are you" call happens
-- before the menu renders, and a diner at a table with food coming is asked to
-- sign in to read a menu. That is not a bug anybody notices in testing, because
-- everybody testing it has an account.
--
-- So the guest case is written into the schema BEFORE the migration, as a
-- property of the application, and the scopes are defined so that the signed-in
-- path is an addition to guest ordering rather than a replacement for it.
--
-- Idempotent, like every file here.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;


-- ---------------------------------------------------------------------------
-- applications.guest_allowed
--
-- "This application serves people who are not signed in at all."
--
-- It is a statement about the product, and it earns its place by being read in
-- two places: the portal shows it so nobody configures the application as
-- though everybody has an account, and the consent screen can say "you can keep
-- using this without an account" — which is the sentence that stops somebody
-- abandoning a basket because they were asked to register.
--
-- It is deliberately NOT enforcement. The identity provider cannot stop a
-- product requiring a sign-in; only the product can. What it can do is record
-- the intention where the next person to touch it will read it.
-- ---------------------------------------------------------------------------
CALL vesopa_add_column('applications', 'guest_allowed',
  'TINYINT(1) NOT NULL DEFAULT 0 AFTER allow_self_enroll');


-- ---------------------------------------------------------------------------
-- The scopes the menu needs.
--
-- `INSERT … ON DUPLICATE KEY UPDATE` on `name`, so re-running corrects the
-- wording without creating a second row — and the wording is the part that
-- matters. Every description here is the sentence shown to the DINER, written
-- for somebody holding a phone with food coming, not for the developer asking.
--
-- `orders.claim` is the one worth explaining. A guest orders, waits, and only
-- then decides to make an account — at which point the orders they placed are
-- known to their phone and to nobody else. Without a way to attach them,
-- signing in LOSES the meal they are in the middle of, which is the single
-- worst moment to ask somebody to register. It is a separate scope rather than
-- part of `orders.read` because it is a different act: reading is passive,
-- claiming writes a person's id onto rows that had none.
-- ---------------------------------------------------------------------------
INSERT INTO scopes (name, title, description, is_default, is_sensitive) VALUES
  ('orders.read',  'See your orders',
   'The orders you have placed with this venue, and what is in them.', 0, 0),
  ('orders.write', 'Order for you',
   'Place orders from this menu on your behalf.', 0, 0),
  ('orders.claim', 'Keep the orders you placed as a guest',
   'Attach orders you placed on this phone before signing in, so you do not lose track of a meal in progress.', 0, 0)
ON DUPLICATE KEY UPDATE
  title = VALUES(title),
  description = VALUES(description),
  is_sensitive = VALUES(is_sensitive);


-- ---------------------------------------------------------------------------
-- The menu is a guest-first application, and gets those scopes.
--
-- Guarded on the slug rather than an id, so this is safe on a database where
-- the seed has not run and the row does not exist yet — the seed creates it and
-- a later deploy applies this.
-- ---------------------------------------------------------------------------
UPDATE applications SET guest_allowed = 1 WHERE slug = 'vesopa-menu';

INSERT IGNORE INTO application_scopes (application_id, scope_id)
SELECT a.id, s.id
  FROM applications a
  JOIN scopes s ON s.name IN ('orders.read', 'orders.write', 'orders.claim')
 WHERE a.slug = 'vesopa-menu';


-- ---------------------------------------------------------------------------
-- And the role a diner holds.
--
-- One role, `menu.customer`, and it is the default so that anybody who signs in
-- has it from the first moment. A diner is not staff and will never hold a
-- staff role — which is the whole reason the menu is a separate application
-- from Vesopa EPOS rather than another role inside it. Roles separate
-- colleagues; applications separate audiences.
-- ---------------------------------------------------------------------------
INSERT INTO application_roles (application_id, role_key, name, description, is_default)
SELECT a.id, 'menu.customer', 'Customer', 'Can order from the menu and see their own orders.', 1
  FROM applications a WHERE a.slug = 'vesopa-menu'
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description), is_default = VALUES(is_default);
