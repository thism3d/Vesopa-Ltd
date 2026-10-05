#!/usr/bin/env node
/**
 * Register an installer the PC has just copied to this box (2026-10-05).
 *
 *   node scripts/add-release.js <app> <version> <file.exe> [--signed] [--notes "..."] [--by email]
 *
 * Run by tool/publish_installers.py, from the app directory, as the app's
 * user. Copies the file into RELEASES_DIR/<app>/, hashes it and adds the row,
 * so it shows on Downloads and can be chosen under Versions. Refuses a
 * version that is already there: bump the version instead.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true, quiet: true });

const releases = require('../src/releases');
const { pool } = require('../src/db');

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const signed = args.includes('--signed');
  if (signed) args.splice(args.indexOf('--signed'), 1);
  const notes = flag('--notes');
  const by = flag('--by');
  const [app, version, file] = args;
  if (!app || !version || !file) {
    console.error('usage: node scripts/add-release.js <app> <version> <file.exe> [--signed] [--notes "..."] [--by email]');
    process.exit(2);
  }
  const r = await releases.add({ app, version, source: path.resolve(file), signed, notes, by });
  console.log(`added ${r.app} ${r.version}: ${r.file}, ${releases.size(r.size)}, sha256 ${r.sha256}${r.signed ? ', signed' : ', unsigned'}`);
}

main()
  .catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
