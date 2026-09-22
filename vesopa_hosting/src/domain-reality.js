/**
 * Is this a real domain — one that could actually be pointed at us?
 *
 * WHY THIS EXISTS
 *
 * registrar.validateHostname checks the SHAPE of a name: letters, digits,
 * hyphens and dots. Shape is not reality. `mysite.comm`, `shop.xyz123` and
 * `site.c` all have a perfectly good shape, and each was accepted onto a
 * hosting plan (2026-09-22) — a plan then waiting for ever on a delegation that
 * cannot happen, because the extension does not exist.
 *
 * So a name somebody says they already own is held to two facts:
 *
 *   THE EXTENSION EXISTS. Checked against IANA's own list of top-level domains
 *   (src/data/iana-tlds.txt, fetched from data.iana.org). For a dotted
 *   extension such as .com.bd it is the last part, `bd`, that is checked, so
 *   every real country extension works without us listing its second levels.
 *
 *   THE NAME IS REGISTERED. It must answer in public DNS. A name that does not
 *   exist gets "register it instead" rather than a plan that never goes live.
 *   Only a definite "no such name" refuses: a timeout or a resolver error lets
 *   it through, because a DNS hiccup must never stop a real customer adding
 *   their real domain — the delegation check afterwards is the real gate.
 *
 * To refresh the list: curl -o src/data/iana-tlds.txt https://data.iana.org/TLD/tlds-alpha-by-domain.txt
 */

const fs = require('node:fs');
const path = require('node:path');
const { Resolver } = require('node:dns').promises;

const registrar = require('./integrations/domainnameapi');

const IANA = new Set(
  fs.readFileSync(path.join(__dirname, 'data', 'iana-tlds.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')),
);

function makeResolver() {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return r;
}

/** The name somebody registers: `shop.example.com.bd` → `example.com.bd`. */
function registrable(name) {
  const { sld, tld } = registrar.splitDomain(name);
  if (!tld) return name;
  const last = String(sld || '').split('.').filter(Boolean).pop();
  return last ? `${last}.${tld}` : name;
}

/** Does the extension (its last part) exist at all? */
function realExtension(name) {
  const labels = String(name || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return false;
  return IANA.has(labels.at(-1));
}

/**
 * Returns null when the name is real, or a message for the customer.
 * `lookup` is injectable for tests; it defaults to a public-DNS NS query.
 */
async function checkRealDomain(input, { lookup } = {}) {
  const name = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  if (!realExtension(name)) {
    const ext = name.includes('.') ? name.slice(name.indexOf('.')) : '';
    return ext
      ? `“${ext}” is not a real domain extension. Check the spelling — for example .com, .net or .com.bd.`
      : 'Add an extension, like .com, .net or .com.bd.';
  }

  const target = registrable(name);
  const ask = lookup || ((host) => makeResolver().resolveNs(host));
  try {
    await ask(target);
    return null;
  } catch (err) {
    // Definitely does not exist. Anything else — a timeout, SERVFAIL, a name
    // that exists without NS of its own — is not proof, so it is let through.
    if (err && err.code === 'ENOTFOUND') {
      return `${target} does not seem to be registered yet. Check the spelling, or register it with us instead.`;
    }
    return null;
  }
}

module.exports = { checkRealDomain, realExtension, registrable };
