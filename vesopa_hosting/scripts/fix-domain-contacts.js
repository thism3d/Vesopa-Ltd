#!/usr/bin/env node
/**
 * Check that the registrant on record at the registry is the customer, and put
 * it right where it is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * A registrant of record is a legal fact about a domain, and nothing in this
 * system had ever verified one. It is worth auditing on its own terms: a wrong
 * registrant sends ICANN's verification mail to an inbox the owner does not
 * read, and for a .uk it is a Nominet compliance matter.
 *
 * The audit that prompted it (2026-09-01) found the registrants CORRECT —
 * vesopa.site and arpi.site each carry their own customer's details. What it
 * did find is that contacts registered before this release carry a WRONG PHONE
 * COUNTRY CODE: the adapter derived it as `phone.slice(1, 3)` with a '44'
 * default, so a Bangladeshi customer's 01752435220 was filed as +44 1752435220.
 * Re-sending the contact through the fixed `toContact()` corrects that, which
 * is most of what this script now does in practice.
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

      /*
       * The email is not the whole contact. A registrant whose address is right
       * and whose phone is filed under the wrong country is still wrong at the
       * registry — and it is the failure this audit actually keeps finding,
       * because the old `phone.slice(1, 3)` with a '44' default put a UK code on
       * every customer who typed their number without a "+".
       *
       * So the on-record contact is compared field by field against what the
       * fixed `toContact()` would send today.
       */
      const shouldBe = registrar.toContact(row, 'Registrant');
      const reg = current.contacts.find((c) => /registrant/i.test(c?.contactType || '')) || {};
      const drift = [];
      if (String(reg.phoneCountryCode || '') !== shouldBe.phoneCountryCode) {
        drift.push(`phone country code +${reg.phoneCountryCode || '?'} should be +${shouldBe.phoneCountryCode}`);
      }
      if (String(reg.phone || '').replace(/\D/g, '') !== shouldBe.phone) {
        drift.push(`phone ${reg.phone || '(none)'} should be ${shouldBe.phone}`);
      }
      if (String(reg.country || '').toUpperCase() !== shouldBe.country) {
        drift.push(`country ${reg.country || '(none)'} should be ${shouldBe.country}`);
      }
      if (String(reg.postalCode || '') !== shouldBe.postalCode) {
        drift.push(`postcode ${reg.postalCode || '(none)'} should be ${shouldBe.postalCode}`);
      }

      if (onRecord === wanted && drift.length) {
        wrong += 1;
        console.log(`${label} ${YLW}NEEDS UPDATING${RST} ${DIM}(${onRecord})${RST}`);
        for (const d of drift) console.log(`${' '.repeat(29)}${YLW}${d}${RST}`);
      } else if (onRecord === wanted) {
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

    /*
     * `updateContacts`, not `assertContacts`.
     *
     * assertContacts short-circuits the moment the registrant EMAIL matches, which
     * is exactly the case that still needs writing here: the email has always
     * been right and the phone country code has always been wrong. Pushing the
     * whole contact set unconditionally is idempotent — the gateway accepts an
     * unchanged contact with a 204 — and it is the only way the corrected phone
     * reaches the registry.
     */
    let info;
    try {
      info = await registrar.updateContacts({ domain: row.domain, contact: row });
    } catch (err) {
      console.log(`${label} ${RED}could not update${RST} — ${err.message}`);
      continue;
    }

    if (info.contacts_verified) {
      fixed += 1;
      console.log(`${label} ${GRN}UPDATED${RST} — registrant ${wanted}, +${registrar.toContact(row, 'Registrant').phoneCountryCode}`);
    } else {
      wrong += 1;
      console.log(`${label} ${RED}could not confirm${RST} — ${info.contacts_warning || 'unknown'}`);
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
