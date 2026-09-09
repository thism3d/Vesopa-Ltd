# Vesopa OAuth — Architecture Specification

Issuer: `https://auth.vesopa.com`. Discovery: `/.well-known/openid-configuration`. JWKS: `/jwks.json`.

## 1. Protocol

OAuth 2.1 + OIDC Core. **Decision: authorisation code + PKCE for everything interactive; client_credentials for machines; nothing else.**

| Grant | Status | Why |
|---|---|---|
| authorization_code | ✅ implement | only safe interactive grant |
| refresh_token | ✅ implement, rotation mandatory | tills and "remember me" need it |
| client_credentials | ✅ implement, M2M only | first-party daemons + partner APIs |
| implicit (`response_type=token`) | ❌ refuse | deprecated in 2.1, leaks tokens via fragments/referers |
| ROPC (password grant) | ❌ refuse | trains clients to collect passwords; breaks MFA |
| device_code | ❌ refuse | till has a full browser + keyboard; input-constrained flow unjustified, adds phishing surface |

Client matrix:

| Client | Grant | PKCE | Secret | Redirect-URI rule |
|---|---|---|---|---|
| Electron till (Windows) | code | S256, mandatory | none (public) | loopback `http://127.0.0.1:*/callback`, port wildcard, exact path, https not required (RFC 8252) |
| QR menu SPA | code | S256, mandatory | none (public) | exact https URI, string equality |
| Back-office Express | code | S256, mandatory | yes (confidential, stored hashed) | exact https URI |
| Mobile (later) | code | S256, mandatory | none (public) | claimed https scheme (App/Universal Links) via system browser; no custom schemes |
| Machine-to-machine | client_credentials | n/a | yes | no redirect URI registered |

**Electron: loopback redirect.** The till runs a full Chromium shell — it opens the system browser at `/authorize` and listens on `127.0.0.1` ephemeral port; the code never leaves the device and PKCE binds it. Custom schemes are registry-hijackable on Windows; device code solves a problem (no keyboard/browser) this hardware doesn't have.

## 2. Tokens

**Access tokens: signed JWT.** All resource servers are ours → zero-latency local verify; JWKS lets future third parties verify without calling home — the introspection dependency is what you don't want them to have. Ship RFC 7662 introspection anyway for revocation-sensitive endpoints. **Refresh tokens: opaque 256-bit random, stored SHA-256-hashed.**

| Token | Lifetime | Notes |
|---|---|---|
| Access (JWT) | 10 min | single audience; `typ: at+jwt` |
| ID token | 10 min | mirror of session at mint time |
| Refresh | 30 d absolute, rotated every use | only with `offline_access` scope |

`refresh_tokens` columns:

```sql
id, family_id, user_id, client_id, device_id NULL, scope JSON,
token_hash CHAR(64), issued_at, expires_at, used_at NULL,
rotated_to NULL, revoked_at NULL, revoke_reason NULL, ip, ua
```

**Reuse rule:** lookup by hash; row with `used_at NOT NULL` or `revoked_at NOT NULL` presented again → replay → `UPDATE refresh_tokens SET revoked_at=NOW(), revoke_reason='reuse' WHERE family_id=?`, kill SSO sessions for that family, alert user. Rotation write is one atomic `UPDATE ... SET used_at=NOW(), rotated_to=? WHERE id=? AND used_at IS NULL`; a 0-row result within 10 s from same `device_id`+`ip` is treated as a network retry and returns the successor, not a revocation.

**Signing: EdDSA (Ed25519).** Smaller keys/signatures, fast verify on tills, deterministic — no RSA padding oracles. `kid` = `ed-YYYYMM`; rotate every 90 d; JWKS serves current + all unexpired keys (retire when `now > key_retired_at + max_token_life`); sign only with newest; verify against anything in JWKS. Add RS256 as second alg only when a third-party client library forces it.

## 3. SSO session

Session is server-side; cookie carries an opaque 256-bit id, never a JWT.

| Cookie | Flags | Lifetime |
|---|---|---|
| `__Host-vesopa_sid` | Secure, HttpOnly, SameSite=Lax, Path=/, no Domain | unticked: browser-session cookie, 12 h absolute; ticked: persistent 30 d sliding, 30 d absolute |
| `__Host-vesopa_dev` | Secure, HttpOnly, SameSite=Lax, Path=/ | 30 d, only set when "remember me" ticked |

**Device binding** (`devices` table): `id, user_id, label, secret_hash, created_at, last_seen_at, expires_at, revoked_at, last_ip`. The device cookie holds `id.secret`; every session row stores `device_id`. The secret **rotates on every use** (same reuse-detection rule as refresh tokens — presented stale hash → revoke device + all its sessions). The device record is not a credential: it can only extend session persistence and pre-fill the identifier; it carries no roles, mints no tokens alone, and any sensitive action (password change, new MFA, payout screens) requires fresh auth regardless. **Invalidated by:** user revokes it on the devices page, password change, 30 d idle, secret-reuse anomaly, admin action.

