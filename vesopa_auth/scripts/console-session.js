/**
 * Mint a session cookie for an account, so a tool can look at a signed-in page.
 *
 *     node scripts/console-session.js info@vesopasoftware.com
 *
 * Prints the raw session token. `tool/auth_shot.py --as <token>` sets it as the
 * `__Host-vesopa_sid` cookie and photographs the account, admin and developer
 * pages, which cannot otherwise be seen without a real sign-in and a real
 * mailbox.
 *
 * IS THIS A BACK DOOR? No, and it is worth being precise about why, because a
 * script called "mint me a session" on an identity provider deserves the
 * question.
 *
 * It runs on the server, as a shell command, reading the database password out
 * of `.env`. Anybody who can run it can already open the database and write
 * whatever row they like, including a session row identical to this one. It
 * adds no privilege that root on this box did not already have — what it adds
 * is that the same thing done by hand, wrongly, tends to leave a session with
 * no expiry on it.
 *
 * SO IT IS FENCED ANYWAY. The session it makes lasts fifteen minutes, is
 * recorded in `login_events` as `tooling` like any other sign-in, and appears
 * in the person's own history — which is the property that actually matters:
 * an administrative route into an account is safe when the account holder can
 * see it happened.
 */

const db = require('../src/db');
const sessions = require('../src/sessions');
const events = require('../src/events');
const { normaliseEmail } = require('../src/normalise');

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: node scripts/console-session.js <email>');
    process.exit(1);
  }

  const user = await db.one(
    `SELECT u.* FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL
        AND u.status = 'active'`,
    [normaliseEmail(email)],
  );
  if (!user) {
    console.error(`no active account signs in with ${email}`);
    process.exit(1);
  }

  const session = await sessions.create({
    userId: user.id,
    amr: ['tooling'],
    acr: 'aal1',
    remembered: false,
    ip: '127.0.0.1',
    userAgent: 'vesopa-console-session',
  });

  // Fifteen minutes. Long enough to photograph every page, short enough that a
  // token left in a terminal buffer is worthless by the time anybody reads it.
  await db.execute(
    `UPDATE sso_sessions
        SET idle_expires_at = DATE_ADD(NOW(), INTERVAL 15 MINUTE),
            expires_at = DATE_ADD(NOW(), INTERVAL 15 MINUTE)
      WHERE id = ?`,
    [session.id],
  );

  await events.recordLogin({
    userId: user.id,
    sessionId: session.id,
    method: 'tooling',
    outcome: 'success',
    identifier: email,
    ip: '127.0.0.1',
    userAgent: 'vesopa-console-session',
  });

  process.stdout.write(`${session.token}\n`);
  await db.close();
}

main().catch((error) => {
  console.error('failed:', error.message);
  process.exit(1);
});
