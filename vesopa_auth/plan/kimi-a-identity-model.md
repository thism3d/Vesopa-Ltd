# Vesopa OAuth — Identity Specification

## 1. Account model

**Decision: three core tables — `users`, `identities`, `credentials`.** One person has N identifiers and M secrets with different lifecycles: identifiers are revoked with history kept, secrets are rotated, the person persists. Rejected: one fat `users` row (no history, no second email, per-identifier uniqueness impossible). Rejected: password on `identities` (unlinking your email must not delete your password — a password authenticates the *account*, not an identifier).

### `users` — the person, nothing else
| column | type | note |
|---|---|---|
| id | BIGINT UNSIGNED AI PK | internal only, never in tokens |
| uuid | BINARY(16) UNIQUE | the only id exposed to clients |
| display_name / avatar_url / dob | VARCHAR(100) / VARCHAR(512) / DATE, all NULL | user-editable profile |
| status | ENUM('active','suspended','merged','deleted') | |
| merged_into | BIGINT UNSIGNED NULL | set iff status='merged' (§6) |
| created_at / updated_at / deleted_at | DATETIME(6) NULLs | |

No email, phone, or password here. `sessions` (elsewhere) FK `user_id`, never `identity_id`.

### `identities` — every way the person can be named
| column | type | note |
|---|---|---|
| id | BIGINT UNSIGNED AI PK | |
| user_id | BIGINT UNSIGNED FK → users.id | |
| type | VARCHAR(20) | 'email','phone','google','microsoft','apple','github'; VARCHAR not ENUM — new providers without DDL |
| identifier | VARCHAR(320) | normalised (§3): email_norm \| E.164 \| provider `sub` verbatim; collation `utf8mb4_bin` — case-folding is our job at write time, never the collation's |
| identifier_display | VARCHAR(320) NULL | as typed/asserted, UI only, never in WHERE |
| asserted_email | VARCHAR(320) NULL | IdP's email claim; for match *suggestions* only |
| asserted_email_verified | TINYINT(1) NULL | IdP's claim, stored verbatim |
| verified_at / verified_via | DATETIME(6) NULL / VARCHAR(20) NULL | 'otp','google','apple',… — provenance of proof |
| revoked_at | DATETIME(6) NULL | NULL = active |
| slot | BIGINT UNSIGNED generated | §2 |
| meta / created_at | JSON NULL / DATETIME(6) | provider profile snapshot, diagnostics only |

First Google sign-in inserts TWO rows: the `google` identity (sub) and an `email` identity with `verified_at=NOW, verified_via='google'` — provider emails are not re-verified (product rule). Separate rows because they revoke separately.

### `credentials` — secrets, keyed to the account
| column | type | note |
|---|---|---|
| id / user_id | BIGINT AI PK / FK | account-level, not identity-level |
| type | VARCHAR(20) | 'password' now; 'totp','webauthn' later |
| secret | VARBINARY(255) | argon2id hash; TOTP seed (encrypted at rest) later |
| created_at / revoked_at / last_used_at | DATETIME(6) | |
| slot | generated as §2 | one active password per account |

Zero credential rows is valid: OTP-only accounts exist by product rule (phone-verified users until they accept the password offer).

## 2. Unique-while-active, in MySQL

MySQL/MariaDB treat NULLs as distinct in unique indexes, so `UNIQUE(type, identifier, revoked_at)` would let two active rows coexist. Decision: fold activity into a stored generated column.

```sql
slot BIGINT UNSIGNED GENERATED ALWAYS AS (IF(revoked_at IS NULL, 0, id)) STORED,
UNIQUE KEY uq_active_identity (type, identifier, slot)
```
Active row → slot=0 → `(type, identifier, 0)` exists exactly once. Revoked → slot=id → unbounded history, no collisions. Key is ~1.4 KB, under InnoDB's 3072-byte limit.

