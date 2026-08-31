#!/usr/bin/env node
/**
 * Put the right registrant on domains that were registered with the wrong one.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, AND WHY THIS SCRIPT EXISTS
 * ---------------------------------------------------------------------------
 * `src/integrations/domainnameapi.js` sent its four contacts typed as
 * 'Registrant', 'Administrative', 'Technical' and 'Billing'. The REST gateway's
 * enum is 'Registrant', 'Admin', 'Tech', 'Billing'. An unrecognised contactType
 * is not rejected and does not appear in `validationErrors` — the gateway
 * silently DISCARDS the whole contacts array and substitutes the reseller
 * account's own default contact.
 *
 * So every domain registered before that fix carries OUR company details as the
 * registrant of record instead of the customer's. Measured on arpi.site: all
 * four contacts came back with the reseller account holder's name, email and
 * address, and all four shared a single handle (D-699021228819) — four
 * independently supplied contacts cannot collapse to one handle, which is what
 * gives the substitution away.
 *
 * That is not cosmetic. It puts the wrong legal person on the domain, sends
 * ICANN's verification mail to an inbox the owner does not read (which is
 * exactly how arpi.site sat unusable for nine hours), and for a .uk it is a
 * Nominet compliance breach.
 *
 * ---------------------------------------------------------------------------
 * USING IT
 * ---------------------------------------------------------------------------
 *     node scripts/fix-domain-contacts.js                 # report only
 *     node scripts/fix-domain-contacts.js --apply         # fix them
 *     node scripts/fix-domain-contacts.js --apply arpi.site
 *
 * DRY RUN BY DEFAULT. It writes nothing without `--apply`, because this talks to
 * a live registrar about live registrations and the first run should always be
 * somebody reading a list.
 *
 * It refuses to touch a domain whose customer record is incomplete rather than
 * filing a half-empty contact — a bad registrant is not an improvement on the
 * wrong one, and the registry may reject the update and leave the domain in a
 * worse state than it started.
 */

require('dotenv').config({ quiet: true });

const db = require('../src/db');
const registrar = require('../src/integrations/domainnameapi');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = args.filter((a) => !a.startsWith('--'));

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const RED = '\x1b[31m';
const GRN = '\x1b[32m'; const YLW = '\x1b[33m'; const RST = '\x1b[0m';

async function main() {
  if (!registrar.isConnected()) {
    console.log(`${YLW}DNA_MODE is '${process.env.DNA_MODE || 'mock'}' — nothing to check against a live registrar.${RST}`);
    return;
  }

  const rows = await db.query(
    `SELECT d.id, d.domain, d.status, d.source, d.registrar_ref,
            c.id AS customer_id, c.email, c.first_name, c.last_name, c.company,
            c.phone, c.address1, c.address2, c.city, c.postcode, c.country
       FROM domains d
       JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'active'
        AND d.source <> 'external'
        AND d.source <> 'subdomain'
      ORDER BY d.id`,
  );

  const targets = ONLY.length
    ? rows.filter((r) => ONLY.includes(r.domain))
    : rows;

  if (!targets.length) {
    console.log('No registered domains to check.');
    return;
  }

  console.log(`${BOLD}Checking ${targets.length} domain(s) at the registrar${RST}`);
  console.log(APPLY ? `${YLW}--apply: changes WILL be written.${RST}\n` : `${DIM}Dry run. Pass --apply to fix.${RST}\n`);

  let wrong = 0; let fixed = 0; let skipped = 0; let ok = 0;

  for (const row of targets) {
    const label = row.domain.padEnd(28);
    const wanted = String(row.email || '').trim().toLowerCase();

    /*
     * THE DRY RUN NEVER CALLS assertContacts.
     *
     * That function repairs what it finds, which is exactly right immediately
     * after a registration and exactly wrong here — a "dry run" that writes to
     * a live registrar is worse than no dry run at all, because the person
     * running it believes nothing happened. The read-only question has its own
     * function; this branch asks that one and stops.
     */
    if (!APPLY) {
      let current;
      try {
        current = await registrar.getDomainContacts(row.domain);
      } catch (err) {
        console.log(`${label} ${RED}could not read${RST} — ${err.message}`);
        continue;
      }
      const onRecord = String(current.registrant_email || '').toLowerCase();
      if (onRecord === wanted) {
        ok += 1;
        console.log(`${label} ${GRN}correct${RST} ${DIM}(${onRecord})${RST}`);
      } else {
        wrong += 1;
        console.log(`${label} ${RED}WRONG${RST} — registry has ${BOLD}${onRecord || 'nothing'}${RST}, should be ${BOLD}${wanted}${RST}`);
        if (current.single_handle) {
          console.log(`${' '.repeat(29)}${DIM}all four contacts share one handle — the gateway substituted its own${RST}`);
        }
        const gaps = registrar.contactGaps(row);
        if (gaps.length) {
          console.log(`${' '.repeat(29)}${YLW}cannot fix — customer record is missing ${gaps.join(', ')}${RST}`);
        }
      }
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    // --apply from here down. Check the customer record BEFORE writing: a
    // half-empty registrant is not an improvement on the wrong one.
    const gaps = registrar.contactGaps(row);
    if (gaps.length) {
      skipped += 1;
      console.log(`${label} ${YLW}skipped${RST} — customer record is missing ${gaps.join(', ')}`);
      continue;
    }

    let info;
    try {
      // Checks, and repairs if the registrant on record is not ours.
      info = await registrar.assertContacts(row.domain, row);
    } catch (err) {
      console.log(`${label} ${RED}could not check${RST} — ${err.message}`);
      continue;
    }

    if (info.contacts_verified && info.contacts_repaired) {
      fixed += 1;
      console.log(`${label} ${GRN}FIXED${RST} — registrant is now ${wanted}`);
    } else if (info.contacts_verified) {
      ok += 1;
      console.log(`${label} ${GRN}already correct${RST}`);
    } else {
      wrong += 1;
      console.log(`${label} ${RED}could not fix${RST} — ${info.contacts_warning || 'unknown'}`);
    }

    // Record what we found, so the panel's warning banner agrees with reality.
    await db.query(
      'UPDATE domains SET contacts_verified = ?, contacts_warning = ? WHERE id = ?',
      [info.contacts_verified ? 1 : 0, String(info.contacts_warning || '').slice(0, 300), row.id],
    );

    // The gateway 429s on concurrent calls; this loop is serial for that reason
    // and still needs a breath between domains.
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`\n${BOLD}Done.${RST} ${ok} correct, ${wrong} wrong, ${fixed} fixed, ${skipped} skipped.`);
  if (!APPLY && wrong) {
    console.log(`Run again with ${BOLD}--apply${RST} to correct them.`);
  }
}

main()
  .catch((err) => {
    console.error(`${RED}${err.stack || err.message}${RST}`);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
