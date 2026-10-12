"""Members at a venue who are the same person twice, and putting them back together (2026-10-12).

    python tool/merge_duplicate_members.py                      # look only: pontardawe-rfc
    python tool/merge_duplicate_members.py --slug the-crown     # another venue
    python tool/merge_duplicate_members.py --apply              # merge what it listed

The owner: "email anyhow matched or phone number matched means similar
account, no duplicate accounts same mail". The app no longer makes a second
member for an address it already holds (loyalty_app.js joinScheme), but live
already has some: signed in once with Apple and once with a code, or added at
the till and then joined in the app. This finds them and, with --apply, folds
each group into its OLDEST member -- the one whose card has been in a wallet
longest.

WHO COUNTS AS THE SAME PERSON

  * the same email address at the venue, ignoring case and spaces (Gmail's
    dots are NOT folded: the back office never has);
  * the same phone number, read the way the app reads one (dinein_otp.js
    cleanPhone: 07... is +447...), but only where that does not bring two
    DIFFERENT email addresses together -- a couple sharing a landline are two
    people.

LEFT FOR A PERSON TO SORT, never merged here: a group where anybody is on a
family plan (family_head_id; a parent and child may share an address on
purpose), and a group linked to two different Vesopa accounts.

WHAT A MERGE DOES, in one transaction per group, all or nothing:

  * every row in every table with a customer_id, family_head_id or subject_id
    column (found from information_schema, so a table added next month is not
    missed) that names a duplicate is moved to the member kept. Where the kept
    member already has the same row (a class booked twice, the same message in
    both inboxes) the duplicate's copy is dropped for the tables where that is
    harmless; anywhere else the group is rolled back and reported;
  * the app sessions of the duplicates are signed out (their tokens name the
    old member), so those phones sign in again and land on the member kept;
  * points, visits and spend are added together; the latest visit and expiry,
    the earliest join date are kept; anything the kept member lacks (a phone,
    a password, a photo, a card number, the Vesopa link...) is taken from a
    duplicate; the notes record which members were merged and their cards;
  * the duplicates are deleted.

Dry run by default: it prints every group and what --apply would move. Nothing
is written without --apply. Run from the repository root on the owner's PC,
like the other deploy tools (it runs node over SSH in the back office folder).
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_client_area_vesopa_connect as base  # noqa: E402
import deploy_memberships  # noqa: E402,F401  (loads .env.claude too)

USER = "vesopasoftware"
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
NODE = "PATH=/opt/nodejs/24/bin:$PATH"


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


SCRIPT = r"""
const fs = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config();
const { cleanPhone } = require('./src/dinein_otp');

// Tables where the kept member already holding the same row makes the
// duplicate's copy redundant: a position, an inbox entry, a booking.
const DROP_CLASHES = new Set(['epos_customer_locations', 'epos_customer_near', 'epos_push_inbox', 'epos_class_bookings']);
const SUM = ['points_balance', 'visits', 'lifetime_spend_minor'];
const LATEST = ['last_visit', 'membership_expiry', 'points_expire_on'];
const EARLIEST = ['joined_on'];
const FILL = ['email', 'phone', 'phone_verified_at', 'card_number', 'member_no', 'vesopa_sub', 'photo_url',
  'postcode', 'town', 'scheme_id', 'membership_status', 'tier_name'];