**INSERT (claim/link):**
```sql
INSERT INTO identities (user_id, type, identifier, …, revoked_at) VALUES (…, NULL);
-- 1062 Duplicate → identifier attached to a live account → HTTP 409 IDENTITY_IN_USE
```
**REVOKE — one statement; slot flips atomically with the timestamp, no release window:**
```sql
UPDATE identities SET revoked_at = NOW(6) WHERE id = ? AND revoked_at IS NULL;
```
**RELINK: always a fresh INSERT.** Never `UPDATE revoked_at=NULL` on an old row — history rows are immutable.

**The race:** two concurrent requests link the same Google `sub` to two different accounts; both SELECT, both see free, both INSERT — classic TOCTOU. Without the index both commit; with it the loser's INSERT raises 1062 → mapped to 409, transaction rolls back. The SELECT is only for friendly errors; the index is the authority.

## 3. Identifier normalisation (before every lookup AND every insert)

**Email — two stored forms:**
- `identifier`: trim → domain lowercased + IDNA/punycode → local part lowercased. Rejected: RFC-strict case-sensitive local parts — no major provider honours it; `Sam@`/`sam@` duplicates are the real risk. Reject non-ASCII local parts (EAI) for now — homoglyph + deliverability risk.
- **gmail.com only** (googlemail.com → gmail.com): strip all local-part dots, strip `+tag`. Google defines these as one mailbox; not stripping lets one person mint unbounded accounts. Never generalise dot/tag-stripping — dots are significant at other providers; you'd fuse strangers.
- All other domains: keep `+tag` — user intent, and the provider's aliasing rules are unknowable.
- `identifier_display`: as typed, trimmed. Never queried.

**Phone:** libphonenumber parse → store E.164 (`+447700900123`); reject non-mobile line types for OTP. GB-only is enforced at the SMS send layer, not in the schema — the model accepts any valid E.164 so new countries are config, not migration.

**Provider `sub`:** byte-for-byte, case-sensitive, never normalised, never parsed.

**Apple private relay (`*@privaterelay.appleid.com`):** a per-(user, our-team-id) forwarding alias — it is *not* the person's email.
- Match Apple accounts on `sub` ONLY; never match/link by relay address. It can never equal a self-registered address and proves control of no other mailbox — "same person, same email" is undefined here.
- Store it as a contactable email flagged `relay`; prompt once for a real email. If the user disables the relay the address silently dies, so it must never be the account's only email identity.
- Same human, real email + relay email = two `email` identities; the fix is the merge flow (§6), not normalisation.

## 4. Linking and takeover

Naive rule — "Google email matches an existing password account → attach" — is a takeover primitive. **The attack:** attacker pre-registers `victim@gmail.com` with email+password, never verifies; weeks later the victim signs in via Google; silent auto-link welds the victim's Google identity to the attacker's account, and the attacker's password now opens everything the victim does. Mirror image: a provider asserting *unverified* emails (GitHub OAuth, future OIDC tenants) lets the attacker arrive carrying the matching email.

**Shipped rule:**
1. **Never auto-link on arrival.** Incoming (trusted, verified) email matching an existing account's verified email identity → interrupt: "You already have an account — sign in to link." Require one successful auth against the EXISTING account (password or email OTP), then link; thereafter either method signs straight in.
2. Trusted-verified allowlist: Google with `email_verified=true`; Apple (always); Microsoft consumer accounts. GitHub only after `/user/emails` shows primary+verified. Everything else: email treated as unverified — no match, no suggestion.
3. Linking from settings (active session) is self-proof — link immediately, subject to §2's 409.
4. Never match accounts by phone across providers; the SMS-OTP sign-in IS the proof for phone identities.
5. Every link/unlink notifies the existing verified email — detection for the variants you missed.

**Unlinking the last method:** refuse, `409 LAST_AUTH_METHOD` — add a method first, or choose account deletion. An orphaned account is a permanent support-ticket takeover vector. Enforced in one transaction: lock the user row `FOR UPDATE`, require `COUNT(active identities) + COUNT(active credentials) > 1` post-unlink; the row lock serialises a user unlinking phone and Google in two tabs at once.

## 5. Verification and OTP storage

