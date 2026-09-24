# Vesopa OAuth — the plan of record

**auth.vesopa.com** — one account for every Vesopa product.

This is the single document that governs the build. It is Kimi K3's four-part
specification (in `plan/`) reconciled against the live server, the owner's
decisions, and four places where I deliberately did something else. Where this
document and `plan/kimi-*.md` disagree, **this document wins**; the Kimi files
are kept unedited as the reasoning behind it.

Status keys: ✅ done and proven on the live server · 🔨 in progress · ⬜ not started

---

## 1. What this replaces

Every login at Vesopa, eventually:

| Product | Today | Becomes |
|---|---|---|
| QR dine-in menu (`menu.vesopa.com`) | Phone/email one-time codes, its own tables | OIDC client — **migrates first** |
| EPOS back office | Express sessions, own password hashes | OIDC client |
| Hosting control panel (`cloud.vesopa.com`) | Own customer accounts | OIDC client |
| EPOS till (Windows/Electron) | Local staff PINs | OIDC public client, loopback redirect |
| Future third-party apps | — | Self-service developer portal |

The owner's framing: *"we are going to change the total login flow of Vesopa and
in future the same. So cannot make mistakes."* That is why the schema was proven
against the live database before a line of application code was written, and why
the migration plan (§8) never does a big-bang cutover.

---

## 2. Decisions already taken

Taken by the owner, on the record:

| Decision | Answer |
|---|---|
| Company details on policy pages | Company number **17362206**, registered office Baglan, Port Talbot, SA12 7AX, Wales. ICO registration number still outstanding — the one remaining placeholder. |
| One password for three things | Kept for the database user, the admin login and the mail accounts, as asked. The value is in `.env` on the server and in `.env.claude-tools`, never in this repository. Recorded as a known risk in §10. |
| First product to migrate | **QR dine-in menu.** No password hashes to carry across, real users, and a bad day means diners sign in again rather than a venue unable to trade. |
| SMS | **Postcoder now**, behind a provider interface so a second gateway for non-UK numbers slots in without touching the login flow. |
| Admin account | `info@vesopasoftware.com`. |
| Sending address | `no-reply@vesopa.com` — already SPF-verified with Apple for the private relay service. |

Taken by me, on engineering grounds, and each one a deliberate departure from
Kimi's specification:

| # | Kimi said | I did | Why |
|---|---|---|---|
| 1 | Sign with **EdDSA** (Ed25519) | **RS256**, with EdDSA available in the same table | EdDSA is the better algorithm and the worse default. `jsonwebtoken`, still the most-installed JWT library in Node, cannot verify it at all. The stated goal is *simple integration* for third-party developers; an algorithm that makes the most likely library fail on line one is not simple. The `signing_keys.algorithm` column means switching later is a key rotation, not a migration. |
| 2 | Argon2id at **m=64 MiB, t=3, p=4** | **m=19 MiB, t=2, p=1** (OWASP baseline) | This box also runs the hosting control panel, the mail stack and MariaDB. 64 MiB per concurrent login is how an identity provider takes the mail server down. 19 MiB is the documented strong minimum, and it is a number to raise the day this gets its own machine. |
| 3 | TOTP key in **`/etc/vesopa/mfa.key`** | The application's own `.env`, mode 0600 | A file under `/etc` is a change to a shared server outside this domain, and the owner's standing instruction is to ask before making one. The env file is inside the app directory and is already excluded from every deploy path. Worth revisiting with the owner — Kimi's version is genuinely better isolated. |
| 4 | Raw auth events pruned at **90 days** | **13 months**, with daily rollups | The policy pages commit to 13 months for sign-in history, and `/account/history` is the page that makes "was that me?" answerable. Kimi's real point — that dashboards must read rollups and never `GROUP BY` raw events — is adopted in full; it is the retention figure I changed, not the architecture. |
| 5 | `slot = IF(revoked_at IS NULL, 0, id)` | `active_flag = IF(revoked_at IS NULL, 1, NULL)` | Kimi's version makes a STORED generated column depend on the AUTO_INCREMENT primary key, which is not reliably available when the row is written. Mine relies on MySQL treating each NULL in a unique index as distinct. It is tested against the live MariaDB — see §4. |

