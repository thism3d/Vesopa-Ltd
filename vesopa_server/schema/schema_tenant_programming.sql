-- Give every office its own copy of the programming rows nobody owned.
--
-- WHAT WAS WRONG
--
-- `bo_tax_rates`, `bo_finalise_keys`, `bo_error_reasons`, `bo_vouchers` and
-- `bo_mix_match` all carry an `office_id`, and the back office was registering
-- them without telling the CRUD factory so. With no tenant column the factory
-- scopes nothing: the list ran `WHERE 1 = 1` and the update and delete ran
-- `WHERE id = ?`. Every office therefore read every other office's rows, and
-- could have edited or deleted them.
--
-- That is fixed in src/programming.js. This is the data half: the rows that
-- were seeded before `office_id` existed still have NULL in it, and a NULL
-- owner belongs to nobody, so once the routes are scoped those rows become
-- invisible to everybody — including the venues currently relying on them.
--
-- WHY A COPY EACH, RATHER THAN ONE OWNER
--
-- These are the platform's seed rows: Standard/Reduced/Zero VAT, the Cash,
-- Card and Voucher finalise keys, and a handful of void reasons. Every venue
-- can see them today, and every venue's till is using them right now.
--
-- Handing them to one office would take the other venues' VAT rates and their
-- Cash and Card keys away, which is a till that cannot finish a sale. So each
-- office gets its own copy instead. Nothing changes on any venue's screen; what
-- changes is that from here on each venue is editing only its own.
--
-- The originals are then deleted, because a row owned by nobody is exactly the
-- thing this migration exists to remove.
--
-- RE-RUNNABLE
--
-- `deploy.sh --schema` re-applies every migration every time. The copy is
-- guarded by NOT EXISTS on the office/name pair, so a second run copies
-- nothing, and by then there are no NULL rows left to copy anyway.

-- ---------------------------------------------------------------------------
-- Tax rates
-- ---------------------------------------------------------------------------
INSERT INTO bo_tax_rates (office_id, name, percentage, is_default, sort_order)
SELECT o.id, t.name, t.percentage, t.is_default, t.sort_order
  FROM bo_tax_rates t
  CROSS JOIN offices o
 WHERE t.office_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM bo_tax_rates x
      WHERE x.office_id = o.id AND x.name = t.name
   );

DELETE FROM bo_tax_rates WHERE office_id IS NULL;

-- ---------------------------------------------------------------------------
-- Finalise keys — how a sale is paid for. A venue without these cannot trade.
-- ---------------------------------------------------------------------------
INSERT INTO bo_finalise_keys (office_id, name, kind, opens_drawer, sort_order)
SELECT o.id, f.name, f.kind, f.opens_drawer, f.sort_order
  FROM bo_finalise_keys f
  CROSS JOIN offices o
 WHERE f.office_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM bo_finalise_keys x
      WHERE x.office_id = o.id AND x.name = f.name
   );

DELETE FROM bo_finalise_keys WHERE office_id IS NULL;

-- ---------------------------------------------------------------------------
-- Void and refund reasons
--
-- Matched on the reason *and* what it applies to: "Customer changed their mind"
-- is a different row as a void from as a refund.
-- ---------------------------------------------------------------------------
INSERT INTO bo_error_reasons (office_id, reason, applies_to, sort_order)
SELECT o.id, e.reason, e.applies_to, e.sort_order
  FROM bo_error_reasons e
  CROSS JOIN offices o
 WHERE e.office_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM bo_error_reasons x
      WHERE x.office_id = o.id
        AND x.reason = e.reason
        AND x.applies_to <=> e.applies_to
   );

DELETE FROM bo_error_reasons WHERE office_id IS NULL;

-- ---------------------------------------------------------------------------
-- Mix & match deals
--
-- A deal is a real trading offer rather than a platform default, so an unowned
-- one is a row somebody made before the column existed. Copied on the same
-- rule as the rest: better every venue keeps what it can see today than one
-- venue silently loses a deal that is running.
-- ---------------------------------------------------------------------------
INSERT INTO bo_mix_match (office_id, name, trigger_qty, deal_price_minor, active, sort_order)
SELECT o.id, m.name, m.trigger_qty, m.deal_price_minor, m.active, m.sort_order
  FROM bo_mix_match m
  CROSS JOIN offices o
 WHERE m.office_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM bo_mix_match x
      WHERE x.office_id = o.id AND x.name = m.name
   );

DELETE FROM bo_mix_match WHERE office_id IS NULL;

-- ---------------------------------------------------------------------------
-- Vouchers
--
-- A voucher code is redeemed by joining through office_id, so an unowned one
-- was never redeemable anywhere. There are none today; this is here so that a
-- database that does have one does not keep a row no office can see.
-- ---------------------------------------------------------------------------
INSERT INTO bo_vouchers (office_id, code, name, discount_type, value, expires_on,
                         active, sort_order)
SELECT o.id, v.code, v.name, v.discount_type, v.value, v.expires_on,
       v.active, v.sort_order
  FROM bo_vouchers v
  CROSS JOIN offices o
 WHERE v.office_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM bo_vouchers x
      WHERE x.office_id = o.id AND x.code = v.code
   );

DELETE FROM bo_vouchers WHERE office_id IS NULL;
