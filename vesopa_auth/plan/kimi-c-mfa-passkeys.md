# MFA Specification — Vesopa OAuth

## 1. Passkeys / WebAuthn

**Library:** `@simplewebauthn/server` + `@simplewebauthn/browser` — ceremonies are four small JSON handlers; anything heavier is dead weight.
**Endpoints:** `POST /webauthn/{register,auth}/{options,verify}`; challenges in `webauthn_challenge(challenge PK, user_id NULL, kind, expires_at)`, 5-min TTL, single-use.
**userHandle:** opaque 64-byte random stored on the user row — never email or any PII.

```sql
CREATE TABLE passkey_credential (
  id              BINARY(16)  PRIMARY KEY,
  user_id         BINARY(16)  NOT NULL,
  credential_id   VARBINARY(1023) NOT NULL UNIQUE,
  public_key      VARBINARY(2048) NOT NULL,   -- COSE key, as returned by SimpleWebAuthn
  sign_count      INT UNSIGNED NOT NULL DEFAULT 0,
  transports      SET('usb','nfc','ble','internal','hybrid') NULL,
  aaguid          BINARY(16)  NULL,
  backup_eligible TINYINT(1)  NOT NULL,       -- BE flag
  backup_state    TINYINT(1)  NOT NULL,       -- BS flag: synced
  user_verified   TINYINT(1)  NOT NULL,
  nickname        VARCHAR(64) NULL,
  created_at      DATETIME    NOT NULL,
  last_used_at    DATETIME    NULL,
  revoked_at      DATETIME    NULL,
  KEY (user_id)
);
```

**Registration** (authed session + fresh password):
1. `options`: `rpID:'vesopa.com'`, `attestationType:'none'`, `authenticatorSelection:{ residentKey:'required', userVerification:'required' }`, `excludeCredentials` = user's existing ids.
2. `verify`: expectedChallenge, expectedOrigin `https://auth.vesopa.com`, expectedRPID `vesopa.com`, require UV flag; insert row + nickname.

**Authentication:**
1. `options`: email supplied → `allowCredentials` scoped to that user; blank → empty list (discoverable). `userVerification:'required'`.
2. `verify`: look up by `credential_id`; assert `userHandle === user.handle`; update `sign_count`/`last_used_at`; mint session `level=phish_resistant`.

| Decision | Ruling |
|---|---|
| First factor (passwordless) | **Yes** — UV-required passkey is possession+verification in one gesture |
| Email-first page UX | Email input gets `autocomplete="username webauthn"`; separate "Sign in with a passkey" button runs usernameless ceremony; typed email scopes `allowCredentials` |
| Conditional UI | **Yes** — the only passkey UX that survives an email-first page; race `mediation:'conditional'` get(), AbortController-cancel on manual submit, degrades to the button |
| `userVerification` | `required` everywhere — one code path; makes synced passkeys acceptable as sole factor |
| `attestation` | `none` — no trust-anchor maintenance for your own RP; AAGUID still stored (unverified) for support/inventory |
| **RP ID** | **`vesopa.com` (apex).** Apex-scoped credentials work on every current and future subdomain; `auth.`-scoped would orphan `cloud.`/`menu.` forever. Only `auth.vesopa.com` runs ceremonies → origin allowlist is that one origin; apps consume assurance via `acr`/`amr` token claims |
| Sign count, 2026 | Persist; **reject only if old>0 ∧ new>0 ∧ new≤old**. Synced passkeys (BE=1) legitimately return 0 → treat as no-signal, anomaly logged + security email, never a lockout |
| Electron till | Till loads `https://auth.vesopa.com` in its BrowserWindow — never `file://`/custom scheme (invalid origin kills WebAuthn). Primary: hybrid (caBLE) QR → staff scan with their phone and use *its* passkey. No address bar needed; WebAuthn checks origin, not chrome. Windows Hello allowed per-staff; a shared "till passkey" is forbidden |

## 2. TOTP authenticator app

- **Secret:** `crypto.randomBytes(20)` → base32; one active secret per user.
- **At rest:** AES-256-GCM; 32-byte key in `/etc/vesopa/mfa.key` (0440 root:app, read by pm2 at boot; never in DB/repo/env visible to app users). Store `key_id | nonce(12) | ct | tag`; `key_id` enables rotation.
- **URI:** `otpauth://totp/Vesopa:{email}?secret=…&issuer=Vesopa&digits=6&period=30&algorithm=SHA1` — SHA1/6/30 for app compatibility; TOTP does not depend on SHA1 collision resistance.
- **QR:** rendered client-side from the URI, shown once; never emailed, logged, or stored as image; manual key shown alongside.
- **Drift/replay:** accept steps t−1..t+1; store `last_step`, reject any step ≤ it.
- **Enrolment (no lockout):** fresh password auth → `pending` secret (10-min TTL) → scan → user submits one valid code → flip to `active`. Login flow is untouched until activation succeeds.
- **Recovery codes:** 10 × Crockford base32 `XXXXX-XXXXX` (50-bit); each argon2id-hashed in its own row with nullable `used_at`; single-use; shown exactly once at end of enrolment (copy/download/print); regenerate = delete-all-and-reissue; verify rate-limited 5/min/user.