---

## 3. The server (Phase 0) — ✅ complete

`auth.vesopa.com` → **34.63.118.67**, the Hestia box that also serves
cloud.vesopa.com. Everything below is provisioned and idempotent
(`scripts/provision-server.sh`, re-runnable).

| Thing | Value |
|---|---|
| App directory | `/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp` |
| Port | `20003` (20001 and 20002 were taken) |
| nginx | Hestia **proxy** template `NodeJS`, empty extension list so every path reaches Node |
| TLS | Let's Encrypt, already issued |
| Database | `vesopasoftware_authdb`, user `vesopasoftware_authuser`, `utf8mb4_general_ci` |
| Node / MariaDB | v24.20.0 / 11.8.9 |
| Mail | `no-reply@vesopa.com`, `account@vesopa.com`, `info@vesopasoftware.com` |
| pm2 | Runs as the `vesopasoftware` Hestia user — **never as root**, or a second daemon fights for the port |

Two traps recorded so nobody pays for them twice:

* It is the **proxy** template that must become `NodeJS`, not the web template.
  `v-change-web-domain-tpl` answers *"NodeJS web template doesn't exist"*, which
  reads like a missing file and is a wrong command.
* `v-add-nodejs-app` regenerates `.env` with a two-line stub. Nothing in this
  repo calls it, and nothing ever should.

---

## 4. The identity model — ✅ built and proven

Full schema in `schema/schema.sql` and `schema/schema_002_runtime.sql`. 36 tables.
Both files are idempotent; `scripts/reset-database.sh` rebuilds from scratch and
refuses to run once real users exist.

**The shape.** A person is a `users` row, for ever. Everything they can prove
they *own* — an address, a number, a Google account — is a `user_identities`
row. Everything they can prove they *know or hold* — a password, a TOTP seed, a
passkey — is a credential row. Identifiers and credentials are different things,
and merging them is why so many systems cannot answer *"sign in with Google,
then let me add a password later"*.

**The uniqueness rule the owner asked for** — *one Gmail to one account while
active; revoke it and it is free again; never lose the history* — is a database
constraint, not application code:

```sql
active_flag TINYINT(1) GENERATED ALWAYS AS (IF(revoked_at IS NULL, 1, NULL)) STORED,
UNIQUE KEY uq_identity_active (type, identifier_norm, active_flag)
```

MySQL has no partial indexes, but it treats every NULL in a unique index as
distinct — so any number of revoked rows may share an address and exactly one
live row may. This matters because the alternative, a SELECT then an INSERT in
application code, lets two people registering the same address in the same
second both see "free". Proven on the live database by
`schema/verify-uniqueness.sql`, all six checks passing:

| Check | Result |
|---|---|
| Second live claim on one address | refused (1062) |
| Re-claim after revocation | accepted |
| History retained (2 rows, 1 live) | pass |
| Many revoked rows coexisting | pass |
| Same string under another provider | accepted — independent identifier |

**`identifier_norm` is `utf8mb4_bin`, and that is load-bearing.** A provider's
subject id is an opaque case-**sensitive** string; GitHub node ids and Microsoft
object ids both mix case. Under the house-default `general_ci`, `AbC` and `abc`
compare equal, so two different people's provider accounts collide on that unique
index and the second one to sign in is refused — or handed the first one's
account. Case-folding is `src/normalise.js`'s job, at write time, and must never
be delegated to a collation that also folds things we need kept apart.

**Normalisation rules** (`src/normalise.js`, 21 tests passing):

