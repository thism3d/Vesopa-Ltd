/**
 * Signs the profiles that put a printer on an iPhone, so iOS shows who they are
 * from and not "Not Signed" in red (owner, 2026-11-06).
 *
 * Each profile is made when it is asked for, so signing happens here every time.
 * The certificate is Apple's, made for this job by
 * .github/workflows/print-profile-cert.yml from a request written on this
 * server, so the private key has never left it. It lasts a year: when it runs
 * out, or if it is missing, a profile still goes out unsigned and the log says
 * so, because a printer that installs with a warning beats one that does not.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = process.env.PRINT_SIGN_DIR || path.join(__dirname, '..', 'data', 'print-signing');

/** The signed form of a profile, or null if it cannot be signed. */
function sign(text, dir = DIR) {
  const file = (name) => path.join(dir, name);
  if (!['key.pem', 'cert.pem', 'chain.pem'].every((n) => fs.existsSync(file(n)))) return Promise.resolve(null);
  return new Promise((resolve) => {
    const out = [];
    const openssl = spawn('openssl', ['smime', '-sign', '-binary', '-nodetach', '-outform', 'der', '-md', 'sha256',
      '-signer', file('cert.pem'), '-inkey', file('key.pem'), '-certfile', file('chain.pem')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let why = '';
    openssl.stdout.on('data', (c) => out.push(c));
    openssl.stderr.on('data', (c) => { why += c; });
    openssl.on('error', (e) => { console.warn('[print_drive] profile not signed:', e.message); resolve(null); });
    openssl.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      console.warn('[print_drive] profile not signed:', why.trim().slice(0, 200));
      return resolve(null);
    });
    openssl.stdin.end(text);
  });
}

module.exports = { sign };
