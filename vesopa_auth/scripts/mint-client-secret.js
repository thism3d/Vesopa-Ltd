/**
 * Make a client secret for a first-party application, straight into a file.
 *
 *     node scripts/mint-client-secret.js vesopa-gift /root/vesopa-gift-client.secret
 *
 * The portal can mint a secret too, and shows it once on a page. That is right
 * for a developer at a desk and wrong for a server that needs it in a file: the
 * value would have to be copied off a screen and pasted into a terminal, which
 * is exactly the trip a secret should not make.
 *
 * So this writes it to a file created 0600, and prints only its last four
 * characters. Over SSH, argv and the environment both end up in a command line
 * that `ps` shows to every other service on the box, which is why neither is
 * used to carry it anywhere.
 *
 * It refuses to overwrite a file that already exists: a second run would
 * otherwise mint a second live secret and leave the first one working too.
 * Rotation is deliberate -- mint into a new file, deploy it, then revoke the
 * old one in the portal.
 */

const fs = require('fs');

const db = require('../src/db');
const { mintSecret } = require('../src/portal');

async function main() {
  const [slug, out] = process.argv.slice(2);
  if (!slug || !out) {
    console.error('usage: node scripts/mint-client-secret.js <app-slug> <output-file>');
    process.exit(1);
  }
  if (fs.existsSync(out)) {
    console.error(`${out} already exists. Mint into a new file and revoke the old secret in the portal.`);
    process.exit(1);
  }

  const application = await db.one(
    'SELECT id, name, client_id, is_first_party FROM applications WHERE slug = ? AND deleted_at IS NULL',
    [slug],
  );
  if (!application) {
    console.error(`no application with slug "${slug}"`);
    process.exit(1);
  }
  if (!application.is_first_party) {
    console.error('refusing: this is for Vesopa\'s own applications, whose server is ours');
    process.exit(1);
  }

  const { secret } = await mintSecret(application.id, `${slug} server`, null);
  fs.writeFileSync(out, `${application.client_id}\n${secret}\n`, { mode: 0o600, flag: 'wx' });

  await db.execute(
    `INSERT INTO audit_log (actor_user_id, actor_type, action, target_type, target_id,
                            application_id, detail, ip, user_agent)
     VALUES (NULL, 'system', 'application.secret_minted', 'application', ?, ?, ?, '', 'mint-client-secret.js')`,
    [application.client_id, application.id, JSON.stringify({ hint: secret.slice(-4) })],
  );

  console.log(`  ${application.name}: client id ${application.client_id}`);
  console.log(`  secret ending ${secret.slice(-4)} written to ${out} (0600)`);
  await db.close();
}

main().catch((error) => {
  console.error('failed:', error.message);
  process.exit(1);
});
