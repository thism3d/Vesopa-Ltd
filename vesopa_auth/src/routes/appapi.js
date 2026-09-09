/**
 * The small API an application uses to decide who may use IT.
 *
 * WHY IT EXISTS. The owner's rule, in his words: *"anyone can register account
 * to Vesopa Account but not every Oauth apps let's anyone to connect to their
 * app, admin decide that. Ex: Vespa Kitchen menu anyone can accept and use the
 * app. Vesopa Backoffice whereas Backoffice admin decides and create user and
 * invite that user through Vesopa account."*
 *
 * The developer portal can do this by hand, and that is right for somebody who
 * builds on Vesopa. It is wrong for a back-office manager adding a new member
 * of staff on a Tuesday: they are already on a screen where they create the
 * staff member, they have never heard of a developer portal, and telling them
 * to go and find one is how a feature becomes unused. So the application does
 * it on their behalf, from its own screen, with its own credentials.
 *
 * WHAT AN APPLICATION MAY DO HERE, and it is deliberately three verbs:
 *
 *   invite an address to ITSELF
 *   see the invitations it has issued and not yet had accepted
 *   withdraw one
 *
 * WHAT IT MAY NOT DO. It cannot read the identity provider's users, cannot ask
 * whether an address has a Vesopa account, and cannot grant itself anything for
 * anybody else. Every one of those is a way to turn a customer's back office
 * into a tool for enumerating everybody who has ever held a Vesopa account, and
 * an application only ever sees the people who have a membership row for it.
 *
 * THE INVITATION IS STILL NOT A WAY IN. It grants a membership to whoever
 * proves they own the address, and the proving is the ordinary sign-in. An
 * application with stolen credentials can post invitations to addresses; it
 * cannot make anybody accept one, and it cannot read anything back about a
 * person who has not.
 */

const express = require('express');

const db = require('../db');
const clients = require('../oauth/clients');
const invitations = require('../invitations');
const events = require('../events');
const rateLimit = require('../ratelimit');
const { normaliseEmail } = require('../normalise');

const router = express.Router();

function problem(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}

/**
 * The application, authenticated by its own client credentials.
 *
 * CONFIDENTIAL CLIENTS ONLY. A public client's "credentials" are in a phone
 * app or a page's source, so anybody at all would be able to send invitations
 * in a venue's name — and an invitation is an email that arrives with somebody
 * else's branding on it. The till and the kitchen screen are public clients and
 * are refused here; the back office is confidential and is the one that needs
 * this.
 */
async function authenticate(req) {
  let clientId = req.body.client_id;
  let secret = req.body.client_secret;

  const header = String(req.get('authorization') || '');
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    if (at > 0) {
      clientId = decodeURIComponent(decoded.slice(0, at));
      secret = decodeURIComponent(decoded.slice(at + 1));
    }
  }

  const application = await clients.find(clientId);
  if (!application) return { error: 'invalid_client' };
  if (clients.isPublic(application)) {
    return { error: 'invalid_client', description: 'This endpoint needs a confidential client.' };
  }
  if (!(await clients.verifySecret(application, secret))) {
    return { error: 'invalid_client', description: 'Client authentication failed.' };
  }
  return { application };
}

/** Every route here authenticates the same way and is limited the same way. */
async function gate(req, res) {
  const auth = await authenticate(req);
  if (auth.error) {
    problem(res, 401, auth.error, auth.description || 'Client authentication failed.');
    return null;
  }

  /*
   * Limited on the CLIENT, because that is what is being spent: each of these
   * can send an email, and a loop in somebody's integration should cost them a
   * 429 rather than cost us a mail reputation.
   */
  const attempt = await rateLimit.hit('app-invite', String(auth.application.id), {
    limit: 60,
    windowSeconds: 3600,
  });
  if (!attempt.allowed) {
    problem(res, 429, 'rate_limited', 'Too many invitations from this application this hour.');
    return null;
  }
  return auth.application;
}

// ---------------------------------------------------------------------------
// Invite somebody to this application
// ---------------------------------------------------------------------------

router.post('/api/app/invitations', async (req, res, next) => {
  try {
    const application = await gate(req, res);
    if (!application) return undefined;

    const email = String(req.body.email || '').trim();
    if (!normaliseEmail(email)) {
      return problem(res, 400, 'invalid_request', 'A valid email address is required.');
    }

    /*
     * A role, if one was named — BY KEY, and only one of this application's
     * own. Applications know their roles by the key they chose ("manager"),
     * not by a numeric id in our database, and accepting an id would let one
     * application grant another's role.
     */
    let roleId = null;
    if (req.body.role) {
      const role = await db.one(
        'SELECT id FROM application_roles WHERE application_id = ? AND role_key = ?',
        [application.id, String(req.body.role).slice(0, 64)],
      );
      if (!role) {
        return problem(res, 400, 'invalid_request', 'That role is not one this application defines.');
      }
      roleId = role.id;
    }

    const result = await invitations.create({
      email,
      // No person invited them — the application did, on somebody's behalf. The
      // audit line records the application, which is the honest answer.
      invitedBy: null,
      applicationId: application.id,
      roleId,
      message: String(req.body.message || '').slice(0, 500),
      ip: req.clientIp,
    });

    if (!result.ok) return problem(res, 409, 'conflict', result.error);

    await events.recordAudit({
      actorType: 'application',
      action: 'invitation.created',
      targetType: 'invitation',
      targetId: result.publicId,
      applicationId: application.id,
      detail: { email: normaliseEmail(email), role: req.body.role || null },
      ip: req.clientIp,
    });

    /*
     * The URL comes back as well as being emailed. Somebody whose email is
     * exactly the thing that is broken is one of the commonest reasons for an
     * invitation, and the back office can then show it to the manager to read
     * out. It is a bearer credential for seven days, so it is returned to the
     * application that asked and never logged.
     */
    return res.status(201).json({
      id: result.publicId,
      email,
      url: result.url,
      expires_in_days: invitations.TTL_DAYS,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// What is outstanding
// ---------------------------------------------------------------------------

router.post('/api/app/invitations/list', async (req, res, next) => {
  try {
    const application = await gate(req, res);
    if (!application) return undefined;

    const waiting = await invitations.list({ applicationId: application.id });
    return res.json({
      invitations: waiting.map((row) => ({
        id: row.public_id,
        email: row.email,
        role: row.role_name || null,
        created_at: row.created_at,
        expires_at: row.expires_at,
        sent_count: row.sent_count,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/app/invitations/:id/revoke', async (req, res, next) => {
  try {
    const application = await gate(req, res);
    if (!application) return undefined;

    // Scoped to this application, so an id from somewhere else is a 404 and not
    // a way to withdraw a stranger's invitation.
    const invitation = await invitations.forApplication(req.params.id, application.id);
    if (!invitation) return problem(res, 404, 'not_found', 'No such invitation.');

    await invitations.revoke(invitation.public_id, null, req.clientIp);
    return res.json({ id: invitation.public_id, revoked: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
