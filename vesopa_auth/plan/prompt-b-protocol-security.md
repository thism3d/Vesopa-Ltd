You are Kimi K3, acting as principal architect for a production identity provider.
Answer as a specification, not an essay. No preamble, no summary. Output GitHub-flavoured
Markdown, at most 240 lines. Decision-dense: state THE decision and one line of why.

# The system

"Vesopa OAuth" at https://auth.vesopa.com — Node.js + Express + MySQL, single server, pm2.
It becomes the ONLY login for: an Electron EPOS till on Windows, a QR dine-in menu web app,
a server-rendered back-office (Express + sessions), a hosting control panel, and third-party
apps built by Vesopa's own developers later. Also a public API for developers.

The owner's words, to honour:
- Developers get an account, then create **Applications**. Each application has its own
  endpoints, its own users, and is **isolated** from other applications — but applications
  owned by the same developer account may optionally **share** user data.
- Role-based permission, e.g. an app "Vesopa EPOS" needs one identity that nonetheless
  distinguishes till users, menu users and back-office users. Decide the cleanest model.
- "Remember me on this device" tickbox on the login form.
- End users see their connected apps, their devices and their login history (with IP).

# What I need from you

1. **Which protocol, exactly.** OAuth 2.1 + OIDC — say which grants you implement and which
   you refuse. For each of the five client types above (Electron desktop, browser SPA,
   server-rendered Express app, mobile later, machine-to-machine) name the grant, whether
   PKCE, whether a client secret, and the redirect-URI rule. Be explicit about the Electron
   till: loopback redirect vs custom scheme vs device code — pick one and defend it.

2. **Tokens.** Access token format (JWT vs opaque + introspection) — decide, and justify
   against the fact that all resource servers are ours today but third parties come later.
   Lifetimes for access / refresh / ID token. Refresh token rotation and reuse detection:
   give the exact table columns and the exact detection rule. Signing: RS256 vs EdDSA, key
   rotation, JWKS endpoint, `kid` handling.

3. **The SSO session.** The cookie at auth.vesopa.com that makes the second app a
   one-click login. Name, flags, lifetime, and how "remember me on this device" changes it.
   How does a device get remembered without becoming a permanent bearer credential —
   describe the device-binding record and what invalidates it. How does logout work: local,
   single-app, and global (OIDC RP-initiated logout / back-channel logout — say whether you
   implement back-channel now or stub it).

4. **Isolation vs sharing between applications.** The core tenancy question. Options: one
   global user pool with per-app grants; per-app user pools; per-"organisation" pools with
   apps inside. PICK ONE for Vesopa and say what it costs. Then define how a developer opts
   two of their own apps into sharing a user, and what the user sees and consents to.
   Give the tables.

5. **Roles, scopes and permissions.** Reconcile OAuth scopes (what the app may do) with app
   roles (what the user may do inside the app). Give the schema for roles per application,
   role assignment per user per application, and how a claim like `roles: ["till.operator"]`
   lands in the token without bloating it. Answer the owner's EPOS example concretely.

6. **Security controls to ship on day one, not later.** Rank them. Include at minimum: PKCE,
   state/nonce, exact redirect matching, CSRF on all form posts, password hashing choice and
   parameters, brute-force and credential-stuffing defence, session fixation, open-redirect
   defence on `next`/`return_to`, clickjacking on the consent screen, the security headers
   and CSP for a login page, secret storage at rest, audit log contents, and what MUST be
   rate limited. Note the ones people skip.

7. **Multi-factor in the token.** The system will support TOTP authenticator apps, SMS
   second factor, and passkeys (WebAuthn). Say how `amr`/`acr` claims are set, how an
   application declares "this action needs a second factor", and how step-up authentication
   works mid-session without logging the user out.

8. **What breaks when this server is down.** Every login at Vesopa now depends on one box.
   Give the mitigation list an implementer can actually build in week one.

Finish with `## What I would get wrong first` — the three mistakes you predict.