* Email lower-cased whole. For **gmail.com only**, dots stripped and `+tag`
  removed, because Google says those are one mailbox and not doing it lets one
  person mint unlimited accounts. Applying that rule anywhere else is a far worse
  bug in the other direction — it welds `j.smith@` and `jsmith@`, two different
  colleagues, into one account.
* Phone to E.164. Whether we can *text* it is the sending layer's business, not
  the database's.
* Provider subjects byte-for-byte, untouched.
* Apple private relay addresses are flagged, never matched against a real
  address, and may never be an account's only way back in — the person can switch
  the relay off and it stops existing.

**Account takeover, closed.** Google's email matching an existing password
account does **not** auto-link. The attack it prevents: an attacker registers
`victim@gmail.com` with a password and never verifies it; weeks later the victim
signs in with Google; a silent link welds the victim's Google identity onto the
attacker's account and the attacker's password now opens it. The shipped rule is
an interrupt — *"You already have an account, sign in to link it"* — requiring one
successful authentication against the **existing** account first.

**Unlinking the last way in is refused.** An account nobody can sign into is a
permanent support ticket and a takeover vector.

---

## 5. Protocol

OAuth 2.1 + OIDC. Authorisation code + PKCE for everything interactive,
client_credentials for machines, **nothing else** — no implicit, no password
grant, no device code.

| Client | Grant | PKCE | Secret | Redirect rule |
|---|---|---|---|---|
| Electron till | code | S256 | none | loopback `http://127.0.0.1:*/callback` |
| QR menu | code | S256 | none | exact HTTPS string |
| Back office | code | S256 | yes, hashed | exact HTTPS string |
| Hosting panel | code | S256 | yes, hashed | exact HTTPS string |
| Machine-to-machine | client_credentials | — | yes | none |

Exact-string redirect matching, no wildcards, with one narrow exception for the
loopback port on native clients. Every open-redirect hole in an OAuth server has
started with somebody being helpful about matching.

**Tokens.** Access and ID tokens are RS256 JWTs, 10 minutes. Refresh tokens are
opaque 256-bit values stored as SHA-256, 30 days, rotated on every use. Reuse
detection: `used_at` is the lock, redemption is one conditional `UPDATE … WHERE
used_at IS NULL`, and a second presentation revokes the whole family — *except*
from the same device and IP inside a short grace window, which returns the
successor instead. Without that exception a till on bad wifi retries `/token`,
trips the alarm, and the pub loses its till mid-service.

**Sessions.** `__Host-` prefixed, Secure, HttpOnly, SameSite=Lax, opaque, server-
side. Two clocks: idle and absolute. "Remember me on this device" makes the
session persistent and lets that device skip the *second* factor — never the
first. A remembered device proves which machine this is, not who is holding it;
anything else turns a stolen laptop into a permanent key to every Vesopa app.

**Isolation vs sharing.** One global pool of people; per-application membership
controls visibility. A person who already has a Vesopa account does not make a
second one for another Vesopa app — that is the entire point. Third-party apps
get a **pairwise** `sub` derived from (person, app) so two unrelated developers
cannot compare user lists; Vesopa's own products get a `public` one because the
till and the back office must agree who a staff member is. Sharing between two
apps of the same organisation is a `data_share_group`, consented to by name on
the consent screen, and carried out server-side against the internal id — never
by handing both apps the same subject.

**The owner's EPOS question, answered.** *One* application called Vesopa EPOS,
with roles `till.operator`, `till.manager`, `menu.viewer`, `backoffice.admin` —
not three applications. Three applications means one human holds three accounts
and the manager who also works the till has to remember which one she used.
Roles keep one person, one account, and let each app ask what it needs to know.
Only role keys travel in a token; permissions are resolved by the app.

---

## 6. Multi-factor

Owner's requirement: authenticator app, mobile number, and passkeys.

