/**
 * Headers every response gets, and a per-key rate limiter.
 *
 * The Flutter web build needs 'wasm-unsafe-eval' and its own inline bootstrap
 * is avoided (web/index.html loads flutter_bootstrap.js as a file), so the
 * policy stays strict otherwise.
 */

function headers(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "connect-src 'self' https://www.gstatic.com https://fonts.gstatic.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

/** A fixed one-minute window per key, in memory. */
function limiter({ perMinute, key = (req) => req.ip }) {
  const windows = new Map();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const w = windows.get(k);
    if (!w || now - w.start >= 60000) {
      windows.set(k, { start: now, count: 1 });
      if (windows.size > 10000) for (const [kk, v] of windows) if (now - v.start >= 60000) windows.delete(kk);
      return next();
    }
    w.count += 1;
    if (w.count > perMinute) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'That was a lot of tries in a minute. Wait a moment and try again.', code: 'slow_down' });
    }
    next();
  };
}

module.exports = { headers, limiter };
