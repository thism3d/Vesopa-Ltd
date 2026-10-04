/**
 * Vesopa EPOS partner API client: where Metric's members and plans live.
 *
 * The venue's EPOS issues a partner key (vpk_...) in Vesopa admin; this
 * server sends it as a Bearer token. See vesopa_server/src/memberships.js,
 * "Partner (Metric)", for the other side:
 *
 *   GET  /partner/v1/memberships/plans
 *   GET  /partner/v1/memberships/members
 *   POST /partner/v1/memberships/members                 create or link (pending)
 *   POST /partner/v1/memberships/members/:id/:action     approve|renew|cancel|suspend|plan
 *
 * Off (`enabled()` false) unless both EPOS_BASE_URL and EPOS_PARTNER_KEY are
 * set; then nothing here is called and the server runs standalone.
 */

const config = require('./config');

class EposError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function enabled() {
  return config.EPOS_ON;
}

async function call(method, path, body) {
  if (!enabled()) throw new EposError('Vesopa EPOS is not configured.', 503);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), config.EPOS_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${config.EPOS_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.EPOS_PARTNER_KEY}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    throw new EposError(`Vesopa EPOS could not be reached (${e.name === 'AbortError' ? 'timed out' : e.message}).`, 502);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    // EPOS's own words (e.g. "This membership is already active.") are meant
    // for staff, so they are passed on; 4xx stays 4xx.
    const msg = (json && json.error) || `Vesopa EPOS answered ${res.status}.`;
    throw new EposError(msg, res.status >= 400 && res.status < 500 && res.status !== 401 ? res.status : 502);
  }
  return json;
}

const asList = (x, key) => (Array.isArray(x) ? x : x && Array.isArray(x[key]) ? x[key] : []);

module.exports = {
  EposError,
  enabled,
  plans: async () => asList(await call('GET', '/partner/v1/memberships/plans'), 'plans'),
  members: async () => asList(await call('GET', '/partner/v1/memberships/members'), 'members'),
  /** { name, email, phone, vesopa_sub, scheme_id?, status?, by? } -> the EPOS member. */
  createMember: (body) => call('POST', '/partner/v1/memberships/members', body),
  /** action: approve | renew | cancel | suspend | plan. body: { by, now?, scheme_id? } */
  action: (id, action, body = {}) => call('POST', `/partner/v1/memberships/members/${encodeURIComponent(id)}/${action}`, body),
};