**Passkeys.** `@simplewebauthn/server`. The decision that mattered most:
**RP ID is the apex `vesopa.com`, not `auth.vesopa.com`.** Apex-scoped
credentials work on every current and future subdomain; `auth.`-scoped ones would
be orphaned on `menu.` and `cloud.` for ever, and that is not fixable afterwards
— every user would have to re-enrol. Only auth.vesopa.com runs the ceremonies.
Passkeys are a first factor (passwordless), `userVerification: required`,
`attestation: none`, discoverable credentials with conditional UI so the
email-first form still offers them. Sign counts are recorded but a synced passkey
legitimately reports zero for ever, so a non-increasing counter is an alert and
never a lockout.

*The reference implementation in `TrackerApp/web` is not a model for this.* Its
`LockSetup.tsx` sends a hard-coded challenge and stores a `localStorage` flag —
a screen lock, not authentication, and bypassable by anyone who can write
localStorage. The UI pattern is worth borrowing; the ceremony must be real.

**TOTP.** Written out rather than pulled in, and checked against RFC 6238's own
published test vectors (`test/crypto.test.js`) — an authenticator with no test
vectors is a guess that fails on somebody else's phone. Secret encrypted at rest
with AES-256-GCM. The spent step is recorded, so a code read over a shoulder does
not work again for the rest of its window.

**SMS.** The weakest factor here — SIM swap, number recycling, phishable — and
shipped because the owner asked and because it beats password-only. Fenced: never
the sole recovery path, and a number that is already a primary sign-in factor
cannot also be the second factor for it.

**Step-up without logout.** Sessions record `amr` and `acr`. An application can
demand more than the session carries, and the missing factor alone is challenged.
Without those two columns, "this action needs a second factor" can only be
implemented by logging everybody out, which is how people learn to hate a
security feature.

---

## 7. Build order

**Phase 0 — the server** ✅
- [x] DNS, Hestia domain, TLS, nginx proxy template, port 20003
- [x] Database, user, utf8mb4, mail accounts
- [x] Idempotent provisioning script

**Phase 1 — foundations** ✅ *proven end to end on the live domain*
- [x] Schema, three files, idempotent, 36 tables
- [x] Uniqueness rule proven on the live database
- [x] `normalise.js` — email/phone/subject, 21 tests green on the server
- [x] `crypto.js` — ids, token hashing, peppered code hashing, argon2id, AES-GCM, pairwise subjects, TOTP against the RFC vectors
- [x] `config.js` / `db.js` / `server.js` — fail-fast boot, pool, health, security headers, CSP
- [x] Login page: one form, email-first with phone toggle, the link that flips Log in ⇄ Register
- [x] Email code flow, live through exim; phone OTP behind the provider interface
- [x] Sessions with two clocks, remember-this-device, device secret rotation with reuse detection
- [x] CSRF on every post, including the login form
- [x] Rate limits: per destination, per IP, per challenge, per password
- [x] `scripts/smoke-login.sh` — 11 checks, signing in for real on https://auth.vesopa.com

