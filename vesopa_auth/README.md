# Vesopa OAuth — `auth.vesopa.com`

The identity provider that is replacing every login across Vesopa Ltd: the EPOS
till, the QR dine-in menu, the back office, the hosting control panel, and
whatever is built next.

**It is live and working.** 287 automated checks pass against the real domain —
not a local mock — and a person can create an account, sign in and manage it
today. A developer can create an OAuth application, register a redirect URI and
mint a credential without touching this repository or the database.

> This file is the **handover**: what exists, how to work on it, and the traps
> that have already cost time. [`OAuthTasksWithProperStructureInfo.md`](OAuthTasksWithProperStructureInfo.md)
> is the **plan**: the architecture, the decisions and their reasoning, and the
> phases still to come. Read this one to do work; read that one to understand
> why the work is shaped as it is.

---

## 1. Where everything is

| | |
|---|---|
| Live site | <https://auth.vesopa.com> |
| Server | `root@34.63.118.67` — the Hestia box, hostname `panel.vesopa.com` |
| App directory | `/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp` |
| Port | `20003` behind nginx (20001 and 20002 belong to other apps) |
| Database | `vesopasoftware_authdb`, user `vesopasoftware_authuser` |
| Process | pm2, named `auth.vesopa.com`, running as the `vesopasoftware` user |
| Stack | Node 24, Express 5, EJS, mysql2, MariaDB 11.8 |

**This box also runs `cloud.vesopa.com` and `vesopasoftware.com`.** They are live
products. Never `pm2 restart all`, never `v-rebuild-web-domains` across the
account, and never change a system package or a shared template without asking
the owner first.

```
vesopa_auth/
  README.md                              this file
  OAuthTasksWithProperStructureInfo.md   the plan, the decisions, what is left
  plan/            Kimi K3's four specifications, unedited, plus the prompts
  schema/          schema.sql, schema_002_runtime.sql, schema_003_*.sql, verify-uniqueness.sql
  scripts/         deploy, provision, seed, and the smoke tests
  src/             the application
  test/            node --test
  views/           EJS templates
  public/          css, js, brand assets
  content/policies/  the eight policy documents, as Markdown
  .env             the live environment, pulled from the server (gitignored)
```

---

## 2. Working on it from this Windows machine

`rsync`, `sshpass` and an interactive `ssh` password do not work here, so
everything goes through a paramiko helper.

```bash
# Deploy: upload, install, apply schema, check templates, restart, verify.
python vesopa_auth/scripts/deploy.py
python vesopa_auth/scripts/deploy.py --no-schema     # skip the schema step
python vesopa_auth/scripts/deploy.py --restart-only

# Anything on the server.
python tool/auth_ssh.py run "pm2 status"
python tool/auth_ssh.py put vesopa_auth/src "@app/src"
python tool/auth_ssh.py get "@app/.env" vesopa_auth/.env
python tool/auth_ssh.py pm2 "restart auth.vesopa.com"

# Look at it.
python tool/auth_shot.py <tag> <path> [widths]   # screenshots, light and dark
python tool/auth_measure.py login ".btn"         # measure real elements
python tool/auth_nav_test.py                     # the no-reload router
```

**Use `@app` for remote paths, never a literal `/home/...`.** Git Bash rewrites
POSIX-looking arguments on their way to a native Windows program, so a literal
path arrives as `C:/Program Files/Git/home/...` and every call fails with "No
such file". The same applies to `tool/auth_shot.py login /login` — pass `login`
without the leading slash.

**`tool/auth_ssh.py` is not the same as `.claude/skills/vesopa-ops/scripts/vesopa_ssh.py`.**
That one points at a *different server* (the EPOS back office) and will happily
run your command there. Setting `VESOPA_SSH_HOST=` in front of it does nothing —
it reads `.env.claude-tools` and the file deliberately beats the environment.

---

## 3. Testing

Everything runs **on the server, against the live domain**, because that is where
nginx, the certificate, the cookie flags and the real database are.

```bash
python tool/auth_ssh.py run "cd @app && node --test test/*.test.js"          # 112
python tool/auth_ssh.py run "cd @app && bash scripts/smoke-login.sh"         # 27
python tool/auth_ssh.py run "cd @app && node scripts/smoke-oidc.js"          # 40
python tool/auth_ssh.py run "cd @app && node scripts/smoke-social.js"        # 39
python tool/auth_ssh.py run "cd @app && node scripts/smoke-portal.js"        # 45
python tool/auth_nav_test.py                                                 # 15
python tool/auth_loadbar_test.py                                             # 11
```

What each one is for:

* **`test/`** — TOTP against RFC 6238's own published vectors, email and phone
  normalisation, AES-GCM, pairwise subjects, and **every template compiling**.
* **`scripts/smoke-login.sh`** — signs in for real: posts the form, waits for
  the message to land in the mailbox, reads the code out of it, types it back.
  Also checks every account section and every policy page.
