#!/usr/bin/env node
/**
 * Find domains the registry has and our database does not, and write them down.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS REPAIRS
 * ---------------------------------------------------------------------------
 * `provisionDomain()` calls the registrar and THEN records the result. If the
 * call throws after the registry has already acted — an EPP timeout, a gateway
 * error returned on a request that nonetheless landed — the name is registered,
 * the money is spent, and our row is still `pending` with an empty
 * `registrar_ref`.
 *
 * A pending domain is not a domain as far as the rest of the panel is
 * concerned. It has no expiry to show, the order that created it never leaves
 * `provisioning`, and the customer cannot attach it to their hosting — so the
 * experience is a domain they have paid for, which resolves, which the panel
 * will not let them use, and which fails again every time they retry.
 *
 * `arpi.site` was exactly this: registered at the registry 2026-08-31 10:01 UTC,
 * `domain.register_failed — An error occurred in the EPP integration` in our log
 * at 08:00 UTC, and the row left pending for a customer who then spent hours
 * trying to work out why they could not use it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT AUTOMATIC
 * ---------------------------------------------------------------------------
 * Because "the registry has this name" is not the same statement as "this name
 * is ours". `domains/info` answers for names on THIS reseller account, which is
 * the check that makes adopting one safe — but adopting a registration into a
 * customer's account is not something to do on a timer without anybody looking.
 *
 *     node scripts/reconcile-domains.js            # report only
 *     node scripts/reconcile-domains.js --apply
 *     node scripts/reconcile-domains.js --apply arpi.site
 */

require('dotenv').config({ quiet: true });

const db = require('../src/db');
const registrar = require('../src/integrations/domainnameapi');
const { NAMESERVERS } = require('../src/config');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = args.filter((a) => !a.startsWith('--'));

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const RED = '\x1b[31m';
const GRN = '\x1b[32m'; const YLW = '\x1b[33m'; const RST = '\x1b[0m';

async function main() {
  if (!registrar.isConnected()) {
    console.log(`${YLW}DNA_MODE is '${process.env.DNA_MODE || 'mock'}' — nothing to reconcile against.${RST}`);
    return;
  }

  /*
   * Only names we were supposed to have registered. An `external` domain is one
   * the customer holds somewhere else and is not ours to adopt, and a
   * `subdomain` has no registration of its own at all.
   */
  const rows = await db.query(
    `SELECT d.*, c.email
       FROM domains d
       JOIN customers c ON c.id = d.customer_id
      WHERE d.source = 'registered'
        AND d.status IN ('pending', 'awaiting_ns')
      ORDER BY d.id`,
  );

  const targets = ONLY.length ? rows.filter((r) => ONLY.includes(r.domain)) : rows;

  if (!targets.length) {
    console.log('Nothing to reconcile — no registered domain is stuck pending.');
    return;
  }

  console.log(`${BOLD}Checking ${targets.length} pending domain(s) against the registry${RST}`);
  console.log(APPLY ? `${YLW}--apply: changes WILL be written.${RST}\n` : `${DIM}Dry run. Pass --apply to fix.${RST}\n`);

  let adopted = 0; let genuinelyPending = 0;

  for (const row of targets) {
    const label = row.domain.padEnd(24);

    let info;
    try {
      info = await registrar.getDomain(row.domain);
    } catch (err) {
      // "could not be found" is the healthy answer here: the registration
      // really did fail, the row really is pending, and nothing needs doing.
      if (/could not be found|not found/i.test(err.message)) {
        genuinelyPending += 1;
        console.log(`${label} ${DIM}genuinely pending — the registry does not have it${RST}`);
      } else {
        console.log(`${label} ${RED}could not check${RST} — ${err.message}`);
      }
      await pause();
      continue;
    }

    const expires = info.expires_at || null;
    console.log(`${label} ${YLW}REGISTERED AT THE REGISTRY${RST} but pending here`
      + `${expires ? ` ${DIM}(expires ${expires})${DIM}${RST}` : ''}`);

    if (!APPLY) {
      console.log(`${' '.repeat(25)}${DIM}would set status=active, ref=${info.registrar_ref || '(none)'}${RST}`);
      await pause();
      continue;
    }

    /*
     * `expires_at` is what the REGISTRY says, not a year from today. Guessing it
     * would put a wrong renewal date in front of the customer and, worse, drive
     * the expiry warnings off a date the registry does not agree with.
     */
    await db.query(
      `UPDATE domains
          SET status = 'active',
              registrar_ref = ?,
              registered_at = COALESCE(registered_at, CURDATE()),
              expires_at = COALESCE(?, expires_at),
              ns1 = ?, ns2 = ?
        WHERE id = ?`,
      [
        String(info.registrar_ref || info.domain || ''),
        expires,
        NAMESERVERS[0] || '', NAMESERVERS[1] || '',
        row.id,
      ],
    );

    await db.logActivity({
      actorType: 'system',
      action: 'domain.reconciled',
      target: row.domain,
      detail: 'The registry had this name while our record said pending — adopted.',
      ok: true,
    }).catch(() => {});

    adopted += 1;
    console.log(`${' '.repeat(25)}${GRN}adopted — now active${RST}`);
    await pause();
  }

  /*
   * An order sits in `provisioning` until everything on it has succeeded. A
   * domain adopted above was the thing holding one open, so any order whose
   * every part is now done is closed here — otherwise the customer's panel goes
   * on saying "setting up" forever about work that finished.
   */
  if (APPLY && adopted) {
    const [res] = await db.pool.query(
      `UPDATE orders o
          SET o.status = 'active'
        WHERE o.status = 'provisioning'
          AND NOT EXISTS (
            SELECT 1 FROM domains d
             WHERE d.order_id = o.id AND d.status IN ('pending', 'awaiting_ns')
          )
          AND NOT EXISTS (
            SELECT 1 FROM services s
             WHERE s.order_id = o.id AND s.status = 'pending'
          )`,
    );
    if (res.affectedRows) console.log(`\n${GRN}${res.affectedRows} order(s) moved from provisioning to active.${RST}`);
  }

  console.log(`\n${BOLD}Done.${RST} ${adopted} adopted, ${genuinelyPending} genuinely pending.`);
  if (!APPLY && adopted === 0 && genuinelyPending < targets.length) {
    console.log(`Run again with ${BOLD}--apply${RST} to adopt them.`);
  }
}

// The gateway 429s on concurrent calls, so this loop is serial and paced.
const pause = () => new Promise((r) => setTimeout(r, 800));

main()
  .catch((err) => {
    console.error(`${RED}${err.stack || err.message}${RST}`);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
