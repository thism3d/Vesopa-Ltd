#!/usr/bin/env node
/**
 * Fill the demonstration venue's loyalty app with a busy three days.
 *
 *   node tool/seed-demo-loyalty.js --yes        # make the data
 *   node tool/seed-demo-loyalty.js --clear      # take it away again
 *   node tool/seed-demo-loyalty.js --code      # a sign-in code for the demo member
 *   node tool/seed-demo-loyalty.js              # say what it would do
 *
 * WHY THIS EXISTS
 *
 * An empty app demonstrates nothing. A card with no points, a history with no
 * lines and an inbox with no messages tell somebody being shown it that the
 * thing does not work yet, which is the opposite of the truth.
 *
 * IT RUNS AGAINST ONE VENUE AND REFUSES EVERY OTHER. This writes to the live
 * database, where all but one of the venues are real businesses whose customer
 * records are their own. The office is a constant below, checked before a
 * single row is written, and there is no flag to override it.
 *
 * EVERYTHING IT MAKES IS TAGGED, so --clear can take back exactly what it put
 * in and nothing else. Customers carry DEMO_TAG in `notes`; their transactions,
 * inbox rows and sessions go with them; messages carry it in `created_by`. The
 * customers this venue already had are matched by none of that and are never
 * touched. --clear is the only delete in here and it is narrowed by the tag
 * every time.
 *
 * THE NUMBERS ADD UP, because somebody will look. Points are earned at the
 * venue's own rate, on its own tier multipliers, in the order the visits
 * happened; every row's balance_after is the running total; the balance on the
 * card is the last one. A demonstration where the history does not explain the
 * balance is worse than no demonstration.
 *
 * WHAT IT DELIBERATELY DOES NOT MAKE
 *
 * Push channels. A channel is an address at Google's or Microsoft's push
 * service, and an invented one cannot be delivered to -- so a venue that sent a
 * notification during the demonstration would watch it fail for every member.
 * The inbox is written instead (the app calls it "software push" and shows it
 * on opening), which is the half that can be shown honestly.
 */
const crypto = require('crypto');

require('dotenv').config();
const mysql = require('mysql2/promise');

/** The demonstration venue. Not a flag, not an environment variable. */
const DEMO_OFFICE = 'manager@vesopa.co.uk';
const DEMO_SLUG = 'vesopa-test';
const DEMO_TAG = 'demo-seed';

const MEMBERS = 120;
const DAYS = 3;

/**
 * The member whose card is the one actually shown.
 *
 * Named rather than drawn from the pool below, because this is the card on the
 * screen while somebody is being talked through it: a reseed the morning of a
 * demonstration must not quietly rename the person being pointed at.
 * --hero-name overrides it.
 */
const HERO_EMAIL = 'manager@vesopa.co.uk';
const HERO_NAME = 'Meirion Davies';

const FIRST = [
  'Olivia', 'Amelia', 'Isla', 'Ava', 'Freya', 'Grace', 'Sophie', 'Ella', 'Ruby', 'Chloe',
  'Daisy', 'Maya', 'Nina', 'Priya', 'Aisha', 'Zara', 'Hannah', 'Erin', 'Megan', 'Leah',
  'Oliver', 'George', 'Harry', 'Noah', 'Jack', 'Leo', 'Arthur', 'Henry', 'Thomas', 'Charlie',
  'Rhys', 'Dylan', 'Owen', 'Callum', 'Finlay', 'Omar', 'Idris', 'Samir', 'Nathan', 'Joel',
];
const LAST = [
  'Whitfield', 'Hargreaves', 'Bevan', 'Lloyd', 'Morris', 'Pritchard', 'Ellis', 'Vaughan',
  'Reynolds', 'Ashworth', 'Fairbairn', 'Sandhu', 'Kaur', 'Chowdhury', 'Begum', 'Okonkwo',
  'Nowak', 'Ferreira', 'Doyle', 'McAllister', 'Sutcliffe', 'Radcliffe', 'Holloway', 'Winterbourne',
];

