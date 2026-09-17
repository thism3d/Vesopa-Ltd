#!/usr/bin/env node
/**
 * Connect an application's own data to /delete-account.
 *
 *   node scripts/set-privacy-provider.js <app-slug> <endpoint-url> <secret-file> [data label]
 *
 * The app answers <endpoint>/lookup, /erase and /describe, signed with the
 * shared secret (src/deletion.js). The secret is read from a FILE, never argv:
 * a command line is visible in `ps` to every other service on this box. The
 * same value goes in the app's own .env (VESOPA_PRIVACY_SECRET for the back
 * office). Run again to change the endpoint or rotate the secret.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const deletion = require('../src/deletion');
const db = require('../src/db');

async function main() {
  const [slug, endpointUrl, secretFile, ...label] = process.argv.slice(2);
  if (!slug || !endpointUrl || !secretFile) {
    console.error('usage: set-privacy-provider.js <app-slug> <endpoint-url> <secret-file> [data label]');
    process.exit(2);
  }
  if (!/^https:\/\//.test(endpointUrl)) throw new Error('the endpoint must be https');
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  if (secret.length < 32) throw new Error('the secret is too short');
  const id = await deletion.setProvider({ slug, endpointUrl, secret, dataLabel: label.join(' ') });
  console.log(`privacy provider set for ${slug} (application ${id}) -> ${endpointUrl}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
