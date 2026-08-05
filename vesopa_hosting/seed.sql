-- ---------------------------------------------------------------------------
-- Starting catalogue for hosting.vesopaepos.com.
--
-- Prices are a considered first pass, not a quote — every one is editable in
-- the admin. The shape is the standard three-tier ladder the UK market has
-- trained customers to expect, priced against Hostinger/IONOS/Krystal for a
-- small-business buyer, with the discount carried on the *term* rather than as
-- a permanent "was £X" that nobody believes.
--
-- Everything is in pence. Monthly is the true monthly rate; annual and biennial
-- are the total for the whole term.
--
-- Idempotent: re-running updates prices rather than duplicating rows.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

-- ---------------------------------------------------------------------------
-- Shared hosting
--
-- Starter  £2.99/mo  — one site. The "move my existing site" price.
-- Business £5.99/mo  — the one most people should buy: 25 sites, daily backups.
-- Pro      £11.99/mo — NVMe headroom, priority support, 100 sites.
--
-- Four terms: 1 month, 1 year, 2 years, 3 years. The longer the term, the
-- better the rate — the ladder every established host runs, and the one buyers
-- now expect to see.
--
--   1 month   full rate, no commitment, no free domain
--   1 year    half the monthly rate      — saves 50%
--   2 years   a little under half        — saves 57%
--   3 years   the best rate we do        — saves 62%
--
-- The monthly price is deliberately the premium one. A customer who wants to
-- leave at any time is genuinely more expensive to carry: they are the churn,
-- and the free domain and the migration labour cannot be earned back over four
-- weeks. Pricing month-to-month at a premium is what makes the yearly rate a
-- real offer rather than a fake discount off an invented list price.
--
-- The headline rates a customer remembers — £2.99, £5.99, £11.99 — are the
-- 1-year rates, which is the term the pricing table opens on.
--
-- IMPORTANT: none of this is a renewal trick. Each term renews at the same
-- price it was bought at; the site promises that in writing and the plan card
-- prints it under every price.
--
-- free_domain is now 1 on ALL THREE plans, but it is only ever granted on a
-- term of 12 months or more — never on the monthly plan, where a customer could
-- take a £6.99 domain and leave after paying £5.99. The flag stays per-plan so
-- the perk can be withdrawn from a tier without a deploy.
-- ---------------------------------------------------------------------------
INSERT INTO plans
  (slug, name, tagline, monthly_pence, annual_pence, biennial_pence, triennial_pence,
   websites, storage_gb, bandwidth_gb, `databases`, mailboxes,
   free_domain, free_ssl, daily_backups, priority_support,
   hestia_package, badge, sort_order, active, features)
VALUES
  ('starter', 'Starter', 'One website, done properly.',
   599, 3588, 6216, 8244,
   1, 25, 0, 2, 5,
   1, 1, 0, 0,
   'starter', '', 10, 1,
   'Free SSL certificate, renewed automatically\nFree domain on any 1, 2 or 3 year plan\nWeekly off-site backups\nOne-click WordPress install\nUK data centre\n99.9% uptime commitment\nEmail and ticket support'),

  ('business', 'Business', 'Everything a growing business needs.',
   1199, 7188, 12456, 16524,
   25, 100, 0, 25, 50,
   1, 1, 1, 0,
   'business', 'Most popular', 20, 1,
   'Everything in Starter\nFree domain on any 1, 2 or 3 year plan\nDaily backups, restore yourself\nFree website migration\nStaging site\nUnmetered bandwidth\nWordPress toolkit'),

  ('pro', 'Pro', 'For sites that earn their keep.',
   2399, 14388, 24936, 33084,
   100, 250, 0, 100, 200,
   1, 1, 1, 1,
   'pro', '', 30, 1,
   'Everything in Business\nNVMe storage with dedicated resources\nPriority support, answered first\nDaily backups kept for 30 days\nFree dedicated IP\nAdvanced caching\nUptime monitoring')
