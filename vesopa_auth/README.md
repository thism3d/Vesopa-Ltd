# Vesopa OAuth — `auth.vesopa.com`

The identity provider that is replacing every login across Vesopa Ltd: the EPOS
till, the QR dine-in menu, the back office, the hosting control panel, and
whatever is built next.

**It is live and working.** 465 automated checks pass against the real domain —
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
python tool/auth_ssh.py run "cd @app && node --test test/*.test.js"        # 138
python tool/auth_ssh.py run "cd @app && bash scripts/smoke-login.sh"       #  28
python tool/auth_ssh.py run "cd @app && node scripts/smoke-oidc.js"        #  41
python tool/auth_ssh.py run "cd @app && node scripts/smoke-social.js"      #  40
python tool/auth_ssh.py run "cd @app && node scripts/smoke-portal.js"      #  55
python tool/auth_ssh.py run "cd @app && node scripts/smoke-password.js"    #  21
python tool/auth_ssh.py run "cd @app && node scripts/smoke-mfa.js"         #  29
python tool/auth_ssh.py run "cd @app && node scripts/smoke-webhooks.js"    #  32
python tool/auth_ssh.py run "cd @app && node scripts/smoke-phase5.js"      #  33
python tool/auth_ssh.py run "cd @app && node scripts/smoke-device-flow.js" #  23
python tool/auth_ssh.py run "cd @app && node scripts/smoke-till-sso.js"    #  34
python tool/auth_ssh.py run "cd @app && node scripts/smoke-backoffice-sso.js" # 18
python tool/auth_ssh.py run "cd @app && node scripts/smoke-panel-sso.js"   #  17

python tool/auth_nav_test.py                                              #  15
python tool/auth_loadbar_test.py                                          #  11
python tool/auth_width_test.py 360                                        #  21
```

What each one is for, where it is not obvious:

* **`smoke-password.js`** — the identifier goes in and a PASSWORD page comes
  back, not an emailed code; the password signs the person in; the way out from
  under it still sends a code; and an application whose policy says otherwise
  gets otherwise. A wrong password must not reveal whether the account exists.
* **`smoke-portal.js`** — creates an application through the web interface,
  registers redirect URIs, mints a secret and **uses it against `/oauth/token`**.
  Its refusals are the product: `http://`, wildcards, `#fragment`, `localhost`,
  removing the last redirect URI, a browser app asking for a secret, an SVG
  logo, and switching every sign-in method off.
* **`smoke-device-flow.js`** — the desktop round trip: browser out, consent,
  the hand-off page, the app exchanging the code with PKCE and NO secret, and
  then revoking the link and proving the app can reconnect. A code presented
  with the WRONG verifier is refused, which is what makes a custom scheme safe.
* **`tool/auth_width_test.py`** — no page is wider than the phone it is on. A
  grid item's default `min-width: auto` is why this keeps happening, and it is
  invisible on a laptop, so it ships.
* **`tool/auth_loadbar_test.py`** — the progress bar appears on a routed link,
  on a form submit, and on the hand-off to a provider. The last is the longest
  wait on the site and the one the router never sees.
* **`scripts/lib/consent.js`** — not a test; the shared "answer the consent
  screen" step. Four suites drive `/oauth/authorize`, consent now applies to
  first-party applications too, and without this each of them rediscovers the
  same two details separately. It has the details written down.

## 4. What is done

### Working, proven on the live domain

**The sign-in itself**

* **Identifier first, then a password, with a way out.** One field; the server
  finds the person and then shows the password step — small mark top-left,
  "Hi &lt;name&gt;", an account chip saying WHICH account is about to be signed
  in, one field, and **"Email me a code instead"** underneath. The phrasing
  avoids "OTP" deliberately: it is jargon a diner has never met.
* **What an application asks for first is a setting.** `password_first`,
  `code_first` or `provider_only`, defaulting from `/admin/settings` and
  overridable per application. It decides what LEADS, never what is possible —
  and is ignored for somebody with no password, because an empty password box
  is a question with no answer.
* **Which ways in an application offers is a table of rows**
  (`application_auth_methods`), not a column each: password, email code, text
  code, passkey, Google, Microsoft, Apple, GitHub — and whatever comes next,
  which is one entry in `src/authmethods.js` and no migration.
