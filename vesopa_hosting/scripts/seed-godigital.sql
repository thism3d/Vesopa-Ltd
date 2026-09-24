-- The GoDigital bundle: a .site domain and the first month of hosting, ৳381.
--
-- Run once per database. Re-runnable: it updates the row if it is already
-- there, so a correction is this file again rather than hand-edited SQL.
--
--   mysql -u<user> -p <db> < scripts/seed-godigital.sql
--
-- WHY 256 AND NOT 381. Every price in this app is written once in the base
-- currency and converted, so the row carries pence and the customer sees taka.
-- 256p × 149 = ৳381.44, and BDT rounds to the nearest whole taka, which lands
-- on ৳381.00 exactly — checked against currency.convert(), not arithmetic done
-- in my head. Change the BDT rate and this becomes a different taka number;
-- that is the trade for having one price list instead of four.
--
-- WHY `bundle` AND NOT `fixed`. A fixed amount would be a discount typed as a
-- number, and the day a domain or a plan is repriced it becomes either a loss
-- or a broken promise. A bundle carries what the SET costs and the discount is
-- derived from whatever the lines are worth that day, so the customer always
-- pays ৳381 and we always know why.
--
-- `applies_to = all` because the bundle is two lines of different kinds: the
-- domain AND the hosting have to count towards the set, or the arithmetic is
-- against the wrong total.
--
-- `first_order_only` because it is an acquisition offer, and `countries = BD`
-- because it is priced for Bangladesh. Both are enforced at the basket and
-- again inside the checkout transaction.

INSERT INTO coupons
  (code, description, description_bn, headline, headline_bn,
   kind, value, applies_to, requires_tld, grants_plan_slug, grants_months,
   min_spend_pence, max_uses, first_order_only, public_offer,
   countries, starts_at, expires_at, active)
VALUES
  ('GODIGITAL',
   'A .site domain and your first month of Starter hosting, together. For new customers ordering from Bangladesh.',
   'একটি .site ডোমেইন আর Starter হোস্টিংয়ের প্রথম মাস — একসঙ্গে। বাংলাদেশ থেকে অর্ডার করা নতুন গ্রাহকদের জন্য।',
   'A .site domain, and your first month of hosting free',
   'ডোমেইন নিন, প্রথম মাসের হোস্টিং ফ্রি',
   'bundle', 256, 'all', 'site', 'starter', 1,
   0, 0, 1, 1,
   'BD', NULL, NULL, 1)
ON DUPLICATE KEY UPDATE
  description      = VALUES(description),
  description_bn   = VALUES(description_bn),
  headline         = VALUES(headline),
  headline_bn      = VALUES(headline_bn),
  kind             = VALUES(kind),
  value            = VALUES(value),
  applies_to       = VALUES(applies_to),
  requires_tld     = VALUES(requires_tld),
  grants_plan_slug = VALUES(grants_plan_slug),
  grants_months    = VALUES(grants_months),
  first_order_only = VALUES(first_order_only),
  public_offer     = VALUES(public_offer),
  countries        = VALUES(countries),
  active           = VALUES(active);

SELECT code, kind, value, requires_tld, grants_plan_slug, grants_months,
       countries, public_offer, active
  FROM coupons WHERE code = 'GODIGITAL';
