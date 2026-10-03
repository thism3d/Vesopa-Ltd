/**
 * Continue with Vesopa — signing in to the client area through Vesopa Connect
 * (auth.vesopa.com), beside the email-and-password form, not instead of it.
 *
 * Modelled on vesopa_hosting/src/routes/vesopa-sso.js; the OIDC client itself
 * is lib/vesopa-oidc.js.
 *
 * DORMANT UNTIL CONFIGURED. Unless VESOPA_AUTH_CLIENT_ID and
 * VESOPA_AUTH_CLIENT_SECRET are both set, no route below exists (so
 * /portal/auth/vesopa/* answers 404) and no page draws the button. Rolling it
 * back is removing two lines from .env and a restart.
 *
 * WHO SOMEBODY IS, in order:
 *
 *   1. users.vesopa_sub — once linked, the address stops mattering, so a
 *      changed address at either end keeps working and a recycled one never
 *      matches an old account years later;
 *   2. the verified email — the first time, and the link is remembered. A row
 *      already linked to a DIFFERENT Vesopa account is refused, in words, and
 *      never relinked quietly;
 *   3. nobody — so a customer account is opened, exactly as /portal/register
 *      opens one (lib/onboarding.js openCustomerAccount), with a password hash
 *      nobody knows. "Forgotten your password?" can still give them one.
 *
 * Staff (role admin) come through the same door: they match by address like
 * anybody else and land on /portal/admin. An admin is never CREATED here — a
 * new row is always a customer.
 *
 * TEAM INVITATIONS. /portal/invite/:token offers "Join with your Vesopa
 * account". The invitation token is held in the session, tied to this sign-in's
 * state, and on the way back an account is made in the inviting organisation
 * with the invited role — but only when the Vesopa account's verified address
 * IS the invited address.
 *
 * EVERY FAILURE IS A REDIRECT, NEVER A RENDER. The callback URL carries a
 * one-time code; rendering a page on it would mean a reload replays a dead
 * code. A flash and a 303 leave the person on an address a reload cannot hurt.
 */

import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { one, exec } from "../lib/db.js";
import { createUser, normaliseEmail } from "../lib/auth.js";
import { openCustomerAccount } from "../lib/onboarding.js";
import { notify } from "../lib/notify.js";
import { config } from "../lib/config.js";
import { createClient } from "../lib/vesopa-oidc.js";
import { safeReturn, liveInvite } from "./auth.js";

const settings = config.vesopaAuth;

export const client = createClient({
  label: "portal_sso",
  issuer: settings.issuer,
  clientId: settings.clientId,
  clientSecret: settings.clientSecret,
  redirectUri: settings.redirectUri,
  scope: "openid profile email",
});

/** Whether Continue with Vesopa exists at all. index.js puts it on app.locals
 *  as `vesopaSso`, so every sign-in page knows whether to draw the button
 *  without a second request and without an inline script. */
export const LIVE = settings.enabled && client.enabled;

/* linkAndFind's answer when the address is ours but the link is somebody else's. */
const LINKED_ELSEWHERE = Symbol("linked to another Vesopa account");

const router = Router();

// Each start holds a pending sign-in in memory for ten minutes; a budget per
// address keeps somebody from filling that map, or the callback from being
// used to guess at anything.
const ssoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => refuse(req, res, "Too many attempts. Wait fifteen minutes and try again.", "/portal/login"),
});