* **reCAPTCHA v3, which never locks anybody out.** A low score does not refuse;
  it drops the password fast path and asks for an emailed code. A **missing**
  token is treated as no evidence at all and changes nothing — it used to
  degrade, and the day the keys were configured that quietly took the password
  step away from everybody whose browser blocks google.com. Only a token Google
  rejects, or one minted for a different action, is refused; if Google does not
  answer in four seconds it fails **open**.
* **One address, one account.** An address a provider has verified is matched
  against an address typed on the sign-in page, in both directions — so signing
  in with GitHub and later typing the same address reaches the same account
  rather than making a second one. Both sides are proofs of the same fact: the
  provider verified the mailbox and so did we.
* **Email codes and phone codes**, social sign-in with **Google, Apple,
  Microsoft and GitHub**, **passkeys**, **TOTP** with recovery codes, and
  step-up authentication.

**The account area** — rebuilt to `reference_design/VesopaOauthReference.md`

* **A hub at `/account`**: an identity card whose avatar carries a badge and IS
  the control, then rows in colour-grouped clusters. No tab strip on a phone —
  that strip was slicing "How you s…" in half at 360px.
* **Subscriptions and a wallet**, on the reference's model: grouped by state,
  product tile, product name as a link, plan, status line. **Cards are recorded
  and never charged** — there is no card number in the schema and no code path
  to money.
* **Nothing is wider than the viewport.** The profile picture control was the
  cause (min-content 357px on a 360px screen) and is now the avatar itself.
* **Devices and sign-in history say WHERE**, not just which four numbers — the
  country is looked up server-side (`src/geo.js`, ported from
  `vesopa_hosting`), cached three deep, and each row carries a mark for the
  KIND of machine. `scripts/backfill-countries.js` fills in rows written before
  the lookup existed.
* **"Getting back in" is its own panel**, with an Email/Phone toggle like the
  sign-in page. Changing a recovery address asks for the password, the
  authenticator, or a code to the ORDINARY address first — never to the
  recovery one, which would be a circle with nobody outside it. See
  `src/reauth.js`.
* **The picture upload works.** It did not: the template said the form
  "submits itself when a file is chosen" and the script that would have done
  that was never written, so choosing a picture did nothing at all.

**Consent, and who is allowed in**

* **The consent screen fits one phone screen.** Who is about to be signed in,
  what is asking, the permission list COLLAPSED behind a tap, then Allow and
  Not now. The account chip at the top is a control — pressing it signs out and
  comes back to the same authorisation as somebody else.
* **An administrator of the application is warned.** Consent granted by the
  person who administers the app is not a customer's consent; the screen says
  so and makes switching the primary action.
* **Anybody may hold a Vesopa account; no application has to take everybody.**
  `applications.allow_self_enroll` decides, per application: the QR menu enrols
  whoever scans a table, the back office and the till do not.
* **Being turned away is a page, not a bounce.** It used to redirect to the
  application with `error=access_denied`, which arrived as "we could not finish
  signing you in" — indistinguishable from a fault. It now says, on this
  domain, that the account is fine and simply is not on the list, shows the
  address to quote, and offers to switch account.
* **Invitations, from two places.** `/developers/a/<id>/people` for somebody
  who builds on Vesopa, and `POST /api/app/invitations` (client credentials,
  confidential clients only) for an application inviting on a manager's behalf
  — which is what the back office's "Invite through Vesopa" uses.

**For developers** — `/developers`

* Create an application, register redirect URIs, mint and revoke secrets,
  choose scopes and roles, upload a logo, see who uses it and who may edit it.
* **How people sign in** — per-application methods, policy, and consent.
* **Access is grantable per application**, not only per organisation.
* **The desktop hand-off** — a page on this domain that says it worked and
  offers to open the app, for the flow people know from VS Code and Google.

**For administrators** — `/admin`

Overview, people search, applications, activity, health, sign-in settings. The
figures come from daily rollups, never a `GROUP BY` over raw events. There is
no way to sign in as somebody, deliberately, and opening an account is audited
where that person can see it.

**In the products**