### Email codes (we generate): `challenges`
| column | type | note |
|---|---|---|
| id | BIGINT UNSIGNED AI PK | |
| destination / purpose | VARCHAR(320) / VARCHAR(20) | email_norm; 'register','login','link','reset' — one table backs the combined login/register form |
| code_hash | CHAR(64) | hex(HMAC-SHA-256(code, server_pepper)); pepper defeats offline brute force of the 10⁶ space. Rejected bcrypt: pointless cost, DoS surface |
| account_id | BIGINT NULL | when the flow is bound to an account |
| attempts | TINYINT | burn at 5 wrong |
| expires_at / consumed_at / revoked_at | DATETIME(6) | 10-min TTL; one-time use |
| slot | generated as §2 | one LIVE challenge per (destination, purpose) |
| created_ip | VARBINARY(16) | |

- 6-digit code, CSPRNG. A new request for (destination, purpose) revokes the live row — kills parallel-code spraying; the user can never hold two valid codes.
- Success mints a 10-min, single-use, signed `verification_token` binding (destination, purpose); register/link endpoints require it — closes verify-then-swap-email.
- Rate limits (token bucket, fail closed): destination 5/h + 20/day; IP 30/h; account 10/h. Identical 200 whether the destination exists — no enumeration.

### Phone OTP (Postcoder generates AND verifies; we never see the code): `phone_challenges`
| column | type | note |
|---|---|---|
| id / e164 / purpose / created_ip / expires_at | as above | |
| provider_ref | VARCHAR(100) | Postcoder transaction handle — replaces code_hash entirely |
| status | ENUM('pending','verified','failed','expired') | driven by provider callback/poll |
| verified_at | DATETIME(6) NULL | |

What changes: no `code_hash`, no `attempts` — code custody and guess-limiting are Postcoder's; our row is correlation + audit. Three things stay ours: (1) send rate limits — SMS toll fraud bills us, not them; (2) on `verified`, check the callback's number == our stored `e164` before minting the same signed `verification_token`; (3) the GB-only gate at send time.

## 6. Merging duplicates

Precondition: the actor authenticates BOTH accounts in one session (or admin tool with a verified support case). Never merge on an email match alone — that is §4's attack with extra steps.

Minimum safe merge — one transaction, both user rows locked `FOR UPDATE` in id order:
1. Survivor = strongest proof (verified email + password/TOTP beats OTP-only); tie → older.
2. `UPDATE identities SET user_id=survivor WHERE user_id=loser AND revoked_at IS NULL` — §2's index makes conflicts fail loudly; a conflict is impossible, since it would have 409'd at link time.
3. Credentials: survivor's password/TOTP win; loser's conflicting credentials are revoked (`reason='merged'`), not moved — two live passwords or two TOTP seeds on one account is a bypass waiting for a UI bug. Future passkeys all move; they are many-per-account by design.
4. Profile: fill survivor's NULL fields from loser; never overwrite a set field.
5. Kill every loser session, token, and challenge.
6. Tombstone: loser `status='merged', merged_into=survivor`; insert `merge_audit(actor_user_id, loser, survivor, ip, at)`. The loser row is never deleted; its revoked-identity history stays pinned to the loser — audit must describe what was true at the time.
7. Emit `account.merged{loser_uuid, survivor_uuid}`; orders/loyalty are re-pointed by their owning services — the IdP owns no business data.

Never merged: verification state (an unverified identity stays unverified — merging must not launder proof of control), audit rows, and secrets (moved or revoked whole, never combined or re-hashed).

## What I would get wrong first

1. Writing `UNIQUE(type, identifier, revoked_at)` believing NULL `revoked_at` blocks duplicates — MySQL treats NULLs as distinct, so the index protects nothing, and the first concurrent double-link ships silently.
2. Auto-linking "verified" Google emails on arrival because it feels safe — the *existing* account, not the incoming identity, is the attacker's; the link-interrupt step reads as friction and gets deleted in week two.
3. Applying gmail canonicalisation globally: strip dots everywhere and you fuse strangers at providers where dots are significant; skip normalisation entirely and `User@`/`user@` become two accounts on day one.