(async () => {
  const job = JSON.parse(fs.readFileSync(0, 'utf8'));
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, charset: 'utf8mb4',
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'vesopa_eposdb',
    dateStrings: true,
  });
  const [apps] = await db.query('SELECT office FROM epos_loyalty_app WHERE slug = ?', [job.slug]);
  if (apps.length !== 1) throw new Error(`no single venue with slug ${job.slug} (${apps.length})`);
  const office = apps[0].office;

  const [cols] = await db.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('customer_id', 'family_head_id', 'subject_id')`);
  const refs = cols.filter((r) => r.t !== 'epos_customers');
  const [custCols] = await db.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'epos_customers'`);
  const has = new Set(custCols.map((r) => r.c));

  const [people] = await db.query(
    'SELECT * FROM epos_customers WHERE email_key = ? ORDER BY created_at, id', [office]);
  console.log(`   ${people.length} members at ${job.slug} (${office})`);

  // ---- who is the same person ----------------------------------------------
  const parent = new Map(people.map((p) => [p.id, p.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const emailOf = (p) => { const e = String(p.email || '').trim().toLowerCase(); return e.includes('@') ? e : ''; };
  const emailsIn = (root) => new Set(people.filter((p) => find(p.id) === root).map(emailOf).filter(Boolean));
  const why = new Map();
  const join = (a, b, reason) => {
    const ra = find(a.id); const rb = find(b.id);
    if (ra === rb) return;
    parent.set(rb, ra);
    why.set(ra, new Set([...(why.get(ra) || []), ...(why.get(rb) || []), reason]));
  };
  const byKey = (key) => {
    const m = new Map();
    for (const p of people) { const k = key(p); if (k) m.set(k, [...(m.get(k) || []), p]); }
    return [...m.values()].filter((g) => g.length > 1);
  };
  for (const g of byKey(emailOf)) for (const p of g.slice(1)) join(g[0], p, 'email');
  for (const g of byKey((p) => (p.phone ? cleanPhone(String(p.phone)) : null))) {
    for (const p of g.slice(1)) {
      const together = new Set([...emailsIn(find(g[0].id)), ...emailsIn(find(p.id))]);
      if (together.size <= 1) join(g[0], p, 'phone');
    }
  }
  const groups = new Map();
  for (const p of people) groups.set(find(p.id), [...(groups.get(find(p.id)) || []), p]);
  const dupes = [...groups.entries()].filter(([, g]) => g.length > 1);
  if (!dupes.length) { console.log('   no duplicates'); await db.end(); return; }

  const heads = new Set(people.map((p) => p.family_head_id).filter(Boolean));
  let merged = 0; let skipped = 0; let failed = 0;
  for (const [root, group] of dupes) {
    const [keep, ...rest] = group; // oldest first
    const ids = rest.map((p) => p.id);
    console.log(`\n   ${keep.name} <${emailOf(keep) || '-'}> ${keep.phone || ''}  (same ${[...(why.get(root) || [])].join(' and ')})`);
    for (const p of group) {
      console.log(`     ${p === keep ? 'keep ' : 'merge'} ${p.id}  ${p.created_at}  ${p.name} <${p.email || '-'}> ${p.phone || ''}`
        + `  card ${p.card_number || '-'}  points ${p.points_balance || 0}`);
    }
    const family = group.some((p) => p.family_head_id || heads.has(p.id));
    const subs = new Set(group.map((p) => p.vesopa_sub).filter(Boolean));
    if (family || subs.size > 1) {
      console.log(`     LEFT ALONE: ${family ? 'on a family plan' : 'linked to two different Vesopa accounts'}; sort by hand`);
      skipped += 1;
      continue;
    }
    const moves = [];
    for (const r of refs) {
      const [[n]] = await db.query(`SELECT COUNT(*) AS n FROM \`${r.t}\` WHERE \`${r.c}\` IN (?)`, [ids]);
      if (Number(n.n)) moves.push({ ...r, n: Number(n.n) });
    }
    console.log(`     moves: ${moves.map((m) => `${m.t}.${m.c} ${m.n}`).join(', ') || 'nothing else refers to them'}`);
    if (!job.apply) continue;

    try {
      await db.beginTransaction();
      await db.query(
        'UPDATE epos_loyalty_app_sessions SET revoked_at = NOW() WHERE customer_id IN (?) AND revoked_at IS NULL', [ids]);
      for (const m of moves) {
        await db.query(`UPDATE IGNORE \`${m.t}\` SET \`${m.c}\` = ? WHERE \`${m.c}\` IN (?)`, [keep.id, ids]);
        const [[left]] = await db.query(`SELECT COUNT(*) AS n FROM \`${m.t}\` WHERE \`${m.c}\` IN (?)`, [ids]);
        if (Number(left.n)) {
          if (!DROP_CLASHES.has(m.t)) throw new Error(`${left.n} row(s) in ${m.t} clash with the kept member's`);
          await db.query(`DELETE FROM \`${m.t}\` WHERE \`${m.c}\` IN (?)`, [ids]);
        }
      }
      const set = {};
      for (const c of SUM) if (has.has(c)) set[c] = group.reduce((s, p) => s + (Number(p[c]) || 0), 0);
      for (const c of LATEST) if (has.has(c)) set[c] = group.map((p) => p[c]).filter(Boolean).sort().pop() || null;
      for (const c of EARLIEST) if (has.has(c)) set[c] = group.map((p) => p[c]).filter(Boolean).sort()[0] || null;
      for (const c of FILL) {
        if (has.has(c) && (keep[c] == null || keep[c] === '')) {
          const from = rest.find((p) => p[c] != null && p[c] !== '');
          if (from) set[c] = from[c];
        }
      }
      if (has.has('password_hash') && !keep.password_hash) {
        const from = rest.find((p) => p.password_hash);
        if (from) { set.password_hash = from.password_hash; set.password_set_at = from.password_set_at; }
      }
      if (has.has('marketing_opt_in')) set.marketing_opt_in = group.some((p) => Number(p.marketing_opt_in)) ? 1 : 0;
      const cards = rest.map((p) => p.card_number).filter((c) => c && c !== (set.card_number || keep.card_number));
      const note = `Merged ${new Date().toISOString().slice(0, 10)}: ${ids.join(', ')}${cards.length ? ` (cards ${cards.join(', ')})` : ''}`;
      set.notes = [keep.notes, note].filter(Boolean).join(' | ').slice(-500);
      // Duplicates out first, so a card or member number moving to the kept
      // member never meets itself on a unique index.
      await db.query('DELETE FROM epos_customers WHERE id IN (?) AND email_key = ?', [ids, office]);
      await db.query('UPDATE epos_customers SET ? WHERE id = ? AND email_key = ?', [set, keep.id, office]);
      await db.commit();
      merged += 1;
      console.log(`     merged into ${keep.id}${cards.length ? `; cards no longer on file: ${cards.join(', ')}` : ''}`);
    } catch (e) {
      await db.rollback();
      failed += 1;
      console.log(`     NOT MERGED (rolled back): ${e.message}`);
    }
  }
  console.log(`\n   ${dupes.length} group(s): ${job.apply ? `${merged} merged, ` : ''}${skipped} left for a person`
    + `${failed ? `, ${failed} failed` : ''}${job.apply ? '' : '. Nothing changed: run again with --apply to merge.'}`);
  await db.end();
})().catch((e) => { console.error('! ' + e.message); process.exit(1); });
"""


def main():
    slug = arg("--slug", "pontardawe-rfc")
    apply = "--apply" in sys.argv
    if not re.fullmatch(r"[a-z0-9-]+", slug):
        raise SystemExit("! that slug does not look right")
    job = json.dumps({"slug": slug, "apply": apply})
    print(f"== duplicate members at {slug}: {'MERGING' if apply else 'looking only'}")

    client = base.vesopa_ssh.connect()
    try:
        sftp = client.open_sftp()
        remote = f"{BACKOFFICE}/.merge_duplicates.js"
        try:
            with sftp.open(remote, "w") as f:
                f.write(SCRIPT)
        finally:
            sftp.close()
        stdin, stdout, stderr = client.exec_command(
            f"chown {USER}:{USER} {remote} && su - {USER} -c 'cd {BACKOFFICE} && {NODE} node .merge_duplicates.js'; "
            f"rc=$?; rm -f {remote}; exit $rc")
        stdin.write(job)
        stdin.channel.shutdown_write()
        out, err = stdout.read().decode(), stderr.read().decode()
        rc = stdout.channel.recv_exit_status()
        print(out.rstrip())
        if rc != 0:
            raise SystemExit(err.strip() or f"! failed ({rc})")
    finally:
        client.close()


if __name__ == "__main__":
    main()
