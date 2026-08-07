/**
 * Does this domain actually point at us?
 *
 * One question, asked of the public DNS rather than of anything we control.
 * The registrar's API knows what nameservers it was TOLD to publish, which is
 * not the same thing: a domain registered elsewhere never appears in it at all,
 * and a name whose delegation was changed an hour ago still reads as ours until
 * the registry pushes it. What decides whether we can serve a site is what a
 * resolver on the internet answers, so that is what is asked.
 *
 * The answer gates three things — pointing a domain at the node, issuing a
 * certificate for it, and keeping an externally-registered domain on the
 * account at all.
 */

const dns = require('node:dns');
const { NAMESERVERS } = require('./config');

/**
 * A resolver of our own rather than the process default.
 *
 * The default picks up whatever /etc/resolv.conf says, which on a hosting node
 * is very often the node itself — and a node that serves the zone answers
 * authoritatively for domains that are not delegated to it yet. That turns the
 * check into "do we have a zone for this", which is exactly the thing it is
 * supposed to be independent of. Public resolvers, and a short timeout, so a
 * sweep of a hundred domains cannot stall on one.
 */
const RESOLVERS = String(process.env.DNS_RESOLVERS || '1.1.1.1,8.8.8.8')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TIMEOUT_MS = Number(process.env.DNS_TIMEOUT_MS || 5000);

function makeResolver() {
  const resolver = new dns.promises.Resolver({ timeout: TIMEOUT_MS, tries: 2 });
  if (RESOLVERS.length) {
    try {
      resolver.setServers(RESOLVERS);
    } catch {
      /* a bad DNS_RESOLVERS value falls back to the system's own */
    }
  }
  return resolver;
}

/** Trailing dot, case and stray whitespace are not differences. */
function normalise(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

const OURS = NAMESERVERS.map(normalise).filter(Boolean);

/**
 * Is this set of nameservers ours?
 *
 * EVERY nameserver has to be one of ours, not merely one of them. A domain
 * delegated to ns1.vesopaepos.com and a competitor's box is served by both, at
 * random, and half its traffic never reaches the site we host — treating that
 * as "pointed at us" is how a customer ends up with an intermittent site and a
 * padlock that works one refresh in two.
 */
function matchesOurs(list) {
  const found = (list || []).map(normalise).filter(Boolean);
  if (!found.length) return false;
  return found.every((ns) => OURS.includes(ns));
}

/**
 * Look up a domain's delegation.
 *
 * Never throws. A domain that does not resolve, a registry that is slow, a
 * resolver that is unreachable — all of them are "not verified yet, here is
 * why", because every caller of this treats an error the same way it treats a
 * mismatch: wait, and ask again later.
 *
 * @returns {Promise<{matched: boolean, nameservers: string[], error: string}>}
 */
async function check(domain) {
  const name = normalise(domain);
  if (!name || !name.includes('.')) {
    return { matched: false, nameservers: [], error: 'Not a domain name.' };
  }

  try {
    const found = await makeResolver().resolveNs(name);
    return {
      matched: matchesOurs(found),
      nameservers: found.map(normalise).sort(),
      error: '',
    };
  } catch (err) {
    /*
     * NXDOMAIN is worth saying plainly. It usually means the name was mistyped
     * or has not been registered at all, and "we could not check" would send a
     * customer off looking at their registrar's nameserver form for a domain
     * that does not exist.
     */
    const message = err.code === 'ENOTFOUND' || err.code === 'ENODATA'
      ? 'That domain does not resolve yet.'
      : `Could not read the nameservers (${err.code || err.message}).`;
    return { matched: false, nameservers: [], error: message };
  }
}

/**
 * Do OUR OWN nameservers exist?
 *
 * Asked before anything is decided on the strength of a customer's delegation,
 * because the whole check is only meaningful if the thing they are being asked
 * to point at is answering. If ns1 and ns2 do not resolve, then NOBODY can
 * point a domain at us — every verification fails, and a sweep that acted on
 * that would drop domains from accounts for a failure that is entirely ours.
 *
 * This is not hypothetical. On the day this was written, `ns1.vesopaepos.com`
 * and `ns2.vesopaepos.com` had no records at all: the parent domain is
 * delegated elsewhere and the glue was never published. Anything that trusted
 * the check would have deleted every customer's domain three days later.
 *
 * Cached for a few minutes — it is the same answer for every domain in a pass,
 * and this runs at the top of each one.
 */
let selfCheck = { at: 0, result: null };
const SELF_TTL_MS = 5 * 60_000;

async function ourNameserversResolve({ fresh = false } = {}) {
  if (!fresh && selfCheck.result && Date.now() - selfCheck.at < SELF_TTL_MS) return selfCheck.result;

  const resolver = makeResolver();
  const missing = [];
  for (const host of OURS) {
    try {
      // Either family will do — what matters is that the name answers at all.
      const v4 = await resolver.resolve4(host).catch(() => []);
      const v6 = v4.length ? [] : await resolver.resolve6(host).catch(() => []);
      if (!v4.length && !v6.length) missing.push(host);
    } catch {
      missing.push(host);
    }
  }

  const result = { ok: OURS.length > 0 && missing.length === 0, missing, checked: OURS };
  selfCheck = { at: Date.now(), result };
  return result;
}

module.exports = { check, matchesOurs, normalise, ourNameserversResolve, OURS, RESOLVERS };