* **`scripts/smoke-oidc.js`** — the whole protocol, and every refusal. The
  refusals are the product: unknown client, unregistered redirect, missing PKCE,
  altered `redirect_uri`, replayed code, reused refresh token.
* **`scripts/smoke-social.js`** — asks **Google, Microsoft and GitHub directly**
  whether we are registered, and asks Microsoft to validate the client secret.
  Catches the two failures that break social sign-in for every user at once and
  are invisible until somebody tries it.
* **`scripts/smoke-portal.js`** — creates an application through the web
  interface, registers redirect URIs, mints a secret and **uses it against
  `/oauth/token`**, then archives what it made. Its refusals are the product
  too: an `http://` redirect, a wildcard, a `#fragment`, `localhost`, removing
  the last redirect URI, a browser app asking for a secret, and an SVG logo —
  which would be a stored XSS hole on the domain that holds every session.
* **`tool/auth_nav_test.py`** — drives a real browser to prove the no-reload
  router does not break the sign-in form.
* **`tool/auth_loadbar_test.py`** — proves the progress bar appears in all
  three cases: a routed link, a form submit, and the hand-off to a provider.
  The last is the longest wait on the site and the one the router never sees.
* **`tool/auth_console_shot.py`** — photographs the signed-in pages, in both
  colour schemes, and `--as somebody@example.com` photographs them as that
  person. That is the only way to check what a developer granted ONE
  application actually sees.

---

## 4. What is done

### Working, proven on the live domain

* **The sign-in page is the registration page.** One form; whether an account is
  created depends only on whether the identifier is already known.
* **Email first with a toggle to phone**, the opposite way round from the
  dine-in menu, which is deliberate.
