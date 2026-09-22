/**
 * Ask the REGISTRY where a domain is delegated, not a recursive resolver.
 *
 * ## Why this file exists
 *
 * `nameservers.check()` asks 1.1.1.1 for a domain's NS records, and for a
 * domain pointed at us that we have no zone for, that question has no good
 * answer. Our own nameserver REFUSES a zone it does not hold, every recursive
 * resolver on the internet turns REFUSED into SERVFAIL, and the customer is
 * shown "Could not read the nameservers (ESERVFAIL)" for a delegation that is
 * completely correct at the registry.
 *
 * That is not a hypothetical. Measured on 2026-09-08:
 *
 *   sheve.site      resolveNs -> ESERVFAIL
 *   muzahid.com.bd  resolveNs -> ESERVFAIL
 *   arpi.site       resolveNs -> ns1.vesopa.com, ns2.vesopa.com
 *
 * The only difference between the three is that arpi.site has a zone on the
 * node. All three are delegated to ns1/ns2.vesopa.com at their registry. Asking
 * the registry directly returns the truth for all three:
 *
 *   sheve.site      NS at .site      -> ns2.vesopa.com, ns1.vesopa.com
 *   muzahid.com.bd  NS at .com.bd    -> ns2.vesopa.com, ns1.vesopa.com
 *   arpi.site       NS at .site      -> ns2.vesopa.com, ns1.vesopa.com
 *
 * `domain-linking.verify()` already knows how to break the deadlock — build the
 * zone, then ask again — but it would only do that for a domain we registered,
 * because an external name's SERVFAIL was ambiguous. This removes the
 * ambiguity: a delegation read out of the registry is proof of control, whoever
 * the name is registered with.
 *
 * ## Why it is written by hand
 *
 * `dns.resolveNs()` cannot do it. A TLD server answers a query for a delegated
 * name with a REFERRAL: rcode 0, an EMPTY ANSWER section, and the NS records in
 * the AUTHORITY section. c-ares reports that as ENODATA and throws the records
 * away — measured, on all three names above. Nothing in node:dns exposes the
 * authority section, so the packet is built and parsed here. It is about 120
 * lines and it adds no dependency to a project that has nine.
 *
 * Queries go out with RD=0. We are talking to an authoritative server and
 * asking it to recurse would be both rude and pointless.
 */

const dgram = require('node:dgram');
const dnsp = require('node:dns').promises;

const TIMEOUT_MS = Number(process.env.DNS_TIMEOUT_MS || 5000);

const TYPE_A = 1;
const TYPE_NS = 2;

/* -------------------------------------------------------------------------
   Wire format
   ------------------------------------------------------------------------- */

function encodeName(name) {
  const parts = String(name || '').replace(/\.$/, '').split('.').filter(Boolean);
  const out = [];
  for (const part of parts) {
    const label = Buffer.from(part, 'ascii');
    if (!label.length || label.length > 63) throw new Error('Bad label in name.');
    out.push(Buffer.from([label.length]), label);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function buildQuery(name, type) {
  const id = Math.floor(Math.random() * 65536);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  // Flags all zero: a standard query with RD off.
  header.writeUInt16BE(1, 4); // one question
  const question = Buffer.concat([
    encodeName(name),
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(type, 0); b.writeUInt16BE(1, 2); return b; })(),
  ]);
  return { id, packet: Buffer.concat([header, question]) };
}

/**
 * Read a name at `offset`, following compression pointers.
 *
 * Returns the name and the offset of the byte AFTER the name in the record
 * stream — which for a compressed name is two bytes on, not wherever the
 * pointer led. Getting that wrong walks the parser off into the middle of a
 * record and every field after it is nonsense.
 */
function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let end = offset;
  let guard = 0;

  while (guard++ < 128) {
    const len = buf[offset];
    if (len === undefined) break;
    if (len === 0) { if (!jumped) end = offset + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) { end = offset + 2; jumped = true; }
      offset = pointer;
      continue;
    }
    labels.push(buf.toString('ascii', offset + 1, offset + 1 + len));
    offset += 1 + len;
    if (!jumped) end = offset;
  }
  return { name: labels.join('.'), offset: end };
}

function parse(buf) {
  const rcode = buf.readUInt16BE(2) & 0x0f;
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];

  let offset = 12;
  for (let i = 0; i < counts[0]; i++) offset = readName(buf, offset).offset + 4;

  const sections = { answer: [], authority: [], additional: [] };
  const order = ['answer', 'authority', 'additional'];

  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      const owner = readName(buf, offset);
      offset = owner.offset;
      const type = buf.readUInt16BE(offset);
      const rdLength = buf.readUInt16BE(offset + 8);
      const rdOffset = offset + 10;
      let data = null;
      if (type === TYPE_NS) data = readName(buf, rdOffset).name;
      else if (type === TYPE_A) data = Array.from(buf.subarray(rdOffset, rdOffset + 4)).join('.');
      sections[order[s]].push({ name: owner.name, type, data });
      offset = rdOffset + rdLength;
    }
  }
  return { rcode, ...sections };
}