/** Messages a kitchen would actually have sent this week. */
const MESSAGES = [
  {
    hoursAgo: 68,
    title: 'Sunday roast is back',
    body: 'Slow-roast sirloin, honey parsnips and a Yorkshire the size of your head. Booking from noon, and members get a table held until 2pm.',
  },
  {
    hoursAgo: 55,
    title: 'Double points on Tuesdays',
    body: 'Every Tuesday this month, your points count twice. Nothing to claim, just show your card at the till.',
  },
  {
    hoursAgo: 41,
    title: 'New on the menu: harissa lamb flatbread',
    body: 'Charred flatbread, slow lamb shoulder, pickled red onion and a lot of yoghurt. On from today.',
  },
  {
    hoursAgo: 26,
    title: 'Kitchen open late on Fridays',
    body: 'Food until 11pm from this Friday. The bar stays on until midnight.',
  },
  {
    hoursAgo: 6,
    title: 'Five pounds off at 500 points',
    body: 'You are closer than you think. Open your card to see where you have got to.',
  },
];

const NOTES = [
  'Table 6', 'Table 12', 'Bar', 'Takeaway', 'Table 3', 'Table 9',
  'Sunday lunch', 'Set menu', 'Table 21', 'Counter', 'Table 15', 'Pre-theatre',
];

const pick = (a) => a[crypto.randomInt(0, a.length)];
const between = (lo, hi) => lo + crypto.randomInt(0, hi - lo + 1);
const uuid = () => crypto.randomUUID();

/** MySQL DATETIME in the server's own local time, which is what NOW() writes. */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * When somebody ate. Weighted to when a kitchen is actually busy, because an
 * even scatter across the clock is the tell that a history was generated:
 * nobody buys lunch at twenty past four.
 */
function serviceTime(dayStart) {
  const r = crypto.randomInt(0, 100);
  let hour;
  if (r < 42) hour = between(12, 14);        // lunch
  else if (r < 88) hour = between(18, 21);   // dinner
  else hour = between(15, 17);               // the quiet afternoon
  const d = new Date(dayStart);
  d.setHours(hour, between(0, 59), between(0, 59), 0);
  return d;
}

