/**
 * One member, one number, for as long as they are a member of this venue.
 *
 * WHY THIS IS NOT PART OF ISSUING A CARD
 *
 * It used to be. `member_no` was written in exactly one place — src/cards.js,
 * when a piece of plastic was issued — and that meant a member only had a number
 * if somebody had handed them a card. A customer who signed up from the poster
 * by scanning a QR code, or who was typed in at the back office, or who was
 * enrolled at the till mid-sale, had none at all.
 *
 * Which was fine while the number was only ever printed on plastic, and stopped
 * being fine the moment a wallet pass started showing it. "Member VK · 0241" is
 * the thing a customer reads out on the phone and a member of staff types into
 * the till, and it cannot be a property of whether they happen to hold a card.
 *
 * So the number is allocated when somebody becomes a member, by whichever of the
 * four routes they came in through, and a card issued later reuses it rather
 * than minting a second one.
 *
 * WHY IT IS A COUNTER AND NOT MAX + 1
 *
 * The same reason epos_card_sequences gives for card numbers: MAX + 1 hands a
 * number out again the moment a member is deleted, and the pass carrying that
 * number is still on somebody's phone. A number that has been issued must never
 * be issued twice, however tidy the gap looks.
 *
 * WHY NOTHING HERE THROWS
 *
 * The callers are a sale, a sign-up form and a back-office save. A member
 * without a number is a small cosmetic gap on one card; a sign-up that failed
 * because a counter was locked is a customer standing at a poster with nothing
 * to show for it. So every path returns null rather than raising, and the number
 * is filled in by [backfill] later.
 */

/** The sequence this counter lives under in `epos_card_sequences`. */
const MEMBER_SEQUENCE = 'member';

/**
 * The next member number for a venue, taken under the row lock.
 *
 * SEEDED FROM WHAT THE VENUE ALREADY HAS
 *
 * This counter is new; the numbers are not. `member_no` has been written since
 * cards existed, taken from the *card* sequence in src/cards.js — so a venue
 * that has issued fifty loyalty cards has members numbered up to fifty already.
 * A counter starting at 1 would hand those numbers out a second time, and the
 * collision would not show up until two members had the same one on their
 * passes.
 *
 * So the row is seeded from `MAX(member_no) + 1` the first time it is needed,
 * and only then — `INSERT IGNORE` does nothing on every call after. A venue with
 * no members at all seeds at 1, because MAX over no rows is NULL.
 *
 * THE INCREMENT IS SAFE WITH TWO TILLS AT ONCE
 *
 * The UPDATE takes the row lock and holds it until the transaction commits, and
 * the SELECT that follows sees this transaction's own write. Reading first and
 * writing second is the version that gives two members the same number.
 */
async function claimNumber(conn, office) {
  await conn.execute(
    `INSERT IGNORE INTO epos_card_sequences (office, kind, next_number)
     SELECT ?, ?, COALESCE(MAX(member_no), 0) + 1
       FROM epos_customers WHERE email_key = ?`,
    [office, MEMBER_SEQUENCE, office]
  );
  await conn.execute(
    `UPDATE epos_card_sequences SET next_number = next_number + 1
      WHERE office = ? AND kind = ?`,
    [office, MEMBER_SEQUENCE]
  );
  const [[row]] = await conn.query(
    'SELECT next_number FROM epos_card_sequences WHERE office = ? AND kind = ?',
    [office, MEMBER_SEQUENCE]
  );
  return Number(row.next_number) - 1;
}

/**
 * Give this customer a member number if they have not got one.
 *
 * Idempotent, and that is the whole contract: called on every enrolment path and
 * again whenever a card is issued, it allocates at most once per customer. The
 * `member_no IS NULL` in the UPDATE is what makes that true under concurrency —
 * two requests racing to enrol the same person both claim a number, and only one
 * of them lands. The loser's number is spent, which is a gap in the sequence and
 * not a collision.
 *
 * Returns the number, or null when there is nothing to allocate against or the
 * allocation failed. Never throws — see the note at the top of this file.
 */
async function ensureMemberNumber(pool, office, customerId) {
  if (!office || !customerId) return null;

  let conn;
  try {
    conn = await pool.getConnection();

    const [[existing]] = await conn.query(
      'SELECT member_no FROM epos_customers WHERE id = ? AND email_key = ?',
      [String(customerId), office]
    );
    // No such customer, or they already have one. Both are "nothing to do",
    // and the second is the common case on every call after the first.
    if (!existing) return null;
    if (existing.member_no != null) return Number(existing.member_no);

    await conn.beginTransaction();
    try {
      const number = await claimNumber(conn, office);
      const [result] = await conn.execute(
        `UPDATE epos_customers SET member_no = ?
          WHERE id = ? AND email_key = ? AND member_no IS NULL`,
        [number, String(customerId), office]
      );
      await conn.commit();

      if (result.affectedRows === 1) return number;

      // Somebody else got there first. Their number is the real one.
      const [[now]] = await conn.query(
        'SELECT member_no FROM epos_customers WHERE id = ? AND email_key = ?',
        [String(customerId), office]
      );
      return now && now.member_no != null ? Number(now.member_no) : null;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    }
  } catch (e) {
    // The column may not exist yet on a database that has not had
    // schema_swipe_cards.sql applied. That is a deployment state, not a reason
    // to fail a sign-up, so it is logged once per call and swallowed.
    console.error(`[members] could not allocate a member number: ${e.message}`);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

/**
 * Give every member of a venue who is missing one a number.
 *
 * For the venues that already have customers — which is all of them — because
 * this feature arriving does not make their existing members less of a member.
 * Ordered oldest first, so the numbers reflect the order people actually joined
 * rather than the order the rows came back.
 *
 * Bounded per call. A venue with twenty thousand customers should not hold a
 * connection open for all of them, and the caller can simply run it again.
 * Returns how many it filled in.
 */
async function backfill(pool, office, limit = 500) {
  if (!office) return 0;

  try {
    const [rows] = await pool.query(
      `SELECT id FROM epos_customers
        WHERE email_key = ? AND member_no IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
      [office, Math.min(Math.max(Number(limit) || 500, 1), 5000)]
    );

    let filled = 0;
    for (const row of rows) {
      // One at a time and in order. The sequence is a single row per venue, so
      // parallelism here would only make the transactions queue on the same
      // lock while multiplying the connections doing the waiting.
      const number = await ensureMemberNumber(pool, office, row.id);
      if (number != null) filled++;
    }
    return filled;
  } catch (e) {
    console.error(`[members] backfill failed for ${office}: ${e.message}`);
    return 0;
  }
}

module.exports = { MEMBER_SEQUENCE, ensureMemberNumber, backfill };
