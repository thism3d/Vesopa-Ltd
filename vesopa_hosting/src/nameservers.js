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
const registry = require('./dns-registry');
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
 * Is this domain delegated to us?
 *
 * BOTH of ours have to be present. Extra nameservers alongside them do not
 * block it.
 *
 * This used to be the other way round — every nameserver found had to be one of
 * ours — and the reasoning was sound as far as it went: a domain delegated to
 * us *and* a competitor is served by both at random, so half its traffic never
 * reaches the site we host, and calling that "pointed at us" earns a customer
 * an intermittent site and a padlock that works one refresh in two.
 *
 * What it got wrong is that a third NS record is very often not a competitor.
 * Registrars publish verification pseudo-nameservers during a transfer or a
 * domain-control check — `verification-xxxx.ns101.verify.hn` and its like —
 * which sit in the delegation for a few days and serve nothing. A real case:
 * heat6.com was delegated to ns1 and ns2.vesopa.com plus one of those, and was
 * reported as "still points at somebody else" and put on the four-day clock to
 * be dropped from the account, while being correctly and completely pointed at
 * us. Refusing to host a domain that is delegated to us is the worse failure of
 * the two, and it is the one that fires on a perfectly normal setup.
 *
 * Requiring BOTH of ours rather than either is what keeps the original concern
 * addressed. A domain with only ns1 sends half its queries somewhere else, and
 * that is a genuine half-broken delegation rather than a stray marker.
 *
 * Callers that want to warn about the extras can have them from `check()`.
 */
function matchesOurs(list) {
  const found = (list || []).map(normalise).filter(Boolean);
  if (!found.length) return false;
  return OURS.length > 0 && OURS.every((ns) => found.includes(ns));
}

/** The nameservers in a delegation that are not ours. Never blocks; informs. */
function extrasIn(list) {
  return (list || []).map(normalise).filter((ns) => ns && !OURS.includes(ns));
}

/** The recursive half: what a resolver on the internet answers today. */
async function resolverAnswer(name) {
  try {
    const found = await makeResolver().resolveNs(name);
    return { nameservers: found.map(normalise).filter(Boolean), code: '', error: '' };
  } catch (err) {
    const code = String(err.code || '');
    /*
     * NXDOMAIN is worth saying plainly. It usually means the name was mistyped
     * or has not been registered at all, and "we could not check" would send a
     * customer off looking at their registrar's nameserver form for a domain
     * that does not exist.
     */
    const error = code === 'ENOTFOUND' || code === 'ENODATA'
      ? 'That domain does not resolve yet.'
      : `Could not read the nameservers (${code || err.message}).`;
    return { nameservers: [], code, error };
  }
}

/**
 * Look up a domain's delegation.
 *
 * ## THE REGISTRY IS ASKED FIRST, and it is the one that decides.
 *
 * `resolveNs` does not answer the question this is for. It returns the NS
 * records held by whichever server ends up answering for the name, and that
 * comes apart from the delegation recorded at the registry in BOTH directions —
 * each of which has cost a real customer a real afternoon:
 *
 *   FALSE NEGATIVE. A domain delegated to ns1/ns2.vesopa.com that we have no
 *   zone for is REFUSED by our own nameserver, so every recursive resolver
 *   reports SERVFAIL, so the check fails — and the fix for it is creating the
 *   zone, which only happened AFTER the check passed. Measured 2026-09-08:
 *   sheve.site and muzahid.com.bd both ESERVFAIL, both delegated to us
 *   perfectly. That is the "Not yet — Could not read the nameservers
 *   (ESERVFAIL)" a customer sees on a domain they set up correctly.
 *
 *   FALSE POSITIVE. heat6.com was delegated at the registry to ns1.onzep.uk,
 *   whose copy of the zone named ns1/ns2.vesopa.com — so `resolveNs` returned
 *   OUR nameservers and the domain read as verified while every visitor was
 *   being served by the old box. Measured on the same day, still true.
 *
 * The registry's delegation has neither failure mode. It is the record that
 * decides which servers the internet asks, it is written by whoever controls
 * the domain, and it is visible the moment they change it rather than after a
 * cache expires. See dns-registry.js for why node:dns cannot read it.
 *
 * The recursive lookup still runs, in parallel, and what it saw is reported as
 * `resolved` — it is the difference between "delegated to us, propagating" and
 * "delegated to us and serving", which is worth being able to say.
 *
 * Never throws. A registry that is slow, a resolver that is unreachable — all
 * of them are "not verified yet, here is why", because every caller treats an
 * error the same way it treats a mismatch: wait, and ask again later.
 *
 * @returns {Promise<{matched: boolean, nameservers: string[], extras: string[],
 *                    resolved: string[], via: string, error: string}>}
 */
