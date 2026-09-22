/**
 * Small helpers shared by every router.
 */

/**
 * A one-shot message that survives a redirect.
 *
 * A cookie rather than a session store: the app has no server-side session, and
 * standing one up so "your password was changed" can cross a 302 would be a
 * database table and a cleanup job for a 30-second string.
 */
/**
 * @param {object} [data]  a small payload the NEXT page needs and nothing else
 *                         should ever see — currently a freshly generated
 *                         database password.
 *
 * It rides in the same httpOnly cookie as the message and is gone after one
 * request. That is deliberately the shortest-lived channel available: the
 * alternatives are a query string (which lands in browser history and in every
 * proxy log between here and the customer) or a row in the database (which
 * means keeping plaintext credentials we have no reason to hold). Read it as
 * `res.locals.flashData`, and keep it small — it is a cookie, so it goes back
 * up on the next request too.
 */
function flash(res, message, kind = 'ok', data = null) {
  res.cookie('vh_flash', Buffer.from(JSON.stringify({ message, kind, ...(data ? { data } : {}) })).toString('base64url'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30_000,
    path: '/',
  });
}

/**
 * In-memory fixed-window rate limit, keyed by IP and action.
 *
 * Per-process and lost on restart, which is fine for what it defends: form
 * spam, password guessing and someone holding down the domain-search button.
 * A distributed limiter would need Redis, and this app runs as one pm2 process.
 */
const hits = new Map();

function rateLimited(ip, key, { max = 5, windowMs = 600_000 } = {}) {
  const now = Date.now();
  const id = `${key}:${ip || 'unknown'}`;
  const recent = (hits.get(id) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(id, recent);

  // Opportunistic sweep so a long-running process does not grow a map of every
  // IP that has ever visited.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
  }
  return recent.length > max;
}

/** Forget an IP's history for an action — called after a successful login. */
function clearRateLimit(ip, key) {
  hits.delete(`${key}:${ip || 'unknown'}`);
}

/** Trim and cap a form field in one step. */
const field = (v, max = 190) => String(v == null ? '' : v).trim().slice(0, max);

const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || ''));

/** Read a page number from the query string, clamped to something sane. */
function paging(req, { perPage = 25 } = {}) {
  const page = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
  return { page, perPage, offset: (page - 1) * perPage };
}

module.exports = { flash, rateLimited, clearRateLimit, field, isEmail, paging };