**Logout, three scopes:**
- **Local:** RP deletes its own cookie; SSO untouched.
- **Single-app:** `POST /oauth/revoke` for that client's refresh family (or portal "disconnect"); RP session dies within 10 min at next refresh.
- **Global:** OIDC RP-initiated logout — `GET /session/end?id_token_hint=…&post_logout_redirect_uri=…` (exact-match check); kills SSO session, all refresh families for that `sid`, revokes device only if user asks.

**Back-channel logout: stubbed, not shipped.** All tokens carry `sid` from day one and the event format is frozen; four of five RPs are ours and the 10-min access-token ceiling caps exposure. Front-channel logout: never.

## 4. Isolation vs sharing

**Decision: one global identity pool + per-application membership and consent.** SSO across Vesopa apps is the product; per-app pools force account-linking later, which is the expensive direction to reverse.

**Cost:** emails are globally unique → account-existence probing (mitigate: identical responses/timing, membership only after email verification); isolation is enforced by application code, not schema → every user-scoped query must filter on membership (code-review checklist item).

"Each application has its own users" = rows in `app_memberships`; authorizing a client where the user has no membership (and the app doesn't allow self-enrol) fails with `access_denied`.

**Sharing:** a developer creates a `data_share_group` inside their developer account and attaches ≥2 of *their own* apps. The consent screen names the group: *"Vesopa EPOS and Vesopa Back Office share your profile and email."* Consent is recorded with `share_group_id`; revoking it in the portal stops shared claims at next token issue. **Correlation defence:** `sub` is pairwise per client (HMAC of `user_id + client_id + sector_salt`); sharing happens server-side via `user_id` and never via a shared `sub`.

```sql
users(id, email UNIQUE, email_verified, password_hash, display_name, status, created_at)
developer_accounts(id, owner_user_id, name)
applications(id, developer_id, client_id, client_type, redirect_uris JSON,
             allow_self_enroll BOOL, sector_salt, min_acr DEFAULT 'aal1')
app_memberships(user_id, application_id, status, created_at, PK(user_id, application_id))
data_share_groups(id, developer_id, name)
data_share_group_apps(group_id, application_id)
consent_grants(id, user_id, application_id, scopes JSON, share_group_id NULL,
               granted_at, revoked_at)
```

## 5. Roles, scopes, permissions

Two orthogonal axes: **scope = what the client may do** (granted by user consent, lives in `scope`); **role = what the user may do inside one app** (granted by the app owner, no user consent, scoped to that app only).

```sql
roles(id, application_id, key, description)            -- key e.g. 'till.operator'
permissions(id, application_id, key)                   -- e.g. 'epos.refund'
role_permissions(role_id, permission_id)
user_roles(user_id, application_id, role_id, granted_by, granted_at)
scope_acr(scope, min_acr)                              -- see §7
```

**Token rule:** the `roles` claim contains only roles of the *requesting* client for that user, and appears only in access tokens minted for that client's audience — never in ID tokens, never other apps' roles. Resource servers map role→permission from a cached per-app pull; userinfo exposes no roles. Caps: 25 roles/user/app, key ≤ 32 chars.

**EPOS concretely:** one Application `Vesopa EPOS` defines `till.operator`, `till.manager`, `menu.viewer`, `backoffice.admin`. Alice gets `user_roles(alice, EPOS, till.operator)`. The till client requests `openid roles epos.tx` → access token: `{"roles":["till.operator"], "scope":"openid roles epos.tx", "aud":"epos-api"}`. Refund endpoint requires permission `epos.refund` (mapped to `till.manager`) → Alice gets 403. Same human, QR-menu client → token carries `["menu.viewer"]`. One identity, per-client role projection. Role changes propagate in ≤ 10 min (access-token lifetime); endpoints that can't wait call introspection.

## 6. Day-one security controls, ranked

1. **PKCE S256 for every client**, confidential included; `plain` rejected.
2. **`state` ≥128-bit, one-time, bound to the RP's own session; `nonce` echoed in ID token.**
3. **Exact-string redirect matching**, no wildcards except loopback port; https-only elsewhere.
4. **CSRF synchronizer tokens on every POST — including login and consent.** *Skipped everywhere:* login CSRF and consent CSRF are real attacks; SameSite=Lax is defence-in-depth, not the control.
5. **Passwords: argon2id, m=64 MiB, t=3, p=4, + 128-bit pepper from env/KMS.** Min 12 chars, no composition rules, breached-password denylist via k-anonymity API at register/change.
6. **Brute force / stuffing:** per-account counter (5 fails → 15-min hold), per-IP token bucket, CAPTCHA after 3 fails, rate-limit `/token` and `/introspect` too *(skipped)*, alert on one-password/many-account patterns.
7. **Session fixation:** new `sid` at login, at MFA step-up, at any privilege change; old one destroyed server-side.
8. **Open redirects:** `next`/`return_to` must match `^/[^/\\]` (same-origin relative) else dropped; `post_logout_redirect_uri` exact-match *(skipped)*.
9. **Clickjacking:** `frame-ancestors 'none'` + `X-Frame-Options: DENY` on every auth.vesopa.com response, consent screen included. Electron's BrowserWindow is top-level navigation — unaffected.
10. **Login-page CSP:** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` — no inline JS, plus `nosniff`, `Referrer-Policy: no-referrer`, HSTS after 30-day soak.
11. **Secrets at rest:** client secrets and refresh tokens SHA-256-hashed; TOTP secrets AES-256-GCM, key from env; WebAuthn public keys plaintext (they're public); nothing secret in logs; MySQL volume encrypted.
12. **Audit log, append-only, shipped off-box weekly (single server!):** event, actor, subject, client_id, ip, ua, result, timestamp — covering auth success/fail, token issue/rotate/revoke, consent grant/revoke, role grant, device add/revoke, admin actions. This is what powers the user's "login history with IP" page.
13. **Rate-limit MUSTs:** `POST /login`, `/token`, `/register`, `/password/reset`, `/totp/verify` (hard cap 5/code), WebAuthn assertion, `/introspect`.
14. **Enumeration:** identical response and timing for unknown-email vs wrong-password *(skipped)*.
15. **Audience restriction:** one `aud` per access token + `typ: at+jwt` header, so a token for one resource server can't be replayed at another *(skipped)*.

## 7. MFA in the token

Session row stores `amr JSON, acr, auth_time`; every ID/access token mirrors these at mint.

| Level | `acr` | `amr` examples |
|---|---|---|
| password only | `aal1` | `["pwd"]` |
| password + TOTP / SMS, or passkey | `aal2` | `["pwd","otp"]`, `["pwd","sms"]`, `["webauthn"]` |
| reserved: hardware-bound phishing-resistant | `aal3` | future passkey attestation policy |

**Declaring a requirement:** per-app `applications.min_acr`, overridable per scope via `scope_acr(scope, min_acr)` — e.g. back-office owner sets `min_acr='aal2'`, or the single scope `epos.payouts` demands it.

**Enforcement at authorize:** if `session.acr < required`, run step-up *before* consent, challenging only the missing factor — password is not re-asked while `auth_time` < 5 min, otherwise full re-auth.

**Mid-session step-up, no logout:** resource server returns `401` with `WWW-Authenticate: Bearer error="insufficient_user_authentication", acr_values="aal2"` → RP redirects to `/authorize?acr_values=aal2` (no `prompt`, no `max_age` — those would force full re-auth). Server sees the live session, shows only the TOTP/passkey challenge, upgrades the session row, and mints fresh tokens with new `amr`/`acr`/`auth_time`. SMS is enrolment-gated behind TOTP and never a sole recovery path (SIM-swap).

## 8. When the box is down

1. **JWKS cached by every resource server** (24 h, `stale-if-error`) — existing access tokens verify through an outage; only new logins/refreshes fail.
2. **Tills:** 30-day refresh tokens + offline mode — last userinfo+roles cached encrypted on device, sales queued locally, re-auth on recovery. Passwords never cached.
3. **Back-office:** its own 12 h Express session rides out short outages.
4. **pm2:** `--max-memory-restart 512M`, `pm2 reload` for zero-downtime deploys, systemd unit so the box self-heals on reboot.
5. **MySQL:** nightly dump + binlog shipped off-box (S3) every 15 min; restore script tested monthly. Written targets: RPO 15 min, RTO 1 h.
6. **Cold standby VPS:** streaming replica + rsynced code, documented manual DNS cutover — week-one acceptable, automate later.
7. **External 30 s uptime probe paging the owner + static status page**, deployed before launch, not after the first outage.
8. **Audit log spooled to a local queue** so logging failure never blocks auth.

## What I would get wrong first

1. **Refresh-rotation race.** Electron retries `POST /token` concurrently, both present the same token, reuse detection fires, family revoked, till logged out mid-service. Fix is the atomic conditional `UPDATE ... WHERE used_at IS NULL` + 10 s same-device grace returning the successor — write it that way on day one, not after the incident.
2. **Pairwise `sub` keyed off redirect-URI host.** Loopback ports are ephemeral and apps add URIs over time — the same user gets a new `sub` and every RP-side record orphans. Key the sector salt to `client_id` only.
3. **Believing "global logout" logs anyone out.** The back-office Express session and the till's cached roles live on after the SSO session dies. Short access tokens + `sid` in every token + documented 10-min propagation + introspection on sensitive endpoints — and be honest in the UI about what "sign out everywhere" means until back-channel logout ships.