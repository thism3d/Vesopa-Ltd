"""Give the app stores' review member a believable few months at the club (2026-10-12).

    python tool/seed_review_member.py test@test.com
    python tool/seed_review_member.py test@test.com --slug pontardawe-rfc --name "Alex Morgan"
    python tool/seed_review_member.py test@test.com --remove

The reviewer signs in as the member tool/make_review_member.py made (run that
first). A member made that morning has an empty card, no activity and no news,
so every screen a reviewer opens says "nothing yet" -- which reads as an
unfinished app. This gives that one member what a real one has after a season:

  * a name (default "Alex Morgan") and a member-since date four months back
  * the venue's membership plan, active, running to the club's renewal date
    or the plan's term (if the venue has membership plans)
  * sixteen weeks of points: the club's real home matches this season (from
    the WRU, with the scores), Friday nights at the bar, food, and one reward
    spent, with the balance, visits and last visit to match
  * the club's real news in their inbox: the latest result, a postponement,
    the next home game and the club's own latest story (from the WRU and
    PontardaweRFC/website/content/news.json), plus whatever the club sent
    everybody

ONLY THAT MEMBER, AND ONLY A TEST ADDRESS. Anything but an @test.com address is
refused here and again on the server, and every statement names the member's
id. Everything it writes is marked as its own (ids starting 5eed0000, the
membership event's note, the messages' created_by), so running it again
replaces what it wrote last time rather than adding to it, and --remove takes
it all away. Nothing a real member, sale or report touches is changed.

Run from the repository root on the owner's PC, like the other deploy tools.
"""
import json
import os
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
const crypto = require('crypto');
const mysql = require('mysql2/promise');
require('dotenv').config();

const MARK = '5eed0000';
const NOTE = 'seed:review member';
const seededId = () => MARK + crypto.randomUUID().slice(8);

// The same history every run, so a reviewer who comes back sees the same card.
let seed = 1881;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (list) => list[Math.floor(rand() * list.length)];


