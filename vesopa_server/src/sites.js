/**
 * More than one site under one login.
 *
 * WHY THIS IS SMALL
 *
 * Every back-office route already finds its venue the same way: the office id
 * in the signed session -> offices.contact_email, the tenant key every table is
 * scoped by. So managing a second site is holding a session for that site, and
 * switching is issuing a new session with the other office in it -- after
 * checking this login is allowed there. Nothing else in the back office has to
 * learn that sites exist, and nothing one site does can touch another, because
 * nothing ever could.
 *
 * WHO MAY MANAGE WHICH SITE
 *
 * A login's own office (backoffice_users.office_id), plus the sites the platform
 * admin has linked to it (bo_user_sites). The link is checked on every switch,
 * so taking a site away takes effect at the next switch; a session already
 * inside the site keeps working until it expires, like any other session.
 *
 * TILLS
 *
 * A till belongs to exactly one site. A login with more than one is asked which
 * site the till is for when it is signed in (1.7.3.0); an older till asks
 * nothing and is signed in to the login's own office, as it always was.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth, issueToken } = require('./auth');

/**
 * The sites this login may manage: its own office first, then the linked ones,
 * by name. Archived sites are left out -- there is nothing to manage in one.
 */
async function sitesFor(db, userId) {
  const [[me]] = await db.query('SELECT office_id FROM backoffice_users WHERE id = ?', [userId]);
  let linked = [];
  try {
    [linked] = await db.query(
      `SELECT o.id, o.name, o.contact_email, o.status
         FROM bo_user_sites s JOIN offices o ON o.id = s.office_id
        WHERE s.user_id = ? AND o.status <> 'archived'
        ORDER BY o.name`,
      [userId]
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  const sites = [];
  if (me && me.office_id) {
    const [[home]] = await db.query(
      'SELECT id, name, contact_email, status FROM offices WHERE id = ?',
      [me.office_id]
    );
    if (home) sites.push({ ...home, home: true });
  }
  for (const site of linked) {
    if (!sites.some((s) => s.id === site.id)) sites.push({ ...site, home: false });
  }
  return sites;
}

/** Whether this login may manage that office. */
async function mayManage(db, userId, officeId) {
  const sites = await sitesFor(db, userId);
  return sites.find((s) => Number(s.id) === Number(officeId)) || null;
}

/**
 * A session for another site, for the same person.
 *
 * Keeps what is left of the current session's lifetime rather than starting a
 * new one: switching site must not be a way to turn a twelve-hour sign-in into
 * a thirty-day one.
 */
function sessionFor(claims, officeId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const left = claims.exp ? Math.max(60, claims.exp - now) : 12 * 3600;
  return issueToken(
    { id: claims.sub, email: claims.email, name: claims.name, role: claims.role, officeId },
    secret,
    left
  );
}

function siteRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /** The sites this login may manage, and which one this session is in. */
  router.get('/sites', auth, async (req, res, next) => {
    try {
      const sites = await sitesFor(pool, req.user.sub);
      res.json({
        current: req.user.officeId ?? null,
        sites: sites.map((s) => ({
          id: s.id, name: s.name, status: s.status, home: s.home,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Move this session to another site. Answers with the new session token;
   * the back office stores it and reloads into the site.
   */
  router.post('/sites/switch', auth, async (req, res, next) => {
    try {
      const officeId = Number((req.body || {}).office_id);
      if (!Number.isInteger(officeId) || officeId <= 0) {
        return res.status(400).json({ error: 'Which site?' });
      }
      const site = await mayManage(pool, req.user.sub, officeId);
      if (!site) {
        return res.status(403).json({ error: 'This login cannot manage that site.' });
      }
      if (site.status !== 'active' && req.user.role !== 'admin') {
        return res.status(403).json({
          error: `${site.name} is ${site.status}. Please contact Vesopa support.`,
        });
      }
      res.json({
        token: sessionFor(req.user, site.id, secret),
        // The tenant key too: the back office's live-update socket subscribes
        // by it, and a switched session left listening to the old site would
        // show the old site's orders arriving.
        site: { id: site.id, name: site.name, email: site.contact_email },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/**
 * A short-lived pass for a till that has to be asked which site it is for.
 *
 * A Vesopa sign-in token can be spent once, so a till cannot send it again with
 * the site chosen. This names the person who just proved who they are, for five
 * minutes, so the till can come back with the site.
 */
function sitePickToken(userId, secret) {
  return jwt.sign({ scope: 'site-pick', sub: userId }, secret, { expiresIn: '5m' });
}

function readSitePickToken(token, secret) {
  const claims = jwt.verify(String(token || ''), secret);
  if (claims.scope !== 'site-pick') throw new Error('Not a site-pick token');
  return claims.sub;
}

/**
 * The same person, signed in to a chosen site: what a till's credentials are
 * issued from once somebody has said which site the till is for.
 */
function atSite(user, site) {
  return {
    ...user,
    officeId: site.id,
    officeName: site.name,
    officeEmail: site.contact_email,
  };
}

/**
 * For a till that can ask: which site is this one for?
 *
 * Returns `{ user }` when the answer is settled -- one site, or [officeId]
 * names one this login may manage -- or `{ choose }` with the sites to offer.
 * A till that does not ask ([canAsk] false) always gets the login's own office,
 * exactly as before sites existed.
 */
async function resolveTillSite(db, user, { canAsk, officeId }) {
  if (!canAsk) return { user };
  const sites = (await sitesFor(db, user.id)).filter((s) => s.status === 'active');
  if (officeId) {
    const site = sites.find((s) => Number(s.id) === Number(officeId));
    if (!site) return { error: 'This login cannot set up a till for that site.' };
    return { user: atSite(user, site) };
  }
  if (sites.length <= 1) return { user };
  return { choose: sites.map((s) => ({ id: s.id, name: s.name, home: s.home })) };
}

module.exports = {
  siteRoutes,
  sitesFor,
  mayManage,
  atSite,
  resolveTillSite,
  sitePickToken,
  readSitePickToken,
};