async function check(domain) {
  const name = normalise(domain);
  if (!name || !name.includes('.')) {
    return {
      matched: false,
      nameservers: [],
      extras: [],
      resolved: [],
      via: '',
      error: 'Not a domain name.',
      serverFailure: false,
      unregistered: false,
      code: '',
    };
  }

  const [live, atRegistry] = await Promise.all([
    resolverAnswer(name),
    registry.delegation(name).catch(() => ({ ok: false, nameservers: [], error: 'lookup failed' })),
  ]);

  // The registry answered and named somebody. That is the delegation.
  if (atRegistry.ok && atRegistry.nameservers.length) {
    const matched = matchesOurs(atRegistry.nameservers);
    return {
      matched,
      via: 'registry',
      nameservers: atRegistry.nameservers.slice().sort(),
      // Present but not blocking — a registrar's verification record, or a
      // leftover delegation the customer has not cleaned up yet.
      extras: extrasIn(atRegistry.nameservers).sort(),
      resolved: live.nameservers.slice().sort(),
      /*
       * DELEGATED TO US AND NOT ANSWERING is the state worth naming, because
       * it is the one with a fix and the fix is ours. It means the registry
       * sends the internet to our nameservers and our nameservers do not hold
       * the zone yet — so `domain-linking.verify()` builds it.
       */
      serverFailure: matched && !live.nameservers.length,
      unregistered: false,
      code: live.code,
      error: matched && !live.nameservers.length
        ? 'Delegated to us at the registry; our nameservers are not answering for it yet.'
        : '',
    };
  }

  /*
   * The registry answered and the name is not delegated anywhere — which for a
   * TLD server means it is not registered. Said plainly, because "could not
   * check" sends somebody to their registrar's nameserver form for a domain
   * that does not exist.
   */
  if (atRegistry.ok && !atRegistry.nameservers.length && !live.nameservers.length) {
    return {
      matched: false,
      via: 'registry',
      nameservers: [],
      extras: [],
      resolved: [],
      serverFailure: false,
      unregistered: Boolean(atRegistry.nxdomain),
      code: live.code,
      error: atRegistry.nxdomain
        ? 'That domain is not registered.'
        : 'That domain has no nameservers set at its registry yet.',
    };
  }

  // No usable registry answer: fall back to whatever the resolver said, which
  // is exactly the behaviour this had before the registry lookup existed.
  return {
    matched: matchesOurs(live.nameservers),
    via: live.nameservers.length ? 'resolver' : '',
    nameservers: live.nameservers.slice().sort(),
    extras: extrasIn(live.nameservers).sort(),
    resolved: live.nameservers.slice().sort(),
    serverFailure: ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED', 'ENOTIMP'].includes(live.code),
    unregistered: false,
    code: live.code,
    error: live.error,
  };
}

/**
 * Does this name already resolve to us?
 *
 * A different question from `check()`, and the right one for a SUBDOMAIN.
 * Delegation is about a whole zone, so asking whether `shop.example.com` is
 * delegated to us is meaningless — a subdomain normally has no NS records at
 * all. What matters is simply whether it lands on our node.
 *
 * Compared against whatever POINT_HOSTNAME resolves to rather than a hardcoded
 * address, so this stays true when the node moves and no IP is written down in
 * the code. A CNAME is followed by the resolver before we see it, so a customer
 * who pointed a CNAME at POINT_HOSTNAME and one who copied the address into an
 * A record both come back the same.
 *
 * Never throws. "We could not tell" is reported as not-pointing, because the
 * only thing that hangs on it is whether to show the customer instructions —
 * and showing them to somebody already set up is a much smaller harm than
 * telling somebody who is not that everything is fine.
 */