if (LIVE) {
  router.get("/auth/vesopa/start", ssoLimiter, async (req, res, next) => {
    try {
      let hint = /^[^\s@]{1,120}@[^\s@]{1,120}$/.test(String(req.query.hint || "")) ? String(req.query.hint) : "";
      const inviteToken = String(req.query.invite || "").slice(0, 120);
      delete req.session.vesopaInvite;

      let invite = null;
      if (inviteToken) {
        invite = await liveInvite(inviteToken);
        if (!invite) {
          return refuse(req, res, "That invitation has expired or has already been used. Ask for a new one.", "/portal/login");
        }
        // Vesopa offers the invited address first, which is the only one that
        // can accept this invitation anyway.
        hint = invite.email;
      }

      const { url, state } = client.begin({
        returnTo: safeReturn(req.query.next),
        hint,
        select: req.query.switch === "1",
      });
      if (invite) req.session.vesopaInvite = { token: inviteToken, state };

      // Saved before leaving: the session must exist when auth.vesopa.com
      // sends the browser back (the cookie is SameSite=Lax, which a top-level
      // redirect carries).
      req.session.save((err) => (err ? next(err) : res.redirect(303, url)));
    } catch (err) { next(err); }
  });

  router.get("/auth/vesopa/callback", ssoLimiter, async (req, res, next) => {
    try {
      // The invitation belongs to THIS sign-in only: an abandoned attempt
      // from earlier must not be accepted by a later, unrelated one.
      const pending = req.session.vesopaInvite || null;
      delete req.session.vesopaInvite;
      const inviteToken = pending && pending.state === String(req.query.state || "") ? pending.token : null;
      const backTo = inviteToken ? `/portal/invite/${encodeURIComponent(inviteToken)}` : "/portal/login";

      let claims;
      let returnTo = "";
      try {
        const result = await client.complete(req.query);
        claims = result.claims;
        returnTo = safeReturn(result.returnTo);
      } catch (error) {
        console.warn("[portal_sso] sign-in did not complete:", error.message);
        const denied = String(req.query.error || "") === "access_denied";
        return refuse(req, res,
          denied
            ? "Your Vesopa account was not allowed into the Vesopa Software client area. Email info@vesopasoftware.com and we will sort it out."
            : "We could not finish signing you in with Vesopa. Please try again.",
          backTo);
      }

      /*
       * An unverified address proves nothing. Vesopa only says
       * `email_verified: true` for an address it confirmed itself, or one a
       * provider it trusts confirmed; matching a customer on anything weaker
       * would hand their projects and invoices to whoever typed the address.
       */
      const sub = String(claims.sub || "");
      const email = normaliseEmail(claims.email);
      if (!sub || !email || claims.email_verified !== true) {
        return refuse(req, res,
          "Your Vesopa account has no confirmed email address yet. Confirm it at auth.vesopa.com and try again.",
          backTo);
      }

      if (inviteToken) {
        const handled = await acceptInvite(req, res, next, { inviteToken, claims, sub, email, backTo });
        if (handled) return undefined;
      }

      let user = await linkAndFind(sub, email);

      if (user === LINKED_ELSEWHERE) {
        return refuse(req, res,
          "This client-area account is already joined to a different Vesopa account with the same address. " +
            "Sign in with that Vesopa account, use your password, or email info@vesopasoftware.com.",
          "/portal/login");
      }

      let flash = null;
      if (!user) {
        user = await openFromVesopa(claims, sub, email);
        if (!user) {
          return refuse(req, res, "We could not finish signing you in with Vesopa. Please try again.", "/portal/login");
        }
        flash = { kind: "ok", message: "Account created with your Vesopa account. Welcome aboard." };
      }

      return signIn(req, res, next, user, returnTo, flash);
    } catch (err) { next(err); }
  });
}

if (!LIVE) {
  // Switched off: say so plainly. Without this, the customer routes behind
  // this router would answer a signed-out visitor with a redirect to the
  // sign-in page, as they do for any address under /portal.
  router.all("/auth/vesopa/*", (req, res) =>
    res.status(404).render("error", {
      title: "Nothing here",
      message: "Signing in with Vesopa is not switched on here. Use your email and password.",
      back: "/portal/login",
    }));
}

/**
 * The invitation part of a callback. Returns true when it has answered the
 * request, false when the ordinary sign-in should carry on — which is the
 * case when an account for that address already exists: moving an existing
 * user between organisations is a support action, exactly as the password
 * form on the invitation page says.
 */