/** One UDP query to one server. Never retried here — the caller tries the next server. */
function ask(server, name, type) {
  return new Promise((resolve, reject) => {
    let query;
    try { query = buildQuery(name, type); } catch (err) { reject(err); return; }

    const socket = dgram.createSocket(server.includes(':') ? 'udp6' : 'udp4');
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error('DNS query timed out.')), TIMEOUT_MS);

    socket.on('message', (msg) => {
      // A reply carrying somebody else's id is either a stale packet or a
      // spoof attempt; either way it is not the answer to this question.
      if (msg.length < 12 || msg.readUInt16BE(0) !== query.id) return;
      try { done(resolve, parse(msg)); } catch (err) { done(reject, err); }
    });
    socket.on('error', (err) => done(reject, err));
    socket.send(query.packet, 53, server, (err) => { if (err) done(reject, err); });
  });
}

/* -------------------------------------------------------------------------
   The registry lookup
   ------------------------------------------------------------------------- */

/**
 * The addresses of the servers authoritative for `zone`, via the ordinary
 * recursive path. This part is safe to do recursively: the TLD's own zone is
 * always served, so there is no deadlock to break here.
 *
 * Cached, because a sweep of a hundred `.com` names asks for it a hundred times
 * and the answer changes about once a decade.
 */
const parentCache = new Map();
const PARENT_TTL_MS = 30 * 60_000;

async function parentServers(zone) {
  const hit = parentCache.get(zone);
  if (hit && Date.now() - hit.at < PARENT_TTL_MS) return hit.ips;

  const resolver = new dnsp.Resolver({ timeout: TIMEOUT_MS, tries: 2 });
  const configured = String(process.env.DNS_RESOLVERS || '1.1.1.1,8.8.8.8')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length) { try { resolver.setServers(configured); } catch { /* system default */ } }

  const hosts = await resolver.resolveNs(zone).catch(() => []);
  const ips = [];
  // Three is plenty. A TLD has a dozen or more nameservers and asking one of
  // them is the whole job; the other two are there in case the first is down.
  for (const host of hosts.slice(0, 3)) {
    // eslint-disable-next-line no-await-in-loop -- at most three, and cached
    const found = await resolver.resolve4(host).catch(() => []);
    if (found.length) ips.push(found[0]);
  }
  if (ips.length) parentCache.set(zone, { at: Date.now(), ips });
  return ips;
}

/**
 * Every zone above `name`, longest first.
 *
 * `muzahid.com.bd` gives `com.bd` then `bd`, and the loop stops at the first
 * one that answers — which is exactly the right behaviour and needs no public
 * suffix list to get there. Where `com.bd` is a real zone (it is), it holds the
 * delegation; where the second-level label is not a zone at all, its server
 * does not answer and the TLD above it does.
 */
function parentZones(name) {
  const labels = String(name).split('.').filter(Boolean);
  const zones = [];
  for (let i = 1; i < labels.length; i++) zones.push(labels.slice(i).join('.'));
  return zones;
}

function normalise(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * The delegation recorded at the registry for `domain`.
 *
 * Never throws. Every failure is "we could not read it", because every caller
 * treats that the same way it treats a mismatch: fall back to the recursive
 * answer, and ask again later.
 *
 * @returns {Promise<{ok: boolean, nameservers: string[], zone: string, error: string}>}
 */
async function delegation(domain) {
  const name = normalise(domain);
  if (!name || !name.includes('.')) {
    return { ok: false, nameservers: [], zone: '', error: 'Not a domain name.' };
  }

  for (const zone of parentZones(name)) {
    // eslint-disable-next-line no-await-in-loop -- ordered fallback, one zone at a time
    const servers = await parentServers(zone);
    if (!servers.length) continue;

    for (const server of servers) {
      let reply;
      try {
        // eslint-disable-next-line no-await-in-loop -- ordered fallback
        reply = await ask(server, name, TYPE_NS);
      } catch {
        continue;
      }
      // NXDOMAIN from the registry is a real and final answer: the name is not
      // registered under this zone. Worth stopping on rather than walking up
      // and asking a TLD that will say the same thing.
      if (reply.rcode === 3) {
        return { ok: true, nameservers: [], zone, error: '', nxdomain: true };
      }
      if (reply.rcode !== 0) continue;

      /*
       * ANSWER first, then AUTHORITY. A registry that happens to answer
       * authoritatively puts the records in ANSWER; the normal case is a
       * referral, which puts them in AUTHORITY and leaves ANSWER empty. Both
       * are the delegation, and only one of them is what c-ares would have
       * given us.
       */
      const records = [...reply.answer, ...reply.authority]
        .filter((r) => r.type === TYPE_NS && normalise(r.name) === name)
        .map((r) => normalise(r.data))
        .filter(Boolean);

      if (records.length) {
        return { ok: true, nameservers: [...new Set(records)].sort(), zone, error: '' };
      }
      /*
       * Answered, no NS records for the name. Under the zone we asked, this
       * name is not delegated anywhere — which for the TLD itself means it is
       * not registered, and for an intermediate zone means we asked too low
       * and should try the one above.
       */
      return { ok: true, nameservers: [], zone, error: '' };
    }
  }

  return { ok: false, nameservers: [], zone: '', error: 'No registry server answered.' };
}

module.exports = { delegation, parentZones, normalise };
