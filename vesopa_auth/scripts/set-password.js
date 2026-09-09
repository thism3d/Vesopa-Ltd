/**
 * Set one account's password, for an account that is meant to have one.
 *
 *     VESOPA_SET_PASSWORD_FILE=/run/secret node scripts/set-password.js you@example.com
 *
 * THE PASSWORD IS READ FROM A FILE, NOT FROM ARGV AND NOT FROM THE COMMAND.
 *
 * An argument is visible in `ps` to every other account on the box, and this
 * box is shared with two other customers' services. So is the command string
 * an SSH session runs, which is what rules out `VESOPA_SET_PASSWORD=… node …`
 * over ssh as well: the environment assignment IS part of that command line.
 *
 * So the caller writes the password to a mode-600 file, names the file, and
 * deletes it afterwards. `VESOPA_SET_PASSWORD` is still honoured for a local
 * interactive shell, where the exposure is the operator's own machine. It is
 * never printed back, not even masked, and never its length.
 *
 * WHY THIS EXISTS AT ALL, WHEN NOBODY ELSE HERE HAS A PASSWORD
 *
 * Vesopa's venues sign in with an emailed code and no password, deliberately:
 * there is nothing to forget, nothing to reuse from another site, and nothing
 * for us to store. `manager@vesopa.co.uk` is the exception the owner asked for,
 * because it is the account used to TEST sign-in — and a test that needs a code
 * emailed to a real mailbox is a test nobody runs, and one that fills that
 * mailbox when they do.
 *
 * So this is for that account and accounts like it. It refuses to be pointed at
 * a venue's account by accident: the address has to be named in ALLOWED below.
 * That refusal is the whole safety of the script. The owner's instruction was
 * "do not set anyone's password except manager@vesopa.co.uk", and a list is how
 * that survives the next person who runs this in a hurry.
 *
 * Retires the old password rather than overwriting it — `user_passwords` has a
 * unique index on (user_id, active_flag) and keeps history, which is how a
 * "when did this change?" question gets an answer.
 */

const db = require('../src/db');
const config = require('../src/config');
const { hashPassword } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');

/**
 * The only addresses this script will touch.
 *
 * Every other Vesopa account signs in with a code. Adding an address here is a
 * decision to give a human being a password on a platform that has decided not
 * to have them, and should be as awkward as editing a file.
 */
const ALLOWED = ['manager@vesopa.co.uk'];

async function main() {
  const email = normaliseEmail(process.argv[2]);

  const file = process.env.VESOPA_SET_PASSWORD_FILE || '';
  // The trailing newline is trimmed, because every ordinary way of writing
  // a file adds one and nobody means it to be part of their password.
  const password = file
    ? require('fs').readFileSync(file, 'utf8').replace(/\r?\n$/, '')
    : process.env.VESOPA_SET_PASSWORD || '';

  if (!email) {
    console.error(
      'Usage: VESOPA_SET_PASSWORD_FILE=/path/to/secret node scripts/set-password.js <email>',
    );
    process.exit(2);
  }
  if (!ALLOWED.includes(email)) {
    console.error(
      `Refused. ${email} is not in the allowed list.\n` +
        'Venues sign in with an emailed code and have no password. If this is ' +
        'genuinely meant to change, add the address to ALLOWED in this file ' +
        'and say why in the commit.',
    );
    process.exit(3);
  }
  if (password.length < 10) {
    console.error('Refused: the password must be at least 10 characters.');
    process.exit(4);
  }

  const user = await db.one(
    `SELECT u.id, u.display_name FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [email],
  );
  if (!user) {
    console.error(`No Vesopa account for ${email}.`);
    process.exit(5);
  }

  const hash = await hashPassword(password, config.secrets.passwordPepper);

  await db.transaction(async (tx) => {
    // Retire whatever is there. The unique index allows exactly one active
    // password per person, and history is kept rather than overwritten.
    await tx.execute(
      'UPDATE user_passwords SET retired_at = NOW() WHERE user_id = ? AND retired_at IS NULL',
      [user.id],
    );
    await tx.execute(
      'INSERT INTO user_passwords (user_id, password_hash, algorithm) VALUES (?, ?, ?)',
      [user.id, hash, 'argon2id'],
    );
  });

  // The address, never the password, and not even its length.
  console.log(`Password set for ${email} (user ${user.id}).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