(async () => {
  const job = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!/^[^@\s]+@test\.com$/i.test(job.email)) throw new Error('only an @test.com member is ever seeded');
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, charset: 'utf8mb4',
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'vesopa_eposdb',
    dateStrings: true,
  });
  const has = async (table, column) => {
    const [r] = await db.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]);
    return r.length > 0;
  };

  const [apps] = await db.query('SELECT office FROM epos_loyalty_app WHERE slug = ?', [job.slug]);
  if (apps.length !== 1) throw new Error(`no single venue with slug ${job.slug} (${apps.length})`);
  const office = apps[0].office;
  const [found] = await db.query(
    'SELECT id, name, created_at FROM epos_customers WHERE email_key = ? AND LOWER(email) = ? ORDER BY created_at',
    [office, job.email.toLowerCase()]);
  if (found.length !== 1) {
    throw new Error(found.length ? `${found.length} members have ${job.email}; expected one`
      : `no member ${job.email} at ${job.slug}: run tool/make_review_member.py first`);
  }
  const me = found[0].id;
  console.log(`   member ${me} at office ${office}`);

  // ---- Out with what the last run wrote ---------------------------------
  const [gone1] = await db.execute(
    'DELETE FROM epos_loyalty_txns WHERE office = ? AND customer_id = ? AND id LIKE ?', [office, me, MARK + '%']);
  const [mine] = await db.query(
    'SELECT id FROM epos_push_messages WHERE office = ? AND id LIKE ? AND created_by = ?',
    [office, MARK + '%', `seed_review_member:${me}`]);
  const ids = mine.map((m) => m.id);
  if (ids.length) {
    await db.query('DELETE FROM epos_push_inbox WHERE customer_id = ? AND message_id IN (?)', [me, ids]);
    await db.query('DELETE FROM epos_push_messages WHERE id IN (?)', [ids]);
  }
  let gone3 = 0;
  try {
    const [r] = await db.execute(
      'DELETE FROM epos_membership_events WHERE office = ? AND customer_id = ? AND note = ?', [office, me, NOTE]);
    gone3 = r.affectedRows;
  } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
  console.log(`   removed last run's rows: ${gone1.affectedRows} points, ${ids.length} messages, ${gone3} membership events`);

  if (job.remove) {
    const [[left]] = await db.query(
      'SELECT COALESCE(SUM(points), 0) AS p, COUNT(*) AS n FROM epos_loyalty_txns WHERE office = ? AND customer_id = ?',
      [office, me]);
    await db.execute('UPDATE epos_customers SET points_balance = ? WHERE id = ? AND email_key = ?',
      [Math.max(0, Number(left.p)), me, office]);
    console.log(`   points back to ${Math.max(0, Number(left.p))} (from ${left.n} real rows)`);
    await db.end();
    return;
  }

  // ---- The club's rules, so the numbers add up the way its tills would ----
  const [[settings]] = await db.query('SELECT * FROM epos_loyalty_settings WHERE office = ?', [office]).catch(() => [[null]]);
  const perPound = Math.max(1, Number(settings && settings.points_per_pound) || 1);
  const minRedeem = Math.max(50, Number(settings && settings.min_redeem_points) || 100);

  // ---- The membership ---------------------------------------------------
  const today = new Date();
  const daysAgo = (n, hour = 12, minute = 0) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const day = (d) => d.toISOString().slice(0, 10);
  const joined = daysAgo(16 * 7 + 3, 19, 10);

  let plan = null;
  if (await has('epos_loyalty_schemes', 'is_membership')) {
    const [plans] = await db.query(
      `SELECT * FROM epos_loyalty_schemes WHERE office = ? AND is_membership = 1 AND active = 1
        ORDER BY is_default DESC, sort_order, id`, [office]);
    plan = plans[0] || null;
  }
  let expiry = settings && settings.membership_renewal_date ? String(settings.membership_renewal_date).slice(0, 10) : '';
  if (!expiry || expiry <= day(today)) {
    const months = Number((plan && plan.membership_term_months) || (settings && settings.membership_term_months)) || 12;
    const end = new Date(joined);
    end.setMonth(end.getMonth() + months);
    expiry = day(end);
  }

  // ---- Sixteen weeks at the club ----------------------------------------
  const rows = [];
  const earn = (when, spendPence, note) => rows.push({ when, kind: 'earn', spend: spendPence,
    points: Math.floor(spendPence / 100) * perPound, note });
  // The club's real home games (from the WRU, read on the PC), by day.
  const homeGames = new Map((job.matches || []).map((m) => [m.day, m]));
  for (let week = 16; week >= 0; week--) {
    const saturday = week * 7 + ((today.getDay() + 1) % 7); // days back to that week's Saturday
    if (saturday <= 0) continue;
    const game = homeGames.get(day(daysAgo(saturday)));
    if (game) {
      const score = game.us != null && (game.us || game.them) ? ` (${game.us}-${game.them})` : '';
      earn(daysAgo(saturday, 14, 5), 500, `Match day: Pontardawe v ${game.opponent}${score}`);
      earn(daysAgo(saturday, 16, 40 + Math.floor(rand() * 15)), pick([920, 1380, 1460, 1840]), 'Bar');
      if (rand() < 0.6) earn(daysAgo(saturday, 17, 30), pick([650, 795, 1150]), 'Clubhouse food');
    } else if (week % 2 === 0) {
      earn(daysAgo(saturday, 19, 20 + Math.floor(rand() * 30)), pick([920, 1380, 1460]), 'Bar');
      if (rand() < 0.4) earn(daysAgo(saturday, 19, 50), pick([650, 795, 1150]), 'Clubhouse food');
    } else if (rand() < 0.7) {
      earn(daysAgo(saturday + 1, 20, 10 + Math.floor(rand() * 40)), pick([460, 920, 1380]), 'Bar');
    }
  }
  rows.sort((a, b) => a.when - b.when);
  // One reward spent, about halfway through, once there was enough.
  let running = 0;
  let spent = false;
  for (let i = 0; i < rows.length; i++) {
    running += rows[i].points;
    if (!spent && running >= minRedeem && i > rows.length / 2) {
      const when = new Date(rows[i].when.getTime() + 25 * 60 * 1000);
      rows.splice(i + 1, 0, { when, kind: 'redeem', spend: 0, points: -minRedeem, note: 'Reward: a pint on the club' });
      spent = true;
      i++;
      running -= minRedeem;
    }
  }

  const [[older]] = await db.query(
    'SELECT COALESCE(SUM(points), 0) AS p FROM epos_loyalty_txns WHERE office = ? AND customer_id = ?', [office, me]);
  let balance = Number(older.p) || 0;
  const valueMinor = Math.max(1, Number(settings && settings.point_value_minor) || 1);
  for (const r of rows) {
    balance += r.points;
    await db.execute(
      `INSERT INTO epos_loyalty_txns
         (id, office, customer_id, order_id, kind, points, balance_after, spend_minor, value_minor, note, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [seededId(), office, me, r.kind, r.points, balance, r.spend, Math.abs(r.points) * valueMinor, r.note, sql(r.when)]);
  }
  const visits = new Set(rows.filter((r) => r.kind === 'earn').map((r) => day(r.when))).size;
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const last = rows[rows.length - 1].when;

  // ---- The member's row: theirs only -------------------------------------
  const set = ['name = ?', 'points_balance = ?', 'membership_expiry = ?', 'created_at = LEAST(created_at, ?)'];
  const vals = [job.name, balance, expiry, sql(joined)];
  for (const [col, val] of [['visits', visits], ['last_visit', sql(last)], ['lifetime_spend_minor', spend]]) {
    if (await has('epos_customers', col)) { set.push(`${col} = ?`); vals.push(val); }
  }
  if (plan && await has('epos_customers', 'membership_status')) {
    set.push('scheme_id = ?', "membership_status = 'active'", 'joined_on = ?', 'frozen_from = NULL', 'frozen_until = NULL', 'cancelled_on = NULL');
    vals.push(plan.id, day(joined));
  }
  await db.execute(`UPDATE epos_customers SET ${set.join(', ')} WHERE id = ? AND email_key = ?`, [...vals, me, office]);
  if (plan) {
    try {
      await db.execute(
        `INSERT INTO epos_membership_events
           (office, customer_id, kind, scheme_id, expiry_before, expiry_after, amount_minor, note, via, created_at)
         VALUES (?, ?, 'join', ?, NULL, ?, ?, ?, 'till', ?)`,
        [office, me, plan.id, expiry, plan.membership_fee_minor ?? null, NOTE, sql(joined)]);
    } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
  }
  console.log(`   name "${job.name}", member since ${day(joined)}, ` +
    (plan ? `${plan.name} membership until ${expiry}` : `no membership plans at this venue; card valid until ${expiry}`));
  console.log(`   ${rows.length} points rows over 16 weeks: ${visits} visits, £${(spend / 100).toFixed(2)} spent, ` +
    `${spent ? `one reward (${minRedeem} points), ` : ''}balance ${balance}`);

  // ---- News --------------------------------------------------------------
  const news = [
    { at: daysAgo(30, 10, 0), title: 'Thanks for your support', body:
      `Thanks for coming down, ${job.name.split(' ')[0]}. Show your card at the bar and the points add up.` },
    // The club's real news, written on the PC from the WRU and the club's site.
    ...(job.news || []).map((n) => ({ ...n, at: new Date(n.at) })),
  ];
  for (const n of news) {
    const id = seededId();
    await db.execute(
      `INSERT INTO epos_push_messages
         (id, office, title, body, audience, status, send_at, sent_at, recipients, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, 1, ?, ?)`,
      [id, office, n.title, n.body, JSON.stringify({ kind: 'member', customer_id: me }),
        sql(n.at), sql(n.at), `seed_review_member:${me}`, sql(n.at)]);
    await db.execute(
      'INSERT IGNORE INTO epos_push_inbox (message_id, customer_id, office, created_at) VALUES (?, ?, ?, ?)',
      [id, me, office, sql(n.at)]);
  }
  // And the club's own latest news to everybody, as any member has it.
  const [real] = await db.query(
    `SELECT id, sent_at FROM epos_push_messages
      WHERE office = ? AND status = 'sent' AND id NOT LIKE ? AND audience LIKE '%"all"%'
      ORDER BY sent_at DESC LIMIT 3`, [office, MARK + '%']);
  for (const m of real) {
    await db.execute(
      'INSERT IGNORE INTO epos_push_inbox (message_id, customer_id, office, created_at) VALUES (?, ?, ?, ?)',
      [m.id, me, office, m.sent_at]);
  }
  console.log(`   news: ${news.length} messages to them, plus ${real.length} of the club's own`);

  // The Wallet card, if they have added one, catches up now.
  try {
    const applePush = require('./src/wallet_apple_push');
    for (const kind of ['loyalty', 'customer']) {
      await applePush.notifyPassChanged({ pool: db, office, kind, subjectId: me });
    }
  } catch { /* no Wallet here: nothing to wake */ }
  await db.end();
})().catch((e) => { console.error('! ' + e.message); process.exit(1); });
"""


WRU = "https://api.wru.wales/fixtures-results"
WRU_ORG = 165  # Pontardawe RFC, as PontardaweRFC/website/src/wru.js
NEWS = ROOT / "PontardaweRFC" / "website" / "content" / "news.json"


def _wru(path):
    import urllib.request
    req = urllib.request.Request(f"{WRU}/{path}", headers={
        "Accept": "application/json", "User-Agent": "pontardawerfc.com (review member)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def _fixture(f):
    home = (f.get("homeTeam") or {}).get("orgId") == WRU_ORG
    us, them = (f["homeTeam"], f["awayTeam"]) if home else (f["awayTeam"], f["homeTeam"])
    day, _, time = str(f.get("date", "")).partition("T")
    return {"day": day, "kickoff": time[:5] if time and time != "00:00:00" else None, "home": home,
            "opponent": them.get("organisationName", "").replace(" RFC", ""),
            "status": f.get("status"), "competition": f.get("competitionName") or "",
            "us": us.get("score"), "them": them.get("score"), "tries": us.get("tryCount")}


def _when(day):
    import datetime
    return datetime.date.fromisoformat(day).strftime("%A %-d %B") if os.name != "nt" else \
        datetime.date.fromisoformat(day).strftime("%A %#d %B")


def club_news():
    """The club's real season so far, for the member's points and inbox.

    Home games played (with the score) become match-day visits; the latest
    result, a postponement, the next home game and the club's newest story
    become messages. All from the WRU's public fixtures API and the club
    site's own news.json, read now; if the WRU cannot be reached the member
    still gets the club's story and bar visits, never a made-up match."""
    import datetime
    now = datetime.datetime.now()
    matches, news = [], []
    try:
        past = [_fixture(f) for f in _wru(f"organisation-fixtures?upcoming=false&organisationId={WRU_ORG}")["fixtures"]]
        upcoming = [_fixture(f) for f in _wru(f"organisation-fixtures?upcoming=true&organisationId={WRU_ORG}")["fixtures"]]
    except Exception as e:  # noqa: BLE001
        print(f"   ! the WRU could not be read ({e}); no match days or results this time")
        past, upcoming = [], []
    played = [m for m in past if m["status"] == "PLAYED" and m["competition"] and (m["us"] or m["them"])]
    matches = [m for m in played if m["home"]]
    if played:
        m = max(played, key=lambda m: m["day"])
        where = "at the Rec" if m["home"] else f"away at {m['opponent']}"
        verdict = "a win" if m["us"] > m["them"] else "a draw" if m["us"] == m["them"] else "a tough afternoon"
        tries = f" {m['tries']} tries for Pontardawe." if m.get("tries") else ""
        kind = "Cup tie" if "Knockout" in m["competition"] else "League game"
        news.append({"at": f"{m['day']}T17:15:00", "title": f"Full time: Pontardawe {m['us']}-{m['them']} {m['opponent']}",
                     "body": f"{kind} {where}: {verdict}.{tries} Thanks to everyone who came down to support the boys."})
    off = [m for m in past if m["status"] == "POSTPONED"]
    if off:
        m = max(off, key=lambda m: m["day"])
        where = f"at home to {m['opponent']}" if m["home"] else f"away at {m['opponent']}"
        news.append({"at": f"{m['day']}T09:30:00", "title": "Saturday's game is off",
                     "body": f"Our league game {where} on {_when(m['day'])} has been postponed. We'll let you know the new date."})
    home_next = [m for m in upcoming if m["home"]]
    if home_next:
        m = min(home_next, key=lambda m: m["day"])
        ko = ""
        if m["kickoff"]:
            h, mins = (int(x) for x in m["kickoff"].split(":"))
            ko = f", kick-off {(h - 1) % 12 + 1}{f':{mins:02d}' if mins else ''}{'pm' if h >= 12 else 'am'}"
        at = min(now - datetime.timedelta(hours=2), datetime.datetime.fromisoformat(m["day"]) - datetime.timedelta(days=4))
        news.append({"at": at.strftime("%Y-%m-%dT18:30:00"), "title": f"Next at the Rec: Pontardawe v {m['opponent']}",
                     "body": f"Home league game on {_when(m['day'])}{ko} at the Recreation Ground. "
                             "Come down, cheer the boys on, and show your card at the bar."})
    try:
        story = max(json.loads(NEWS.read_text(encoding="utf-8")), key=lambda n: n["date"])
        news.append({"at": f"{story['date']}T10:00:00", "title": story["title"], "body": story["summary"]})
    except (OSError, ValueError, KeyError) as e:
        print(f"   ! the club's news.json could not be read ({e})")
    news = [n for n in news if n["at"] <= now.strftime("%Y-%m-%dT%H:%M:%S")]
    print(f"   from the club: {len(matches)} home games this season, {len(news)} messages")
    return [{k: m[k] for k in ("day", "opponent", "us", "them")} for m in matches], news