async function main() {
  const clear = process.argv.includes('--clear');
  const write = process.argv.includes('--yes') || clear;

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    // ---- The guard, before anything is read or written --------------------
    const [[app]] = await db.query(
      'SELECT slug, office, app_name FROM epos_loyalty_app WHERE slug = ?', [DEMO_SLUG]
    );
    if (!app) throw new Error(`There is no loyalty app with the slug "${DEMO_SLUG}".`);
    if (app.office !== DEMO_OFFICE) {
      throw new Error(
        `Refusing: "${DEMO_SLUG}" belongs to ${app.office}, not the demonstration venue `
        + `${DEMO_OFFICE}. This tool never writes to a venue that is somebody's business.`
      );
    }
    const office = DEMO_OFFICE;

    /*
     * A sign-in code, printed rather than emailed.
     *
     * Signing in emails a six-digit code, which is right for a customer and
     * useless for somebody about to demonstrate the app on a borrowed laptop
     * with no mailbox to hand. This mints one for the demonstration member and
     * prints it.
     *
     * It is a credential, so: this venue only (the guard above has already
     * run), the demonstration address only, one use -- verifying spends every
     * outstanding code for that address -- and it expires. Signing in once
     * leaves the browser signed in, so one code is all a demonstration needs.
     */
    if (process.argv.includes('--code')) {
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error('JWT_SECRET is not set, so no code can be made.');
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const hash = crypto.createHmac('sha256', secret)
        .update(`${office}|${HERO_EMAIL}|${code}`).digest('hex');
      /*
       * Every code this address still had goes, including spent ones inside the
       * last hour.
       *
       * Asking for a code is rate limited to a handful an hour, counted on rows
       * in this table -- so minting one here used up part of somebody's
       * allowance, and a demonstration that had been set up twice met "Too many
       * codes asked for. Please try again in an hour." on the day.
       *
       * The row is dated two hours back for the same reason: outside the
       * window the limit counts, so it costs the venue nothing. expires_at is
       * what decides whether it still works, and that is a week out.
       */
      await db.execute(
        'DELETE FROM epos_loyalty_app_codes WHERE office = ? AND email = ?',
        [office, HERO_EMAIL]
      );
      await db.execute(
        `INSERT INTO epos_loyalty_app_codes (id, office, email, code_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, NOW() - INTERVAL 2 HOUR, NOW() + INTERVAL 7 DAY)`,
        [uuid(), office, HERO_EMAIL, hash]
      );
      console.log(`sign in at https://menu.vesopaepos.com/app/${DEMO_SLUG}/`);
      console.log(`  email     ${HERO_EMAIL}`);
      console.log(`  code      ${code}   (one use, 7 days)`);
      return;
    }

    // ---- Take back exactly what was put in --------------------------------
    const [[before]] = await db.query(
      'SELECT COUNT(*) n FROM epos_customers WHERE email_key = ? AND notes = ?', [office, DEMO_TAG]
    );
    if (before.n) {
      if (!write) {
        console.log(`${before.n} demonstration members are already there. --clear removes them.`);
      } else {
        const [ids] = await db.query(
          'SELECT id FROM epos_customers WHERE email_key = ? AND notes = ?', [office, DEMO_TAG]
        );
        const list = ids.map((r) => r.id);
        // Narrowed by the tagged ids every time, never by office alone.
        for (const t of ['epos_loyalty_txns', 'epos_push_inbox', 'epos_loyalty_app_sessions']) {
          await db.query(`DELETE FROM ${t} WHERE office = ? AND customer_id IN (?)`, [office, list]);
        }
        await db.query('DELETE FROM epos_push_messages WHERE office = ? AND created_by = ?', [office, DEMO_TAG]);
        await db.query('DELETE FROM epos_customers WHERE email_key = ? AND notes = ?', [office, DEMO_TAG]);
        console.log(`removed ${list.length} demonstration members and everything of theirs`);
      }
    }
    if (clear) return;

    if (!write) {
      console.log(`Would create ${MEMBERS} members and ${DAYS} days of trade for ${app.app_name}.`);
      console.log('Run again with --yes.');
      return;
    }

    // ---- The venue's own rules --------------------------------------------
    const [[settings]] = await db.query(
      'SELECT points_per_pound, point_value_minor FROM epos_loyalty_settings WHERE office = ?', [office]
    );
    const perPound = Number(settings && settings.points_per_pound) || 1;
    const pointValue = Number(settings && settings.point_value_minor) || 1;
    const [tiers] = await db.query(
      `SELECT name, min_spend_minor, points_multiplier FROM epos_loyalty_tiers
        WHERE office = ? AND active = 1 ORDER BY min_spend_minor DESC`, [office]
    );
    const tierFor = (lifetime) => tiers.find((t) => lifetime >= Number(t.min_spend_minor)) || null;

    const [[nowRow]] = await db.query('SELECT NOW() AS now');
    const clock = new Date(nowRow.now);

    // ---- Card and member numbers, from the venue's own sequences ----------
    const [[cards]] = await db.query(
      'SELECT loyalty_prefix, number_digits FROM epos_card_settings WHERE office = ?', [office]
    );
    const prefix = String((cards && cards.loyalty_prefix) || '9998');
    const width = Math.min(Math.max(Number(cards && cards.number_digits) || 5, 4), 12);
    const claim = async (kind, count) => {
      await db.execute(
        `INSERT INTO epos_card_sequences (office, kind, next_number) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE next_number = next_number + ?`,
        [office, kind, count + 1, count]
      );
      const [[row]] = await db.query(
        'SELECT next_number FROM epos_card_sequences WHERE office = ? AND kind = ?', [office, kind]
      );
      return Number(row.next_number) - count;   // the first number of the run
    };
    const firstCard = await claim('loyalty', MEMBERS);
    const firstMember = await claim('member', MEMBERS);

    // ---- The people --------------------------------------------------------
    const used = new Set();
    const people = [];
    for (let i = 0; i < MEMBERS; i += 1) {
      let name;
      do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(name));
      used.add(name);
      const [given, family] = name.split(' ');
      people.push({
        id: uuid(),
        name,
        email: i === 0
          ? HERO_EMAIL
          : `${given}.${family}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + '@example.com',
        card: `${prefix}${String(firstCard + i).padStart(width, '0')}`,
        memberNo: firstMember + i,
        joined: new Date(clock.getTime() - between(20, 640) * 86400000),
        txns: [],
        balance: 0,
        lifetime: 0,
        visits: 0,
        lastVisit: null,
      });
    }
    const hero = people[0];
    const heroFlag = process.argv.indexOf('--hero-name');
    hero.name = (heroFlag !== -1 && process.argv[heroFlag + 1]) || HERO_NAME;
    hero.joined = new Date(clock.getTime() - 430 * 86400000);

    // ---- What they spent ---------------------------------------------------
    /*
     * EVERY VISIT IS PLANNED FIRST AND PRICED SECOND, in time order.
     *
     * The rate a member earns at depends on their tier, and their tier depends
     * on everything they have spent up to that day. Generating the older
     * visits and then this week's, and only sorting at the end, priced them in
     * the order they were invented rather than the order they happened -- so a
     * card showed £50 earning 100 points on the Sunday and £76 earning 304 on
     * the Saturday before it. Anybody reading down the list sees that.
     *
     * So: lay out when somebody came in, sort, then walk forward applying the
     * multiplier they had earned by that point. The rate rises exactly where
     * they cross a threshold, which is the behaviour being demonstrated.
     */
    const windowStart = clock.getTime() - DAYS * 86400000;
    for (const p of people) {
      const plan = [];
      // A history before this week, so the card did not appear from nowhere.
      const span = Math.max(1, windowStart - p.joined.getTime());
      for (let i = 0, n = between(2, 9); i < n; i += 1) {
        plan.push({
          spend: between(1400, 6800),
          note: pick(NOTES),
          at: serviceTime(new Date(p.joined.getTime() + crypto.randomInt(0, span))),
        });
      }
      // The three days. Most members come in at least once; the hero often.
      for (let i = 0, n = (p === hero ? between(7, 9) : between(0, 6)); i < n; i += 1) {
        const at = serviceTime(new Date(clock.getTime() - crypto.randomInt(0, DAYS) * 86400000));
        // Nothing may be dated in the future, nor fall out of the window the
        // demonstration is about.
        if (at > clock) at.setTime(clock.getTime() - between(60, 5400) * 1000);
        if (at.getTime() < windowStart) at.setTime(windowStart + between(60, 43200) * 1000);
        plan.push({ spend: between(1150, 8900), note: pick(NOTES), at });
      }
      // Two chances to spend points: one a while back, one this week.
      const spends = [];
      if (crypto.randomInt(0, 100) < 45 && p.joined.getTime() < clock.getTime() - 18 * 86400000) {
        spends.push(new Date(clock.getTime() - between(5, 18) * 86400000));
      }
      if (crypto.randomInt(0, 100) < (p === hero ? 100 : 22)) {
        spends.push(new Date(clock.getTime() - between(1, 60) * 3600000));
      }
      for (const at of spends) plan.push({ redeem: true, at });

      plan.sort((a, b) => a.at - b.at);
      for (const e of plan) {
        if (e.redeem) {
          // Only if they actually had the points on the day.
          if (p.balance < 400) continue;
          const points = Math.min(Math.floor(p.balance / 100) * 100, between(1, 5) * 100);
          if (points <= 0) continue;
          p.balance -= points;
          p.txns.push({
            id: uuid(), kind: 'redeem', points: -points, balance_after: p.balance,
            // No note: the app already prints "saved £4.00" from value_minor,
            // and a note saying the same thing again reads as a glitch.
            spend_minor: 0, value_minor: points * pointValue, note: null, at: e.at,
          });
          continue;
        }
        const tier = tierFor(p.lifetime);
        const mult = tier ? Number(tier.points_multiplier) : 1;
        const points = Math.round(Math.floor(e.spend / 100) * perPound * mult);
        p.balance += points;
        p.lifetime += e.spend;
        p.visits += 1;
        if (!p.lastVisit || e.at > p.lastVisit) p.lastVisit = e.at;
        p.txns.push({
          id: uuid(), kind: 'earn', points, balance_after: p.balance,
          spend_minor: e.spend, value_minor: Math.abs(points) * pointValue,
          note: e.note, at: e.at,
        });
      }
    }
    // ---- Write it ----------------------------------------------------------
    const chunk = async (sql, rows, size = 200) => {
      for (let i = 0; i < rows.length; i += size) {
        await db.query(sql, [rows.slice(i, i + size)]);
      }
    };

    await chunk(
      `INSERT INTO epos_customers
         (id, email_key, name, email, card_number, member_no, points_balance,
          lifetime_spend_minor, tier_name, visits, last_visit, membership_expiry,
          notes, created_at)
       VALUES ?`,
      people.map((p) => {
        const tier = tierFor(p.lifetime);
        return [
          p.id, office, p.name, p.email, p.card, p.memberNo, p.balance,
          p.lifetime, tier ? tier.name : null, p.visits,
          p.lastVisit ? stamp(p.lastVisit) : null,
          stamp(new Date(clock.getTime() + between(40, 320) * 86400000)).slice(0, 10),
          DEMO_TAG, stamp(p.joined),
        ];
      })
    );

    const txnRows = [];
    for (const p of people) {
      for (const t of p.txns) {
        txnRows.push([t.id, office, p.id, null, t.kind, t.points, t.balance_after,
          t.spend_minor, t.value_minor, t.note, stamp(t.at)]);
      }
    }
    await chunk(
      `INSERT INTO epos_loyalty_txns
         (id, office, customer_id, order_id, kind, points, balance_after,
          spend_minor, value_minor, note, created_at)
       VALUES ?`,
      txnRows
    );

    // ---- Who has the app ---------------------------------------------------
    // Not everybody: a venue where every single member had installed the app
    // would be the one detail nobody believes.
    const withApp = people.filter((p, i) => i === 0 || crypto.randomInt(0, 100) < 72);
    await chunk(
      `INSERT INTO epos_loyalty_app_sessions
         (id, office, customer_id, platform, user_agent, created_at, last_seen_at)
       VALUES ?`,
      withApp.map((p) => [
        uuid(), office, p.id,
        crypto.randomInt(0, 100) < 88 ? 'web' : 'windows',
        'Mozilla/5.0 (demonstration)',
        stamp(new Date(Math.max(p.joined.getTime(), clock.getTime() - 90 * 86400000))),
        stamp(new Date(clock.getTime() - between(1, 4000) * 60000)),
      ])
    );

    // ---- The inbox ---------------------------------------------------------
    const msgRows = [];
    const inboxRows = [];
    for (const m of MESSAGES) {
      const id = uuid();
      const at = new Date(clock.getTime() - m.hoursAgo * 3600000);
      // Newest message unread by most people; older ones mostly read.
      const readChance = m.hoursAgo < 12 ? 25 : 82;
      let recipients = 0;
      for (const p of withApp) {
        if (p.joined > at) continue;
        recipients += 1;
        const read = crypto.randomInt(0, 100) < readChance;
        inboxRows.push([
          id, p.id, office, stamp(at),
          read ? stamp(new Date(at.getTime() + between(2, 900) * 60000)) : null,
        ]);
      }
      msgRows.push([
        id, office, m.title, m.body, null, null, JSON.stringify({ kind: 'all' }),
        'sent', stamp(at), stamp(at), recipients, 0, 0, 0, DEMO_TAG, stamp(at),
      ]);
    }
    await chunk(
      `INSERT INTO epos_push_messages
         (id, office, title, body, image_url, link_url, audience, status, send_at,
          sent_at, recipients, reached_web, reached_wns, failed, created_by, created_at)
       VALUES ?`,
      msgRows
    );
    await chunk(
      'INSERT INTO epos_push_inbox (message_id, customer_id, office, created_at, read_at) VALUES ?',
      inboxRows
    );

    // ---- Say what happened -------------------------------------------------
    const recent = txnRows.filter((r) => new Date(r[10]).getTime() >= windowStart);
    const takings = recent.reduce((n, r) => n + r[7], 0);
    console.log(`venue            ${app.app_name} (${office})`);
    console.log(`members          ${people.length}, of whom ${withApp.length} have the app`);
    console.log(`transactions     ${txnRows.length} in all, ${recent.length} in the last ${DAYS} days`);
    console.log(`takings          £${(takings / 100).toFixed(2)} over those ${DAYS} days`);
    console.log(`messages         ${msgRows.length}, ${inboxRows.length} inbox rows`);
    console.log('');
    console.log(`the card to show ${hero.name} <${hero.email}>`);
    console.log(`                 card ${hero.card}, member ${hero.memberNo}, `
      + `${hero.balance} points, ${hero.visits} visits`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