## 3. SMS as a second factor

Plainly: the weakest factor here — SIM-swap, SS7/intercept, number recycling, phishable. NIST treats it as "restricted". Ship it anyway (owner requirement; beats password-only for QR-menu customers) behind fences:

- Counts toward `mfa`, **never** `phish_resistant`; refused for back office, hosting panel, and every step-up action.
- **A phone used as a primary sign-in factor (SMS OTP login) cannot also be that account's second factor** — one device is one factor.
- Code: 6 digits, 10-min TTL, 5 attempts kills the challenge; per-account + per-number send limits (1/min, 6/day) via Postcoder; message contains the code only, no links.
- Number change: OTP-verify new number, notify old number **and** email, 24-h hold before the new number satisfies MFA; risk engine treats a changed number as an unknown device (UK carrier SIM-swap APIs aren't worth the money).

## 4. Factor policy engine

```sql
user_factor(user_id, kind ENUM('passkey','totp','sms','rcode'), ref_id,
            status ENUM('pending','active','revoked'), enrolled_at, last_used_at, PRIMARY KEY(kind, ref_id))
app_policy(client_id PK, min_level ENUM('none','mfa','phish_resistant'), enforce_after DATE NULL, max_skips INT DEFAULT 5)
action_policy(action PK, min_level, max_auth_age_sec)   -- refund>£50, payout details, role change, OAuth-client create
auth_session(id PK, user_id, client_id, level ENUM('pwd','mfa','phish_resistant'), amr JSON, auth_time, device_id, ip)
```

Factor→level: password/social/email-code = `pwd`; +totp/sms = `mfa`; passkey (any use) = `phish_resistant`. Risk computed per login, stored only on session: unknown 30-day device cookie, new country/ASN, impossible travel (>800 km/h).

Evaluation order (login or action):
1. `app_policy.min_level` = base requirement.
2. `action_policy` match raises level and may impose `max_auth_age_sec` → step-up challenge, not re-login.
3. Risk raises: unknown device or new country → ≥`mfa`; impossible travel → `phish_resistant` + security email.
4. If session.level < required: challenge with strongest active factor meeting it (passkey > totp > sms).
5. No active factor: past `enforce_after` → enrolment interstitial before token issue; else allow + nudge (skips ≤ `max_skips`).

Result emitted as `acr`/`amr` + `auth_time` in the ID token; resource servers re-check, IdP guarantees.

## 5. Recovery

| Situation | Path |
|---|---|
| Lost phone (SMS factor) | Any other active factor → re-enrol; else recovery-email link + 48-h hold |
| Lost authenticator app | Recovery code or passkey → re-enrol TOTP; else recovery-email link + 48-h hold |
| Lost passkey device | Usually a no-op — synced passkeys (BE=1) survive; else other factor → register new passkey after full MFA |
| Lost email access | Recovery email/phone for notification + **admin-assisted only** — primary email is the recovery root and must never self-reset |
| Lost everything | Admin-assisted: ticket + evidence (staff: manager vouch + photo ID; customer: card last-4 + recent transaction) + 72-h cooling-off |

Rules (non-negotiable):
- Recovery email/phone (owner's ask): verified at setup; used ONLY for recovery links and security notifications — never a login method, never a factor.
- Changing recovery contacts or removing a factor: full MFA + notice to old contacts; removal effective after 24 h.
- Cooling-off: 48 h customer / 72 h staff (admin-approved); every recovery event notifies old email + old SMS + all live sessions; one "not me" click freezes the account.
- Admin-assisted: `recovery_audit(id, user_id, admin_id, approver_id, evidence, ip, before_json, after_json, created_at)`; two-person approval for staff accounts; immutable; surfaced in admin UI.
- Post-recovery sessions are `pwd`-level for 7 days and must re-enrol a factor at first login.
- **NEVER bypass MFA via:** SMS alone; email link alone; codes read to support by phone; any recovered session reaching a `phish_resistant` app before a new passkey has existed for 24 h.

## 6. Enrolment nudges without lockouts

- Enforcement by audience: back office/hosting/developer apps day 1; till staff `enforce_after = +30 d`; QR-menu customers optional forever, prompted every 90 d, dismissible.
- Post-login interstitial: "Add passkey (recommended) / authenticator app / phone number"; skip ≤ `max_skips` (5), then enrol-or-no-token once `enforce_after` passes.
- After any successful passkey login on a new device, offer one-click enrolment of that device — convert at the moment of success.
- Prompt to regenerate recovery codes when < 3 remain.
- Admin sees: per-user factors + status + `last_used_at`, recovery-contact verified?, codes remaining, risk flags, per-app coverage %, upcoming `enforce_after` dates, live `recovery_audit` feed.

## What I would get wrong first

1. **Email-link "reset MFA"** — shipped as a convenience, becomes the canonical bypass within a month; email alone must never clear a factor.
2. **Rejecting sign-count regressions** — synced passkeys return 0/flat counters; a strict check locks out every iCloud/Chrome user in week one.
3. **Day-one enforcement on till staff** — shared devices plus rota churn equals a lockout queue by Friday; grace periods and per-role dates exist so MFA survives contact with reality.