async function pointsAtUs(name, target) {
  const wanted = normalise(target);
  const host = normalise(name);
  if (!wanted || !host) return { pointed: false, addresses: [] };

  const resolver = makeResolver();
  const [ours, theirs] = await Promise.all([
    resolver.resolve4(wanted).catch(() => []),
    resolver.resolve4(host).catch(() => []),
  ]);
  if (!ours.length || !theirs.length) return { pointed: false, addresses: theirs };

  const set = new Set(ours);
  return {
    // Every address it answers with has to be one of ours. A name that also
    // answers with somebody else's box is served by both, at random.
    pointed: theirs.every((ip) => set.has(ip)),
    addresses: theirs,
  };
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

/**
 * The address(es) POINT_HOSTNAME answers with.
 *
 * Shown to customers alongside the hostname, because a fair number of DNS
 * control panels will not accept a hostname in an A record at all — they want
 * four numbers, and a customer staring at a form that rejects
 * `point.vesopa.com` has no way to proceed without asking us.
 *
 * RESOLVED, NEVER HARDCODED. config.js is emphatic that the node's address must
 * not be written down in the app, and that reasoning still holds: a literal in
 * the code is a number that goes stale silently the day the node moves. Reading
 * it from the hostname keeps one source of truth — change where
 * point.vesopa.com points and every instruction in the panel follows.
 *
 * Cached, because it is the same answer for every page that shows it.
 */
/*
 * KEYED BY TARGET. It used to be one cache for whatever was asked last, which
 * was harmless only for as long as this had a single caller: point.vesopa.com
 * and ns1.vesopa.com resolve to the same box today, so nothing ever went wrong.
 * `servedByUs()` below asks for the nameserver's address, and the day the
 * nameservers move off the web node a single cache would start handing one
 * name's answer out under the other's name.
 */
const addressCache = new Map();
const ADDRESS_TTL_MS = 10 * 60_000;

async function ourAddresses(target, { fresh = false } = {}) {
  const name = normalise(target);
  const hit = addressCache.get(name);
  if (!fresh && hit && hit.list.length && Date.now() - hit.at < ADDRESS_TTL_MS) return hit.list;

  const list = await makeResolver().resolve4(name).catch(() => []);
  // A failed lookup keeps the last good answer rather than replacing it with
  // nothing: the panel showing one stale-but-plausible address beats it showing
  // a blank where the instruction should be.
  if (list.length) addressCache.set(name, { at: Date.now(), list });
  return addressCache.get(name)?.list || [];
}

/**
 * Do WE answer for this zone?
 *
 * Asked of our own nameserver, by address, deliberately bypassing every
 * recursive resolver — because the state this exists to detect is precisely the
 * one a recursive resolver cannot describe. A domain delegated to us that we
 * have no zone for is REFUSED here and SERVFAIL out there, and "SERVFAIL" is
 * indistinguishable from a registry outage, a typo, or a lame delegation at
 * somebody else's host. Asking ns1 directly turns that into a fact: either we
 * hold the zone or we do not.
 *
 * The two answers this separates:
 *
 *   served: true    we hold the zone. A failing public lookup is then somebody
 *                   else's problem — usually a delegation that has not
 *                   propagated yet, which fixes itself.
 *   served: false   the delegation may well be perfect and we are the ones
 *                   answering REFUSED. Creating the zone is the fix, and it is
 *                   ours to do.
 *
 * Never throws. `reachable: false` means we could not ask, which is not the
 * same as "no" and must not be acted on as though it were.
 */
async function servedByUs(domain) {
  const name = normalise(domain);
  if (!name || !OURS.length) return { served: false, reachable: false, error: 'No nameservers configured.' };

  const ips = await ourAddresses(OURS[0]);
  if (!ips.length) return { served: false, reachable: false, error: `${OURS[0]} does not resolve.` };

  const resolver = new dns.promises.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
  try {
    resolver.setServers(ips);
  } catch {
    return { served: false, reachable: false, error: 'Could not address our own nameserver.' };
  }

  try {
    // SOA rather than NS: a zone always has exactly one, and it is answered
    // from the zone itself rather than from a delegation above it.
    await resolver.resolveSoa(name);
    return { served: true, reachable: true, error: '' };
  } catch (err) {
    const code = String(err.code || '');
    // REFUSED and NXDOMAIN are both real answers from a server that is up and
    // does not hold the zone. Anything else means we could not ask properly.
    if (['EREFUSED', 'ENOTFOUND', 'ENODATA', 'ESERVFAIL'].includes(code)) {
      return { served: false, reachable: true, error: code };
    }
    return { served: false, reachable: false, error: code || err.message };
  }
}

module.exports = {
  ourAddresses,
  servedByUs,
  registryDelegation: registry.delegation,
  check, matchesOurs, extrasIn, pointsAtUs, normalise, ourNameserversResolve, OURS, RESOLVERS,
};
