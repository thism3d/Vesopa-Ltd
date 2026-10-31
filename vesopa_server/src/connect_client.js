/**
 * Paymentsense Connect, for Vesopa Go's card machines (2026-10-31).
 *
 * Pontardawe RFC's card machines are on a Paymentsense Connect account: its
 * own host (<account>.connect.paymentsense.cloud) and key, driving the PDQ
 * over REST. Vesopa Go asked api.dojo.tech for them with that key and got
 * "Not Found". The till has spoken Connect since 1.6 (vesopa_epos/lib/payments/
 * connect_pac.dart, verified against the live account); this is the same
 * conversation, from the server, so Go never holds the key.
 *
 *   GET    /pac/terminals                              the machines
 *   POST   /pac/terminals/{tid}/transactions           a SALE or REFUND -> requestId
 *   GET    /pac/terminals/{tid}/transactions/{id}      polled, about once a second
 *   PUT    /pac/terminals/{tid}/transactions/{id}/signature
 *   DELETE /pac/terminals/{tid}/transactions/{id}      cancel, before the card
 *
 * Basic auth with the key as the password, Accept application/connect.v2+json
 * (v0 and v1 refuse the partner headers), and Software-House-Id plus
 * Installer-Id, without which Connect answers 422.
 */
const { partnerIds } = require('./dojo_client');

class ConnectError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ConnectError';
    this.status = status;
  }
}

function headers(key) {
  const ids = partnerIds('');
  return {
    Authorization: 'Basic ' + Buffer.from('epos:' + String(key || '').trim()).toString('base64'),
    Accept: 'application/connect.v2+json',
    'Content-Type': 'application/json',
    'Software-House-Id': ids.softwareHouseId,
    'Installer-Id': ids.resellerId || ids.softwareHouseId,
  };
}

async function call(conn, method, path, { body, fetchImpl } = {}) {
  if (!conn || !conn.key || !conn.baseUrl) throw new ConnectError(0, 'No card machine account is set up for this venue.');
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(conn.baseUrl.replace(/\/+$/, '') + path, {
      method,
      headers: headers(conn.key),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new ConnectError(0, 'The card machine account could not be reached.');
  }
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const why = json.messages ? Object.values(json.messages).flat().join(' ') : json.message || json.error || res.statusText;
    // Never the key: Connect does not echo it, and nothing here would.
    throw new ConnectError(res.status, String(why || `answered ${res.status}`).slice(0, 300));
  }
  return { json, location: res.headers.get('location') };
}

/** The machines on the account: [{ tid, status, currency }]. */
async function listTerminals(conn, opts) {
  const { json } = await call(conn, 'GET', '/pac/terminals', opts);
  return (json.terminals || []).map((t) => ({ tid: t.tid, status: t.status, currency: t.currency || 'GBP' }));
}

/** Start a SALE or REFUND on a machine; the request id to follow it by. */
async function start(conn, tid, { type = 'SALE', amountMinor }, opts) {
  const { json, location } = await call(conn, 'POST', `/pac/terminals/${encodeURIComponent(tid)}/transactions`, {
    ...opts,
    body: { transactionType: type, amount: amountMinor, currency: 'GBP' },
  });
  const id = json.requestId || json.id || (location ? location.split('/').pop() : null);
  if (!id) throw new ConnectError(0, 'The card machine took the request but gave no reference to follow it by.');
  return String(id);
}

async function get(conn, tid, requestId, opts) {
  const { json } = await call(conn, 'GET', `/pac/terminals/${encodeURIComponent(tid)}/transactions/${encodeURIComponent(requestId)}`, opts);
  return json;
}

async function acceptSignature(conn, tid, requestId, opts) {
  await call(conn, 'PUT', `/pac/terminals/${encodeURIComponent(tid)}/transactions/${encodeURIComponent(requestId)}/signature`, {
    ...opts,
    body: { accepted: true },
  });
}

async function cancel(conn, tid, requestId, opts) {
  try {
    await call(conn, 'DELETE', `/pac/terminals/${encodeURIComponent(tid)}/transactions/${encodeURIComponent(requestId)}`, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a transaction has come to: paid, failed, cancelled, signature (the
 * machine waits for it to be accepted) or waiting. TIMED_OUT is neither paid
 * nor refused -- the money may have moved -- so it stays waiting and the
 * phone says to check the machine.
 */
function state(tx) {
  const result = String((tx && tx.transactionResult) || '').toUpperCase();
  if (result === 'SUCCESSFUL' || result === 'APPROVED') return 'paid';
  if (result === 'CANCELLED') return 'cancelled';
  if (result === 'DECLINED' || result === 'VOID' || result === 'UNSUCCESSFUL') return 'failed';
  const notes = (tx && tx.notifications) || [];
  if (notes[notes.length - 1] === 'SIGNATURE_VERIFICATION') return 'signature';
  return 'waiting';
}

/** A payment row's reference for a Connect transaction: connect:<tid>:<requestId>. */
function ref(tid, requestId) {
  return `connect:${tid}:${requestId}`.slice(0, 64);
}

function parseRef(value) {
  const m = /^connect:([^:]+):(.+)$/.exec(String(value || ''));
  return m ? { tid: m[1], requestId: m[2] } : null;
}

module.exports = { ConnectError, listTerminals, start, get, acceptSignature, cancel, state, ref, parseRef, headers };