* **Email codes** (ours: minted, HMAC'd under a pepper, sent, checked here) and
  **phone codes** (Postcoder's: they mint, send AND verify — we never see the
  code, so the row holds their reference instead of a hash).
* **Google, Apple, Microsoft and GitHub** sign-in, all four verified against the
  real providers.
* **Passkeys** — registration and sign-in, discoverable credentials, conditional
  UI on the email field.
* **TOTP** with a server-rendered QR and ten single-use recovery codes.
* **OpenID Connect provider** — discovery, `/authorize`, `/token`, `/userinfo`,
  JWKS with three-state key rotation, consent, revocation, introspection,
  RP-initiated logout.
* **The account area** — profile with picture, security, linked accounts,
  devices, sign-in history, connected apps, deletion.
* **Eight policy pages**, served and reachable, with the company details filled
  in.
* **A landing page and developer documentation**, both of which an OAuth
  reviewer will read.
* **A developer portal** at `/developers` — create an application, register
  redirect URIs with the rules explained as you type, mint and revoke client
  secrets (shown once, never stored), choose scopes, define roles, upload a
  logo, see who uses it and who may edit it. Access is grantable **per
  application**, not only per organisation.
* **An admin console** at `/admin` — overview, people search, applications,
  activity, health and the sign-in page settings. The charts read **daily
  rollups**, never a `GROUP BY` over raw events.
* **A progress bar** across the top of every page, the same one the EPOS back
  office uses, on links, on forms and on the hand-off to a provider.
* **No-reload navigation** across the whole site, written so that any doubt at
  all falls back to an ordinary page load.

### The rules the owner asked for, and where each one lives

| Rule | Where |
|---|---|
| One Gmail per account while active; free again once revoked; history kept | A **database index**, not application code — `user_identities.active_flag`, proven by `schema/verify-uniqueness.sql` |
| The login page is the registration page | `src/routes/auth.js`, `views/login.ejs` |
| Email first, phone second | `views/login.ejs` |
| New email verified once; a provider's email not re-verified | `src/routes/social.js`, `identity.findLinkCandidate` |
| Password offered after verification, never required | `/account/security` |
| Remember me on this device | `src/sessions.js` — buys a longer session and skipping the **second** factor, never the first |
| Applications isolated, roles inside them | `application_members` + `application_roles`; one EPOS application with roles, a separate one for the menu |
| Compact or extended sign-in layout, chosen by an admin | `src/settings.js`, `/admin` |

---

## 5. Traps that have already cost time

Each of these has caused a real failure here. They are not hypothetical.

**`CREATE TABLE IF NOT EXISTS` does nothing to a table that exists.** Adding a
column to `schema.sql` changes nothing on a database that has been created once,
and the deploy reports "ok". A new column goes in **both** `schema.sql` (for a
fresh database) **and** a numbered migration using `vesopa_add_column` (for the
ones that exist). Symptom: `Unknown column` from a query that works locally.

**EJS tags do not nest.** Writing `<%= x %>` inside a `<% /* comment */ %>`
block stops the file compiling — and if the page is on a rare path, nothing
catches it until a real person hits it. That happened, on the account-linking
interrupt, discovered by a live Google sign-in. `test/views.test.js` now checks
every template, and `deploy.py` **will not restart the app** if one fails.

**Every string column pins `COLLATE utf8mb4_general_ci`.** A bare `utf8mb4` on
this MariaDB resolves to a collation that does not compare against `general_ci`,
so a query works locally and silently matches nothing in production. The one
exception is `user_identities.identifier_norm`, which is **`utf8mb4_bin`** on
purpose: provider subject ids are case-sensitive, and folding them would collide
two different people onto one account.

**It is the *proxy* template that must be `NodeJS`, not the web template.**
`v-change-web-domain-tpl` answers *"NodeJS web template doesn't exist"*, which
reads like a missing file and is a wrong command. Use
`v-change-web-domain-proxy-tpl`.

**Mail goes to `panel.vesopa.com:25`, not `localhost`.** exim offers STARTTLS
with a certificate for its own hostname, so `localhost` fails verification with
"Hostname/IP does not match certificate's altnames" — which reads like a broken
mail server and is a name mismatch.

**pm2 is per Hestia user.** Every command must go through
`su - vesopasoftware -c 'PM2_HOME=/home/vesopasoftware/.pm2 pm2 …'`. As root you
start a second daemon and the two fight over the port.

**Shell scripts must be LF.** Editing one with Python on Windows writes CRLF and
bash on the server reports `$'\r': command not found`, which looks like a syntax
error in correct code.

**A direct child of `<body>` needs `width: 100%`.** `body` is a column flexbox;
`margin: 0 auto` on a child overrides the stretch and shrinks it to its content.
That is why the site header once sat marooned in the middle of the page.

**Never assume a browser quirk is a bug in the code.** Microsoft answers
`prompt=none` with an HTML hand-off page rather than an HTTP redirect; GitHub
double-encodes the redirect URI inside `return_to`. Both looked like broken
integrations and were correct behaviour.

---

## 6. Credentials

All of them live in **`.env.claude-tools`** at the repository root, gitignored —
secrets as strings, credential files as absolute paths. The running application
reads its own `.env` on the server; `vesopa_auth/.env` is a copy of that, pulled
down with `auth_ssh.py get "@app/.env"`, also gitignored.

**Two Microsoft registrations exist and their secrets are not interchangeable.**
`VESOPA_AUTH_MICROSOFT_*` is the app "Vesopa" (`335a71ee…`), the identity
provider. `MS_STORE_*` / `VESOPA_EPOS_MICROSOFT_*` is "VesopaEPOS"
(`6ef0452e…`), the Microsoft Store submission client. Using the wrong one fails
with `AADSTS7000215`, which says only "invalid client secret".

Never print a secret into command output, a commit message, or a file that is
not gitignored — and scrub provider error bodies before showing them, because an
error can quote the credential back.

---

## 7. What is left

In the order it should be done.

**1. SMS as a second factor**, and step-up authentication at `/authorize` via
`acr_values`. The claims (`amr`, `acr`) are already carried in every token and
recorded on every session; the enforcement is not written. These are the last
two items of Phase 3.

**2. Webhooks** — telling an application that a person changed or deleted their
account. The only part of Phase 4 not built.

**3. Invitations, and resetting a factor for somebody.** `/admin/people` can
search, suspend, restore and grant access, and it deliberately cannot sign in as
anybody. Helping a person who has lost their authenticator still needs doing,
and it needs building as something visible to them in their own history.

**4. Migrate the four products.** The order is settled: **QR menu → back office
→ hosting panel → till.** The rules are not negotiable:

* The identity provider **never writes to a product's database.**
* Legacy login ships **dormant behind a flag**; rollback is flipping it back.
* **No bulk password reset.** Import the existing hashes with an algorithm tag,
  verify with the old algorithm at first sign-in, rehash to argon2id silently.
* **Sessions are not ported.** One clean re-login beats importing an insecure
  session format.
* Dual-auth during the soak; 90 days before the legacy code is removed.

**7. Outstanding, not code:**

* **The ICO registration number.** Deliberately not invented — the policy pages
  give the ICO complaint route instead, which is what UK GDPR requires of us.
  The data-protection fee registration is itself a legal obligation.
* **Google and Microsoft app verification**, which take weeks. Everything they
  check is ready.
* **One password is shared** between the database user, the admin login and the
  mail accounts, at the owner's instruction. The value is in `.env` on the
  server and in `.env.claude-tools`, never in this repository. The database password can be
  rotated to a random value in `.env` with no user-visible change, and should be
  before third-party developers arrive.
* **One box, every login.** JWKS caching, 30-day refresh tokens and short access
  tokens soften an outage; an off-box uptime probe and a tested restore do not
  exist yet.

---

## 8. If you change one thing, know this

The riskiest surface is not the cryptography — that is standard and tested. It
is **the moment an identifier is matched to a person**. Read
`src/identity.js` and `src/normalise.js` before touching anything that decides
who somebody is, and keep these three:

1. **A matching email never silently links an account.** An attacker registers
   your address, never verifies it, and waits for you to arrive via Google.
2. **Unlinking the last way in is refused.** An account nobody can reach is a
   permanent support ticket and a takeover route.
3. **The uniqueness rule is an index, not a query.** A `SELECT` then an `INSERT`
   lets two people registering in the same second both succeed.