ON DUPLICATE KEY UPDATE
  name             = VALUES(name),
  tagline          = VALUES(tagline),
  monthly_pence    = VALUES(monthly_pence),
  annual_pence     = VALUES(annual_pence),
  biennial_pence   = VALUES(biennial_pence),
  triennial_pence  = VALUES(triennial_pence),
  websites         = VALUES(websites),
  storage_gb       = VALUES(storage_gb),
  bandwidth_gb     = VALUES(bandwidth_gb),
  `databases`      = VALUES(`databases`),
  mailboxes        = VALUES(mailboxes),
  free_domain      = VALUES(free_domain),
  free_ssl         = VALUES(free_ssl),
  daily_backups    = VALUES(daily_backups),
  priority_support = VALUES(priority_support),
  hestia_package   = VALUES(hestia_package),
  badge            = VALUES(badge),
  sort_order       = VALUES(sort_order),
  features         = VALUES(features);

-- ---------------------------------------------------------------------------
-- Email — a separate product line, priced separately.
--
-- Two families that get bought for completely different reasons:
--
--   business   Mailboxes at your own domain. Priced PER MAILBOX per month,
--              because that is the unit a buyer counts ("I need four"). Every
--              hosting plan already includes mailboxes, so this is for someone
--              who wants email WITHOUT hosting a site with us, or who has
--              outgrown what their plan includes.
--
--   marketing  Bulk sending — campaigns, lists, delivery reporting. Priced per
--              1,000 contacts, the unit every competitor uses, so the page can
--              be compared honestly against Mailchimp.
--
-- Same term logic as hosting: monthly is the premium, annual saves 25%. The
-- discount is smaller than on hosting because there is no domain and no
-- migration labour to earn back.
-- ---------------------------------------------------------------------------
INSERT INTO email_plans
  (slug, family, name, tagline, unit_label, monthly_pence, annual_pence,
   storage_gb, min_units, max_units, monthly_sends, badge, sort_order, active, features)
VALUES
  ('email-lite', 'business', 'Email Lite', 'A proper address at your own domain.',
   'mailbox', 199, 1788,
   10, 1, 200, 0, '', 10, 1,
   'you@yourbusiness.co.uk\n10 GB per mailbox\nWebmail, plus IMAP on your phone\nSpam and virus filtering\nCalendar and contacts\nFree migration from your old provider'),

  ('email-pro', 'business', 'Email Pro', 'For a team that lives in its inbox.',
   'mailbox', 399, 3588,
   50, 1, 500, 0, 'Most popular', 20, 1,
   'Everything in Email Lite\n50 GB per mailbox\nShared and group mailboxes\nEmail aliases, as many as you like\nRetention and archive policy\nPriority support'),

  ('marketing-essentials', 'marketing', 'Marketing Essentials', 'Newsletters that reach the inbox.',
   '1,000 contacts', 999, 8988,
   0, 1, 100, 10000, '', 30, 1,
   'Up to 10,000 sends a month\nDrag-and-drop campaign builder\nSigned with SPF, DKIM and DMARC\nOpen and click reporting\nSignup forms for your site\nUnsubscribe handling done for you'),

  ('marketing-pro', 'marketing', 'Marketing Pro', 'Automation, segments and real reporting.',
   '1,000 contacts', 1999, 17988,
   0, 1, 500, 50000, '', 40, 1,
   'Everything in Essentials\nUp to 50,000 sends a month\nAutomated sequences and triggers\nList segmentation\nA/B subject line testing\nDedicated sending IP available')
ON DUPLICATE KEY UPDATE
  family        = VALUES(family),
  name          = VALUES(name),
  tagline       = VALUES(tagline),
  unit_label    = VALUES(unit_label),
  monthly_pence = VALUES(monthly_pence),
  annual_pence  = VALUES(annual_pence),
  storage_gb    = VALUES(storage_gb),
  min_units     = VALUES(min_units),
  max_units     = VALUES(max_units),
  monthly_sends = VALUES(monthly_sends),
  badge         = VALUES(badge),
  sort_order    = VALUES(sort_order),
  features      = VALUES(features);