**A trap this schema layout sets, recorded because it cost a live 500.**
`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
adding a column to the CREATE statement in `schema.sql` changes nothing on any
database that has been created once — and the deploy reports "ok" for the file.
A new column must go in **both** `schema.sql` (for a fresh database) and a
numbered migration using `vesopa_add_column` (for the ones that exist). That is
what `schema_003_webauthn_columns.sql` is, and why.

**Phase 2 — OIDC provider** ✅ *40 checks passing against the live domain*
- [x] Discovery document at `/.well-known/openid-configuration`
- [x] `/jwks.json` with three-state key rotation (`next` → `active` → `retired`)
- [x] `/oauth/authorize` — PKCE S256 required of every client, exact redirect
      matching, unknown client and unregistered redirect rendered rather than
      redirected
- [x] `/oauth/token` — authorization_code, refresh_token, client_credentials
- [x] `/oauth/userinfo`, `/oauth/revoke`, `/oauth/introspect`, `/oauth/logout`
- [x] Consent screen with per-scope wording; first-party products skip it
- [x] Refresh rotation with reuse detection and the same-device retry grace
- [x] `scripts/seed.js` — organisation, applications, roles, permissions, admin
- [x] `scripts/smoke-oidc.js` — 40 checks including every refusal

**The client ids for the three first-party applications** are printed by
`node scripts/seed.js` and stored in `applications.client_id`. Secrets are not
created by the seed: they are minted in the developer portal so the plaintext is
shown once and never stored.

**Two bugs this phase's tests caught, both worth remembering.**
`/jwks.json` answered `{"keys":[]}` on a fresh install, because keys were created
lazily by the first signature — so the first client library to boot would have
cached an empty key set and rejected every token, while the server looked
healthy. And a replayed authorisation code revoked every refresh token the
person held for that application, which would have signed somebody out on their
phone because a code was replayed against their laptop; it is now scoped to the
session the code belonged to.

**Phase 3 — social and MFA** 🔨
- [x] Provider layer for Google, Apple, Microsoft and GitHub, with each
      provider's ID token verified properly against its published keys —
      signature, issuer, audience and the nonce we sent
- [x] State kept in the database, not a cookie, so Apple's cross-site form POST
      works (a `SameSite=Lax` cookie is not sent on one — this is why Apple
      breaks on implementations that work for everybody else)
- [x] Account-linking interrupt: a matching email never auto-links
- [x] `scripts/smoke-social.js` — 36 checks, including asking Google and
      Microsoft directly whether we are registered
- [x] **Google is live** — credentials present, redirect URI registered
- [x] **Apple is live** — the client secret is a JWT minted per request from the
      .p8, so it can never be the stale credential that breaks sign-in one
      morning
- [x] **Microsoft is built and verified as far as it can be without a secret.**
      Microsoft confirms the application is registered and
      `https://auth.vesopa.com/auth/microsoft/callback` is accepted; it hands
      off to login.live.com carrying our client id and redirect URI, with no
      AADSTS error. Only `MICROSOFT_CLIENT_SECRET` is missing.
- [x] GitHub is built; only `GITHUB_CLIENT_SECRET` is missing
- [x] **Microsoft is live.** The `VesopaComMicrosoftSecret` for app
      `335a71ee…` was supplied and verified against Microsoft directly: a
      client-credentials request returns a token, which proves the secret is
      right and belongs to this application. (The EPOS secret for
      `6ef0452e…` is deliberately unused — see below.)
- [x] TOTP enrolment, QR rendered server-side into a data: URI so the secret
      never reaches a third-party chart service, and ten single-use recovery
      codes shown once
- [x] Passkeys — registration and authentication ceremonies, RP ID on the apex,
      `userVerification: required`, discoverable credentials
- [x] The account area: profile with picture, security, linked accounts,
      devices, sign-in history, connected apps, and account deletion
- [x] **Profile pictures** copied from Google and GitHub (from the ID token) and
      from Microsoft (via Graph, `User.Read`). Apple never provides one. The
      image is **copied, not linked** — a remote avatar would tell Google every
      time somebody looks at a Vesopa page, would need `img-src` opened up on
      the sign-in origin, and would 404 the day the person changes their
      picture. Anyone can upload their own instead.
- [x] **The policy pages are served and resolve** at `/privacy`, `/cookies`,
      `/terms`, `/acceptable-use`, `/data-processing`, `/retention`,
      `/security`, `/your-data-rights`, plus `/policies` and the `/gdpr` and
      `/dpa` aliases. They existed only as files before, so every footer link
      and every URL given to an OAuth reviewer was a 404.
- [ ] SMS as a second factor (the primary phone OTP path is done)
- [ ] Step-up: `acr_values` handling at /authorize

**Company details are filled in**: 17362206, Baglan, Port Talbot, SA12 7AX.
**The ICO registration number was removed rather than invented.** The sentences
that carried it now give the ICO complaint route — `ico.org.uk/make-a-complaint`
and 0303 123 1113 — which is the part UK GDPR actually requires of us. The
data-protection fee registration is itself a legal obligation; once Vesopa is
registered, put the number back into `privacy-policy.md` and
`your-data-rights.md`.

