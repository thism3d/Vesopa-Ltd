/**
 * Invitations, and helping somebody back in after they lose a second factor.
 *
 *     node scripts/smoke-phase5.js
 *
 * These two features are the ones that GRANT access and the ones that WEAKEN an
 * account, so most of what is checked here is the refusals. An invitation that
 * can be accepted by the wrong person is how somebody becomes an administrator
 * by forwarding an email; a recovery with no brake on it is how every other
 * control in the system is defeated over the telephone.
 */

const crypto = require('crypto');

const db = require('../src/db');
const invitations = require('../src/invitations');
const recovery = require('../src/recovery');
const config = require('../src/config');
const { newId, newToken, hashToken, encrypt, newTotpSecret } = require('../src/crypto');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${condition ? '' : ` — ${detail}`}`);
  if (condition) passed += 1;
  else failed += 1;
}

/** A throwaway person with a verified address. */
async function makePerson(address) {
  const publicId = newId();
  const inserted = await db.execute(
    "INSERT INTO users (public_id, display_name, webauthn_handle) VALUES (?, 'Phase5 Test', ?)",
    [publicId, crypto.randomBytes(32)],
  );
  await db.execute(
    `INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at, verified_via)
     VALUES (?, 'email', ?, ?, NOW(), 'seed')`,
    [inserted.insertId, address, address],
  );
  return { id: inserted.insertId, publicId, address };
}

async function cleanup(ids) {
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute('DELETE FROM users WHERE id = ?', [id]);
  }
}

async function main() {
  const stamp = Date.now();
  const invitee = await makePerson(`p5-invitee-${stamp}@vesopa.com`);
  const stranger = await makePerson(`p5-stranger-${stamp}@vesopa.com`);
  const admin = await makePerson(`p5-admin-${stamp}@vesopa.com`);
  const created = [invitee.id, stranger.id, admin.id];

  // =====================================================================
  console.log('▶ invitations');

  const made = await invitations.create({
    email: invitee.address,
    invitedBy: admin.id,
    grantsDeveloper: true,
    message: 'Come and help',
  });
  check('an invitation can be created', made.ok === true, made.error);

  const token = made.ok ? made.url.split('/invite/')[1] : '';
  check('the link carries a token', token.length > 20);

  const found = await invitations.findByToken(token);
  check('the token finds it', Boolean(found));
  check('a rubbish token finds nothing', (await invitations.findByToken('nope')) === null);

  const second = await invitations.create({ email: invitee.address, invitedBy: admin.id });
  check(
    'a second live invitation to the same address is refused',
    second.ok === false,
    'two links granting different things is a race',
  );

  /*
   * THE CHECK THE WHOLE FEATURE RESTS ON. An invitation accepted by a session
   * belonging to somebody else must grant that person nothing — otherwise a
   * forwarded email makes the wrong person a developer.
   */
  const wrong = await invitations.accept(token, stranger.id);
  check('accepting as the wrong account is refused', wrong.ok === false && wrong.error === 'wrong_account');

  const strangerAfter = await db.one('SELECT is_developer FROM users WHERE id = ?', [stranger.id]);
  check('and grants nothing to that account', Number(strangerAfter.is_developer) === 0);

  const right = await invitations.accept(token, invitee.id);
  check('accepting as the invited address works', right.ok === true, right.error);

  const inviteeAfter = await db.one('SELECT is_developer FROM users WHERE id = ?', [invitee.id]);
  check('the grant is applied', Number(inviteeAfter.is_developer) === 1);

  check('and it cannot be accepted twice', (await invitations.accept(token, invitee.id)).ok === false);

  // Resending must invalidate the old link.
  const other = await makePerson(`p5-resend-${stamp}@vesopa.com`);
  created.push(other.id);
  const resendable = await invitations.create({ email: other.address, invitedBy: admin.id });
  const firstToken = resendable.url.split('/invite/')[1];
  const resent = await invitations.resend(resendable.publicId, admin.id);
  check('an invitation can be resent', resent.ok === true, resent.error);
  check(
    'and the FIRST link stops working',
    (await invitations.findByToken(firstToken)) === null,
    'a token that has been in two mailboxes must not still open the door',
  );
  check('while the new one works', Boolean(await invitations.findByToken(resent.url.split('/invite/')[1])));

  await invitations.revoke(resendable.publicId, admin.id);
  check(
    'a revoked invitation is dead',
    (await invitations.findByToken(resent.url.split('/invite/')[1])) === null,
  );

  // =====================================================================
  console.log('▶ recovery — the refusals');

  const victim = await makePerson(`p5-victim-${stamp}@vesopa.com`);
  created.push(victim.id);

  // Give them an authenticator and a password to lose.
  await db.execute(
    'INSERT INTO user_totp (user_id, secret_cipher, confirmed_at) VALUES (?, ?, NOW())',
    [victim.id, encrypt(newTotpSecret(), config.secrets.encryptionKey)],
  );
  await db.execute(
    "INSERT INTO user_passwords (user_id, password_hash, algorithm) VALUES (?, 'x', 'argon2id')",
    [victim.id],
  );

  const summary = await recovery.summarise(victim.id);
  check('the summary sees the authenticator', Boolean(summary.totp));
  check('and knows they can still be reached', summary.canStillSignIn === true);

  const noReason = await recovery.reset({
    userId: victim.id, actorUserId: admin.id, removeTotp: true,
    reason: 'lost', verifiedBy: 'email_code',
  });
  check('a one-word reason is refused', noReason.ok === false, 'a reason nobody can read is no reason');

  const noVerify = await recovery.reset({
    userId: victim.id, actorUserId: admin.id, removeTotp: true,
    reason: 'Phone stolen on the 8th, confirmed by their manager', verifiedBy: 'vibes',
  });
  check('an unrecognised verification method is refused', noVerify.ok === false);

  const nothing = await recovery.reset({
    userId: victim.id, actorUserId: admin.id,
    reason: 'Phone stolen on the 8th, confirmed by their manager', verifiedBy: 'email_code',
  });
  check('doing nothing at all is refused', nothing.ok === false);

  const onSelf = await recovery.reset({
    userId: admin.id, actorUserId: admin.id, removeTotp: true,
    reason: 'I have lost my own phone and would like to fix it myself', verifiedBy: 'email_code',
  });
  check(
    'an administrator cannot do it to themselves',
    onSelf.ok === false,
    'the control is that two people are involved',
  );

  // =====================================================================
  console.log('▶ recovery — doing it');

  // A live session, to prove it is ended.
  const sessionToken = newToken(32);
  await db.execute(
    `INSERT INTO sso_sessions (public_id, user_id, token_hash, amr, acr, ip, idle_expires_at, expires_at)
     VALUES (?, ?, ?, '["pwd"]', 'aal1', '127.0.0.1',
             DATE_ADD(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [newId(), victim.id, hashToken(sessionToken)],
  );

  const done = await recovery.reset({
    userId: victim.id,
    actorUserId: admin.id,
    removeTotp: true,
    reissueCodes: true,
    reason: 'Phone stolen on 8 September, confirmed by their manager Nicki',
    verifiedBy: 'manager_confirmed',
    ip: '203.0.113.7',
  });
  check('the reset succeeds', done.ok === true, done.error);
  check('and returns new recovery codes', Array.isArray(done.recoveryCodes) && done.recoveryCodes.length === 10);

  const totpAfter = await db.one(
    'SELECT revoked_at FROM user_totp WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [victim.id],
  );
  check('the authenticator is gone', Boolean(totpAfter.revoked_at));

  const userAfter = await db.one(
    'SELECT mfa_reset_at, password_paused_until FROM users WHERE id = ?',
    [victim.id],
  );
  check('the reset is stamped on the account', Boolean(userAfter.mfa_reset_at));

  /*
   * The control that makes all of this safe: a stolen password is not enough
   * for the next day, so talking support into a reset does not hand over the
   * account.
   */
  check('the password is paused', recovery.passwordPaused(userAfter) === true);
  check(
    'and for about a day',
    new Date(userAfter.password_paused_until) > new Date(Date.now() + 20 * 3600 * 1000),
    userAfter.password_paused_until,
  );

  const liveSessions = await db.one(
    'SELECT COUNT(*) AS live FROM sso_sessions WHERE user_id = ? AND revoked_at IS NULL',
    [victim.id],
  );
  check('every session was ended', Number(liveSessions.live) === 0);

  const recorded = await db.one(
    'SELECT * FROM account_recoveries WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [victim.id],
  );
  check('it is written down', Boolean(recorded));
  check('with who did it', Number(recorded.actor_user_id) === admin.id);
  check('with why', recorded.reason.includes('Phone stolen'));
  check('and how they checked', recorded.verified_by === 'manager_confirmed');

  const seenByThem = await db.one(
    "SELECT id FROM login_events WHERE user_id = ? AND failure_reason = 'admin_reset'",
    [victim.id],
  );
  check(
    'and it appears in the person’s OWN history',
    Boolean(seenByThem),
    'they will never read the admin audit log',
  );

  const history = await recovery.historyFor(victim.id);
  check('the history lists it', history.length >= 1);

  // =====================================================================
  await cleanup(created.concat([victim.id]));
  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('phase 5 smoke test failed:', error);
  try {
    await db.close();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