-- ---------------------------------------------------------------------------
-- TLD price list
--
-- cost_pence is roughly what DomainNameAPI charges a reseller; it is here so
-- the margin shows in the admin instead of being worked out on a calculator.
-- Verify every one against your actual reseller rate card before going live —
-- these are informed estimates, and .co.uk in particular varies by volume.
--
-- The .com first-year price is deliberately near cost. It is the number every
-- comparison starts from, and the money is made on the hosting attached to it
-- and on renewal, which is priced honestly rather than as a cliff.
-- ---------------------------------------------------------------------------
INSERT INTO tlds
  (tld, register_pence, renew_pence, transfer_pence, cost_pence, min_years, featured, sort_order, active)
VALUES
  ('com',     999, 1499, 1199,  850, 1, 1, 10, 1),
  ('co.uk',   699,  999,  699,  550, 1, 1, 20, 1),
  ('uk',      699,  999,  699,  550, 1, 1, 30, 1),
  ('net',    1199, 1699, 1399, 1050, 1, 1, 40, 1),
  ('org',    1099, 1599, 1299,  950, 1, 1, 50, 1),
  ('io',     3999, 4999, 4499, 3600, 1, 1, 60, 1),
  ('shop',    299, 2999, 2499,  250, 1, 1, 70, 1),
  ('online',  199, 3299, 2799,  180, 1, 1, 80, 1),
  ('store',   299, 4499, 3999,  250, 1, 0, 90, 1),
  ('site',    199, 2999, 2499,  180, 1, 0, 100, 1),
  ('dev',    1299, 1499, 1399, 1150, 1, 0, 110, 1),
  ('app',    1399, 1599, 1499, 1250, 1, 0, 120, 1),
  ('cloud',   899, 2299, 1999,  800, 1, 0, 130, 1),
  ('tech',    499, 4299, 3799,  450, 1, 0, 140, 1),
  ('agency',  399, 2799, 2399,  350, 1, 0, 150, 1),
  ('studio',  999, 2999, 2599,  900, 1, 0, 160, 1),
  ('design', 3499, 3999, 3699, 3200, 1, 0, 170, 1),
  ('info',    499, 2199, 1899,  450, 1, 0, 180, 1),
  ('biz',     899, 1899, 1599,  800, 1, 0, 190, 1),
  ('me',      899, 2499, 2199,  800, 1, 0, 200, 1),
  ('eu',      599,  899,  699,  500, 1, 0, 210, 1),
  ('wales',  1999, 2499, 2299, 1800, 1, 0, 220, 1),
  ('london', 2499, 2999, 2799, 2200, 1, 0, 230, 1)
ON DUPLICATE KEY UPDATE
  register_pence = VALUES(register_pence),
  renew_pence    = VALUES(renew_pence),
  transfer_pence = VALUES(transfer_pence),
  cost_pence     = VALUES(cost_pence),
  featured       = VALUES(featured),
  sort_order     = VALUES(sort_order),
  active         = VALUES(active);

-- ---------------------------------------------------------------------------
-- The Azure node. Hostname and IP are filled in from the admin once DNS is
-- pointed; the row exists so services have somewhere to be allocated.
-- ---------------------------------------------------------------------------
INSERT INTO servers (name, hostname, ip, api_port, location, max_accounts, active, notes)
VALUES
  ('vh1', 'vh1.vesopaepos.com', '', 8083, 'Azure — UK South', 200, 1,
   'HestiaCP on Ubuntu 24.04 LTS. Set the hostname and IP here once DNS points at the box.')
ON DUPLICATE KEY UPDATE
  location     = VALUES(location),
  max_accounts = VALUES(max_accounts),
  notes        = VALUES(notes);