**To turn Microsoft on:** Azure Portal → App registrations → **Vesopa**
(`335a71ee-f200-4cb3-9965-dafc3ab0e01b`) → Certificates & secrets → New client
secret. Put it in `.env` as `MICROSOFT_CLIENT_SECRET` and restart. The button
appears by itself — the login page only shows providers whose credentials are
present, so nothing else has to change. **To turn GitHub on:** the same, from
the GitHub App's settings, into `GITHUB_CLIENT_SECRET`.

**Note the app id.** `.env.claude-tools` carries a Microsoft secret for
`6ef0452e-04ea-4f22-b580-6a93534978f6`, which is **VesopaEPOS**, the Store
submission app — a different registration with different redirect URIs. It is
deliberately not used here: reusing a Store-submission credential for customer
sign-in would put one secret in two unrelated places.

**Phase 4 — developer portal** ✅ *45 checks passing against the live domain*
- [x] `/developers` — the applications a person may reach, and nothing else
- [x] Create an application: name, where the code runs, one redirect URI
- [x] Redirect URIs, with every refusal explained on the page: `http://`, a
      wildcard, a `#fragment`, `localhost` rather than `127.0.0.1`, a loopback
      address on a web client — and removing the LAST one, which would break
      every sign-in silently
- [x] Client secrets: several live at once so rotation is not an outage, shown
      once and never stored, listed by their last four characters
- [x] **A public client is refused a secret**, and told why. PKCE instead.
- [x] `client_credentials` — the API-key equivalent — with the curl to use it
- [x] Scopes, showing the developer the exact sentence the person will read
- [x] Roles, and what travels in the token
- [x] Who uses it, bounded and scoped to that application alone
- [x] **Access granted per application**, not only per organisation
      (`application_developers`), with `viewer` unable to mint a credential
- [x] An application logo — PNG/JPEG/WebP only, sniffed rather than trusted.
      **SVG is refused**: it is a document that can carry script and would be
      served from the origin that holds every Vesopa session.
- [x] Archiving rather than deletion, behind typing the name
- [ ] Webhooks — the one part of this phase not built

**Phase 5 — admin and analytics** ✅ *the console; user management is partial*
- [x] `/admin` on a rail, laid out like the account area so nobody learns a
      second console
- [x] **Figures from daily rollups** (`login_event_daily`, `signup_daily`),
      never a `GROUP BY` over raw events — that is how the dashboard becomes the
      outage
- [x] The number that matters: how many people hold a passkey or an
      authenticator, and can therefore survive their mailbox being read
- [x] `/admin/people` — search by address, number, name or id, and it opens
      EMPTY: a console that lists every account turns a curious afternoon into a
      browse of the customer list
- [x] `/admin/people/:id` — read-only, and looking is itself audited and visible
      to the person in their own history
- [x] Suspend, restore, grant staff and developer access — and never to yourself
- [x] `/admin/applications`, `/admin/activity`, `/admin/health`
- [x] Impersonation **refused**, as promised
- [ ] Invitations, and helping somebody who has lost their authenticator

**Phase 6 — migrate the products** 🔨
Order: QR menu → back office → hosting panel → till.

**Groundwork for the menu, done first and deliberately.** menu.vesopaepos
serves diners who never sign in: guest ordering is the default, it is
preselected, and every part of that page works without an account. The failure
mode when an identity provider is added to a product like that is quiet — the
sign-in becomes load-bearing by accident, and a diner at a table with food
coming is asked to register before they can read a menu. Nobody catches it in
testing, because everybody testing it has an account. So:

- [x] `applications.guest_allowed`, recorded on the Vesopa Menu application and
      shown in the portal, so the intention is where the next person will read it
- [x] The consent screen tells the diner, in as many words, that they can carry
      on as a guest — the sentence that stops an abandoned basket
