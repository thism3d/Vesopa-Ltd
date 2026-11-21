'use strict';

/**
 * Whether a member's card is in Google Wallet, and which Google account they
 * linked for it (owner, 2026-11-20: "link a Google account before anyone
 * activate Google Pay button ... once walletpass is added to that device or
 * account show that wallet added like Apple Pay").
 *
 *   epos_wallet_google_state   one row per Google pass object: saved or not,
 *                              from Google's own save/delete callbacks
 *                              (wallet.js POST /wallet/google/callback), so a
 *                              card deleted in Google Wallet brings the button
 *                              back in the app
 *   epos_loyalty_google_links  the Google account a member linked in the club
 *                              app (Google's sign-in sheet, the ID token
 *                              checked by loyalty_social.js); a save in Google
 *                              Wallet links the account too, without its
 *                              address
 *
 * Both are made on first use. Nothing here is needed for a pass to work: a
 * failure is logged and the app shows the button as before.
 */

let ready = null;

function ensure(pool) {
  ready ||= Promise.all([
    pool.query(`CREATE TABLE IF NOT EXISTS epos_wallet_google_state (
      object_id  VARCHAR(255) CHARACTER SET ascii NOT NULL PRIMARY KEY,
      saved      TINYINT(1) NOT NULL DEFAULT 0,
      changed_at DATETIME NOT NULL
    )`),
    pool.query(`CREATE TABLE IF NOT EXISTS epos_loyalty_google_links (
      office      VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
      customer_id VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
      google_sub  VARCHAR(64)  NULL,
      email       VARCHAR(190) NULL,
      linked_at   DATETIME NOT NULL,
      PRIMARY KEY (office, customer_id)
    )`),
  ]).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** Google said the pass was saved (or deleted). */
async function recordEvent(pool, { objectId, eventType }, now = new Date()) {
  if (!objectId) return;
  await ensure(pool);
  const saved = eventType === 'save' ? 1 : 0;
  await pool.execute(
    `INSERT INTO epos_wallet_google_state (object_id, saved, changed_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE saved = VALUES(saved), changed_at = VALUES(changed_at)`,
    [String(objectId), saved, now]
  );
  if (!saved) return;
  // Saving needs a Google account: the member has linked one, by doing it.
  const [[pass]] = await pool.query(
    'SELECT office, subject_id FROM epos_wallet_passes WHERE object_id = ? LIMIT 1',
    [String(objectId)]
  );
  if (pass) {
    await pool.execute(
      `INSERT INTO epos_loyalty_google_links (office, customer_id, linked_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE linked_at = linked_at`,
      [pass.office, String(pass.subject_id), now]
    );
  }
}

/** The member linked a Google account in the app. */
async function link(pool, office, customerId, { sub, email }, now = new Date()) {
  await ensure(pool);
  await pool.execute(
    `INSERT INTO epos_loyalty_google_links (office, customer_id, google_sub, email, linked_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE google_sub = VALUES(google_sub), email = VALUES(email), linked_at = VALUES(linked_at)`,
    [office, String(customerId), sub ? String(sub).slice(0, 64) : null, email ? String(email).slice(0, 190) : null, now]
  );
}

async function unlink(pool, office, customerId) {
  await ensure(pool);
  await pool.execute('DELETE FROM epos_loyalty_google_links WHERE office = ? AND customer_id = ?', [office, String(customerId)]);
}

/**
 * The member's Google Wallet state for the app:
 *   { linked, email, saved }
 * `saved` is true only once Google has told us the loyalty card was saved and
 * not deleted since.
 */
async function status(pool, office, customerId) {
  await ensure(pool);
  const [[l]] = await pool.query(
    'SELECT email FROM epos_loyalty_google_links WHERE office = ? AND customer_id = ?',
    [office, String(customerId)]
  );
  const [[s]] = await pool.query(
    `SELECT st.saved FROM epos_wallet_passes p
       JOIN epos_wallet_google_state st ON st.object_id = p.object_id
      WHERE p.office = ? AND p.kind = 'loyalty' AND p.subject_id = ? LIMIT 1`,
    [office, String(customerId)]
  );
  return { linked: !!l, email: (l && l.email) || null, saved: !!(s && s.saved) };
}

module.exports = { ensure, recordEvent, link, unlink, status, _reset: () => { ready = null; } };