def main():
    emails = [a for a in sys.argv[1:] if "@" in a]
    if len(emails) != 1:
        raise SystemExit(__doc__)
    email = emails[0].strip().lower()
    # The one rule this tool never bends: only a throwaway test member.
    if not re.fullmatch(r"[^@\s'\"]+@test\.com", email):
        raise SystemExit("! only an @test.com member is ever seeded")
    slug = arg("--slug", "pontardawe-rfc")
    name = arg("--name", "Alex Morgan")
    if not re.fullmatch(r"[a-z0-9-]+", slug) or not re.fullmatch(r"[A-Za-z][A-Za-z' .-]{1,60}", name):
        raise SystemExit("! that slug or name does not look right")

    matches, news = club_news() if "--remove" not in sys.argv else ([], [])
    job = json.dumps({"slug": slug, "email": email, "name": name, "remove": "--remove" in sys.argv,
                      "matches": matches, "news": news})
    client = base.vesopa_ssh.connect()
    try:
        sftp = client.open_sftp()
        remote = f"{BACKOFFICE}/.seed_review_member.js"
        try:
            with sftp.open(remote, "w") as f:
                f.write(SCRIPT)
        finally:
            sftp.close()
        stdin, stdout, stderr = client.exec_command(
            f"chown {USER}:{USER} {remote} && su - {USER} -c 'cd {BACKOFFICE} && {NODE} node .seed_review_member.js'; "
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