async function acceptInvite(req, res, next, { inviteToken, claims, sub, email, backTo }) {
  const invite = await liveInvite(inviteToken);
  if (!invite) {
    refuse(req, res, "That invitation has expired or has already been used. Ask for a new one.", "/portal/login");
    return true;
  }
  if (normaliseEmail(invite.email) !== email) {
    refuse(req, res,
      `This invitation is for ${invite.email}, but that Vesopa account is ${email}. ` +
        `Continue with a Vesopa account for ${invite.email}, or set a password below.`,
      backTo);
    return true;
  }

  const existing = await linkAndFind(sub, email);
  if (existing) {
    if (existing === LINKED_ELSEWHERE) {
      refuse(req, res,
        "An account for this address already exists and is joined to a different Vesopa account. " +
          "Email info@vesopasoftware.com and we will sort it out.",
        "/portal/login");
      return true;
    }
    // Signed in to the account they already have; the invitation is left as
    // it is, and they are told why.
    await signIn(req, res, next, existing, "", {
      kind: "warn",
      message: `You already had an account for ${email}, so you are signed in to that. ` +
        `To move it into ${invite.org_name}, email info@vesopasoftware.com.`,
    });
    return true;
  }

  let id;
  try {
    id = await createUser({
      email, password: unusablePassword(), name: nameFrom(claims, email, invite.name),
      company: invite.org_name, role: "customer",
    });
  } catch (err) {
    if (err?.code !== "ER_DUP_ENTRY") throw err;
    // A second callback racing this one made it first.
    refuse(req, res, "We could not finish joining the team. Please try again.", backTo);
    return true;
  }
  await exec(
    "UPDATE users SET org_id = ?, org_role = ?, vesopa_sub = ?, vesopa_linked_at = NOW() WHERE id = ?",
    [invite.org_id, invite.org_role, sub, id],
  );
  await exec("UPDATE invitations SET accepted_at = NOW() WHERE id = ? AND accepted_at IS NULL", [invite.id]);

  const user = await one("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
  if (invite.invited_by) {
    await notify(invite.invited_by, {
      kind: "team", title: `${user.name} joined your team`,
      body: `${invite.email} · ${invite.org_role}`, href: "/portal/team",
    });
  }
  await signIn(req, res, next, user, "/portal", { kind: "ok", message: `You are in. Welcome to ${invite.org_name}.` });
  return true;
}

/**
 * Find the user this Vesopa account belongs to, and remember the link. By
 * subject first, verified address second.
 */
async function linkAndFind(sub, email) {
  const bySub = await one("SELECT * FROM users WHERE vesopa_sub = ? LIMIT 1", [sub]);
  if (bySub) return bySub;

  const byEmail = await one("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
  if (!byEmail) return null;

  // Refuse to steal a link that belongs to somebody else: whoever signed in
  // most recently owning the account is not a decision to make quietly.
  if (byEmail.vesopa_sub && byEmail.vesopa_sub !== sub) {
    console.warn(`[portal_sso] user ${byEmail.id} is already linked to another Vesopa account`);
    return LINKED_ELSEWHERE;
  }

  // Conditional, so two callbacks racing cannot both claim the row.
  await exec(
    "UPDATE users SET vesopa_sub = ?, vesopa_linked_at = NOW() WHERE id = ? AND vesopa_sub IS NULL",
    [sub, byEmail.id],
  );
  return { ...byEmail, vesopa_sub: sub };
}

/**
 * The first sign-in from an address the client area has never seen: a
 * customer account, opened exactly as /portal/register opens one, minus the
 * password they would have chosen.
 */
async function openFromVesopa(claims, sub, email) {
  const name = nameFrom(claims, email);
  let id;
  try {
    id = await createUser({ email, password: unusablePassword(), name, role: "customer" });
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") return null;
    throw err;
  }
  await exec("UPDATE users SET vesopa_sub = ?, vesopa_linked_at = NOW() WHERE id = ?", [sub, id]);
  await openCustomerAccount({ id, name, email, company: "", via: "vesopa" });
  return one("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
}

/** Signed in exactly as the password form signs somebody in. */
async function signIn(req, res, next, user, returnTo, flash = null) {
  if (user.status !== "active") {
    return refuse(req, res, "That account is suspended. Email info@vesopasoftware.com.", "/portal/login");
  }

  await exec("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);

  // Read before regenerating, which replaces the session and everything in it.
  const to = returnTo
    || safeReturn(req.session.returnTo)
    || (user.role === "admin" ? "/portal/admin" : "/portal");

  // A new session id on sign-in, so a fixated one never becomes authenticated.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    if (flash) req.session.flash = flash;
    req.session.save(() => res.redirect(303, to));
  });
  return undefined;
}

/** Back to a sign-in page with the reason, on an address a reload cannot replay. */
function refuse(req, res, message, to) {
  req.session.flash = { kind: "bad", message };
  req.session.save(() => res.redirect(303, to));
}

/** A bcrypt hash of 32 random bytes nobody keeps — well-formed, and matched
 *  by no password ever typed (as lib/onboarding.js does for invited users). */
function unusablePassword() {
  return crypto.randomBytes(32).toString("base64url");
}

/** Whatever Vesopa knows the person as, else the invitation's name, else the
 *  part of the address before the @. users.name is NOT NULL. */
function nameFrom(claims, email, fallback = "") {
  const given = String(claims.given_name || "").trim();
  const family = String(claims.family_name || "").trim();
  const whole = String(claims.name || "").trim();
  const name = whole || [given, family].filter(Boolean).join(" ") || String(fallback || "").trim() || email.split("@")[0];
  return name.slice(0, 120);
}

export default router;