- [x] Three scopes for what the menu actually does: `orders.read`,
      `orders.write`, and **`orders.claim`** — attaching the orders somebody
      placed as a guest on this phone before they signed in. Without it,
      signing in loses the meal they are in the middle of, which is the worst
      possible moment to ask anybody to register.
- [ ] The menu itself, as an OIDC client, behind `AUTH_PROVIDER`

---

## 8. How a migration is done safely

The rules, which are not negotiable:

1. **The identity provider never writes to a product's database.**
2. **Legacy login ships dormant, behind a flag.** Rollback is flipping
   `AUTH_PROVIDER` back and redeploying; passwords are still intact.
3. **No bulk password reset, ever.** Existing hashes are imported with an
   algorithm tag and verified with the legacy algorithm at first sign-in, then
   transparently rehashed to argon2id.
4. **Sessions are not ported.** One clean re-login beats importing an insecure
   session format.
5. **Dual-auth during the soak.** Each app accepts its old session *or* an
   identity-provider token until the old sessions expire naturally.
6. 90-day soak before legacy code and columns are removed, announced 30 days out.

---

## 9. What must be proven on the live domain before anything is replaced

Every sign-in method end to end on Chrome, Firefox, Safari, iOS and Android ·
every failure mode showing the right message and writing the right event ·
code + PKCE happy path, and `state`/`nonce`/redirect mismatches all rejected ·
refresh rotation, and reuse killing the family · ID token verifying against JWKS
across a key rotation · consent, deny, and revoke ending tokens · session cookie
rotating at login and at step-up · brute force throttled and alerting ·
mail scoring 9+/10 on SPF/DKIM/DMARC and arriving at Gmail and Outlook in under a
minute · SSL Labs A+ · `noindex` on `/login` and absent on `/` · accessibility
clean on the login page · a backup restored to a scratch database.

---

## 10. Known risks

* **One box, every login.** When it is down, nothing at Vesopa can sign in.
  Mitigations for week one: JWKS cached by every client with `stale-if-error`,
  30-day refresh tokens so tills survive an outage, the back office keeping its
  own short session, an off-box uptime probe, and off-site backups with a restore
  that has actually been run.
* **One password is shared** between the database user, the admin login and the
  mail accounts, at the owner's instruction. One leak is three doors. The value
  lives in `.env` on the server and in `.env.claude-tools`, and is deliberately
  not written in this repository — a document in git is copied and pushed far
  more casually than a password manager, and git history is for ever. The
  database password can be rotated to a random value in `.env` at any time with
  no user-visible change, and should be before third-party developers arrive.
* ~~**Google and Microsoft verification take weeks.**~~ **Google is in
  production** — the OAuth client is published, not in testing, so there is no
  "unverified app" warning and no hundred-user test cap. What remains is
  **Microsoft's** verified-publisher status, which still shows "unverified" on
  its consent screen until Partner Center approves it.
* **ICO registration number is still missing** — the only outstanding placeholder
  in the policy pages, and the data-protection fee registration is itself a legal
  requirement.
* **Tenancy in the wider codebase is half-finished.** Vesopa grew out of a
  single-tenant database and scoping is missing in places. This schema carries
  `application_id` from row one, but every query written against it still has to
  filter on membership — it is a code-review checklist item, not something the
  schema can enforce alone.

---

## 11. Where everything is

```
vesopa_auth/
  OAuthTasksWithProperStructureInfo.md   this document
  plan/          Kimi K3's four specifications, unedited, plus the prompts
  schema/        schema.sql, schema_002_runtime.sql, verify-uniqueness.sql
  scripts/       provision-server.sh, reset-database.sh
  src/           the application
  test/          node --test
  content/       policy pages
  public/brand/  icons, manifest, social cards
```

Reaching the server from this Windows machine: `python tool/auth_ssh.py run|put|get`.
The repo's other SSH helper points at a **different** box and will cheerfully run
your command on the wrong server.
