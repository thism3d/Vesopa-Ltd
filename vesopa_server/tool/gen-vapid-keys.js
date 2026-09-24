#!/usr/bin/env node
/*
 * Give this server its Web Push (VAPID) keys, once.
 *
 * Appends VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT to the .env
 * beside src/, and does nothing if it already has them -- so it is safe to run
 * on every deploy. Run ON the server: the private key is written straight into
 * .env and never printed, and never leaves the machine. Rotating it would
 * silently break every browser that subscribed, so this never replaces a key.
 *
 *   node tool/gen-vapid-keys.js            # from the app directory
 *
 * The keys are a P-256 pair in the form Web Push wants: the public key as the
 * raw uncompressed point, the private key as the raw scalar, both base64url.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';

if (/^VAPID_PUBLIC_KEY=.+/m.test(current) && /^VAPID_PRIVATE_KEY=.+/m.test(current)) {
  console.log('VAPID keys: already set, left alone.');
  process.exit(0);
}

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]).toString('base64url');

const lines = [
  '',
  '# Web Push for the venue loyalty apps (src/loyalty_push.js). Never rotate:',
  '# every browser that subscribed is bound to this key.',
  `VAPID_PUBLIC_KEY=${publicKey}`,
  `VAPID_PRIVATE_KEY=${jwk.d}`,
  /^VAPID_SUBJECT=/m.test(current) ? null : 'VAPID_SUBJECT=mailto:info@vesopa.com',
  '',
].filter((l) => l !== null);

const sep = current && !current.endsWith('\n') ? '\n' : '';
fs.appendFileSync(envFile, sep + lines.join('\n'), { mode: 0o600 });
console.log('VAPID keys: written to .env.');
