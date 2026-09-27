/**
 * Sessions: a signed token this server issues after Continue with Vesopa.
 *
 * Members carry it as a Bearer token (the app keeps it the way the loyalty app
 * keeps its own). Staff carry it in an httpOnly cookie on the console.
 *
 * A token names the member and a `ver`: the member's row is read on every call,
 * so a suspended or deleted membership stops at the next request, not when the
 * token runs out.
 */

const jwt = require('jsonwebtoken');
const config = require('./config');

const MEMBER_TTL = '30d';
const ADMIN_TTL = '12h';

function issueMember(member) {
  return jwt.sign({ kind: 'member', mid: member.id }, config.SESSION_SECRET, { expiresIn: MEMBER_TTL, algorithm: 'HS256' });
}

function issueAdmin({ sub, email, name }) {
  return jwt.sign({ kind: 'admin', sub, email, name }, config.SESSION_SECRET, { expiresIn: ADMIN_TTL, algorithm: 'HS256' });
}

function read(token, kind) {
  if (!token) return null;
  try {
    const claims = jwt.verify(token, config.SESSION_SECRET, { algorithms: ['HS256'] });
    return claims.kind === kind ? claims : null;
  } catch {
    return null;
  }
}

/** Short-lived, signed state for a sign-in this server started (console). */
function packState(data) {
  return jwt.sign({ kind: 'state', ...data }, config.SESSION_SECRET, { expiresIn: '10m', algorithm: 'HS256' });
}

module.exports = { issueMember, issueAdmin, read, packState };