-- ---------------------------------------------------------------------------
-- Editable copy and switches.
-- ---------------------------------------------------------------------------
INSERT INTO settings (name, value) VALUES
  ('company_name',      'Vesopa EPOS Ltd'),
  ('support_email',     'hosting@vesopaepos.com'),
  ('support_phone',     '+44 7501 928043'),
  ('address',           '1 High Street, Pontardawe, Swansea, SA8 4HU'),
  ('vat_number',        ''),
  ('announcement',      ''),
  ('money_back_days',   '30'),
  ('uptime_promise',    '99.9')
ON DUPLICATE KEY UPDATE value = VALUES(value);

-- ---------------------------------------------------------------------------
-- Currencies.
--
-- GBP is the base: every `*_pence` column above is sterling, and the other two
-- rows say how that becomes a dollar price. USD is the default because it is
-- what "everywhere that is not Britain or Canada" gets, and that is most of
-- the world.
--
-- THE RATES BELOW ARE A STARTING POINT AND SHOULD BE SET DELIBERATELY. They are
-- not a live feed and are not meant to be — they are the commercial rate the
-- business chooses to sell at, which is normally a little above the mid-market
-- rate to cover the card processor's own conversion and its margin. Set them in
-- the admin under Currencies once, and revisit when the pound moves enough to
-- matter rather than every morning.
--
-- `charm9` is what turns £5.99 × 1.27 = $7.6073 into $7.59, and it is applied
-- to the PER-MONTH figure rather than the term total — so a yearly plan reads
-- $3.79/mo and bills $45.48, both of which look like prices and agree with each
-- other when a customer multiplies.
--
-- Not `charm99`: whole-unit steps are far too coarse down at the cheap end of
-- this ladder. The 2-year and 3-year rungs are £2.59 and £2.29, and BOTH round
-- to $2.99 under charm99 — the longer term would cost the same per month and
-- save the customer nothing. The currencies screen flags that if it happens.
--
-- VAT is 20% inside the GBP price and ZERO in the others. UK VAT is not
-- chargeable on these services to a consumer outside the UK, so a dollar price
-- carries none and no VAT line is drawn at all. If that is not the right
-- treatment for your registration status, this column is where you change it —
-- not in the code.
-- ---------------------------------------------------------------------------
INSERT INTO currencies
  (code, name, symbol, locale, rate, rounding, vat_percent, vat_label, countries,
   is_base, is_default, active, sort_order)
VALUES
  -- The base. rate 1, rounding `exact` — a rounding rule here would rewrite
  -- the prices an admin typed by hand, which is never what anyone wants.
  ('GBP', 'British pound',   '£',   'en-GB', 1.000000, 'exact',   20.00, 'VAT',
   'GB,IM,JE,GG', 1, 0, 1, 1),
  ('USD', 'US dollar',       '$',   'en-US', 1.270000, 'charm9',   0.00, '',
   '', 0, 1, 1, 2),
  -- "CA$" rather than a bare "$": a Canadian price list that just says $ is
  -- ambiguous next to the US one on the same site, and the ambiguity always
  -- resolves in the direction of the customer feeling misled.
  ('CAD', 'Canadian dollar', 'CA$', 'en-CA', 1.720000, 'charm9',   0.00, '',
   'CA', 0, 0, 1, 3)
ON DUPLICATE KEY UPDATE
  name       = VALUES(name),
  symbol     = VALUES(symbol),
  locale     = VALUES(locale),
  rounding   = VALUES(rounding),
  vat_label  = VALUES(vat_label),
  countries  = VALUES(countries),
  is_base    = VALUES(is_base),
  is_default = VALUES(is_default),
  active     = VALUES(active),
  sort_order = VALUES(sort_order);
-- `rate` and `vat_percent` are deliberately NOT in the update list: re-running
-- the seed after an admin has set a real rate must not stamp it back to the
-- placeholder above. They are set once, on first insert, and owned by the admin
-- from then on.