* **Back office** — Vesopa Auth and nothing else, behind
  `VESOPA_AUTH_BACKOFFICE_ONLY`. Driven end to end in a browser: one button,
  out to auth.vesopa.com, back signed in. Adding a member of staff sends them a
  Vesopa invitation, and with Vesopa-only on it stops asking a manager to
  invent a password for a door that is not there.
* **QR menu** — the mark and "Continue with Vesopa" above "Continue as guest".
  Guest stays the default and stays first-class.
* **Till and kitchen screen** — the device hand-off, with loopback still
  registered so an older build keeps working. Both draw the same button as the
  back office: the Vesopa mark, lime on black, and the words "Continue with
  Vesopa" to the letter.

**The shell**

* **No browser loading bar.** Links already went through the router; forms do
  now too. A redirect from a route that sees `x-vesopa-nav: 1` comes back as
  `204` with the address in `X-Vesopa-Location` instead of a `303` that `fetch`
  would follow silently — so the router always knows where the server sent it,
  and only a hand-off to another origin is a real navigation.
* **No blue box round the heading on iPad.** The router focuses the new page's
  `h1` so a screen reader is told the page changed; Safari drew its focus
  rectangle around it. The announcement stays, the rectangle goes.

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

**A `<img>`'s `width`/`height` attributes beat `aspect-ratio`.** The attributes
should be there — they reserve the space and stop the page jumping — but with a
CSS `width` set and no CSS `height`, the ATTRIBUTE height wins and the ratio
never computes. The hero rendered 460×768 instead of 460×288. `height: auto` is
the fix, and its absence looks exactly like the ratio being ignored.

**Equal specificity means source order decides, and source order moves.** The
back-office wordmark rendered 358px wide on a 414px screen because
`.lockup-light { max-width: 100% }` came later than
`.login-logo { max-width: 148px }`. The served stylesheet said one thing and the
element said another, which is the shape of every specificity bug. Settle it
with a two-class selector, not with where the block sits.

**`\s` inside a JavaScript template literal is not an escape.** It collapses to
a bare `s`, so a regular expression built from one silently matches nothing.
This was got wrong three times in a row in one afternoon, each time presenting
as a CSRF failure rather than as a pattern that never matched. Use a regex
LITERAL, or `indexOf`.

**A disabled checkbox is not submitted.** A setting shown as on-but-locked
therefore vanishes the moment somebody presses Save on that page — a setting
switched off by looking at it. Carry it through in a hidden field.

**A grid item with `margin-inline: auto` is sized to its content.** It does not
stretch, so `max-width` caps nothing and one wide child makes the whole column
wider than its track. `width: 100%` alongside is what makes the cap mean
anything.

**`ratelimit.hit` answers `{ allowed }`, not `{ ok }`.** Checking the wrong
property made every password attempt read as blocked, including the right one.

**Revoking a connected app must not remove the membership.** Consent is "this
application may act for me"; membership is "this person works here". Removing
both meant disconnecting the till locked somebody out permanently, because the
till does not allow self-enrolment. Found by a smoke test on its second run,
which is the only way that kind of bug ever shows up.

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

**1. Rotate the shared password.** It was a plain-text constant in
`vesopasoftware/server/seed.js`, this repository is **public**, and it is in the
git history — which is public too. It is the same string as the auth database
user, the `info@vesopasoftware.com` login and the mail accounts. Nothing in the
code fixes that; only changing the password does.

**2. Set the reCAPTCHA keys.** The code is written and off:
`RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY` in `.env`, with
`RECAPTCHA_THRESHOLD` defaulting to 0.5. Nothing on the page changes until both
are present.

**3. The Microsoft platform, if it moves again.** The callback must be
registered under **Web**, not "Single-page application" — an SPA registration
makes the whole client public and its codes redeemable only from a browser,
which a server can never do. `smoke-social.js` now detects it with no user at
all.

**4. Card authorisation.** Deliberately not built: the schema records a brand,
four digits, an expiry and a provider token, and there is no code path to money.
When it is built, it belongs at the gateway.

**5. Migrate the remaining products.** The back office, the till and the menu
are done. The hosting panel has `smoke-panel-sso.js` passing and its own flag.

**6. Outstanding, not code:** the ICO registration number, and Microsoft's
verified-publisher status.

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
