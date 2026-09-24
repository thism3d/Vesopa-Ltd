# Vesopa OAuth — Surface & Build Order

## 1. Page inventory

**End user**

| Route | Purpose |
|---|---|
| `/login` | One page, one form: email first (toggle ⇄ phone), password *or* "email me a code", social buttons, "remember me on this device"; link under the button flips Log in ⇄ Register (register adds display name only) |
| `/login/verify` | Code/OTP entry — email code, SMS OTP, TOTP challenge, passkey prompt; resend with 60 s cooldown |
| `/consent` | OAuth consent: app logo/name, plain-English scope list, Allow/Deny, "remember for this app" |
| `/account/profile` | Avatar, display name, date of birth (doubles as account landing) |
| `/account/security` | Change password; TOTP / SMS / passkey enrolment; recovery codes |
| `/account/linked` | Link/unlink Google · Microsoft · Apple · GitHub; recovery phone; recovery email |
| `/account/devices` | Remembered devices, last IP + time, revoke any |
| `/account/history` | Login history: time, method, IP, geo, result |
| `/account/apps` | Connected apps with granted scopes; revoke |
| `/account/delete` | Account deletion (Apple mandates it; GDPR erasure) |
| `/logout` | Confirm + end session; RP-initiated logout target |

Protocol endpoints (`/authorize`, `/token`…) are not pages — see §3.

**Developer** (requires verified email)

| Route | Purpose |
|---|---|
| `/developers` | Application list with usage summary |
| `/developers/new` | Create app: name, type (web / native / M2M), first redirect URI |
| `/developers/apps/:id` | Settings: redirect URIs (exact match), client secrets with roll, allowed grants; PKCE always on |
| `/developers/apps/:id/branding` | Consent branding: logo, colours, privacy/terms/support URLs |
| `/developers/apps/:id/users` | Users of this app: count, last active, per-user revoke |
| `/developers/apps/:id/roles` | Role definitions + assignments, emitted as `roles` claim |
| `/developers/apps/:id/webhooks` | Endpoint URL, event subscriptions, signing secret, delivery log + replay |
| `/developers/apps/:id/keys` | Management-API keys: scoped, expiring |
| `/developers/apps/:id/usage` | Requests, MAU, error rate for this app |

**Admin** (role-gated; seeded only with `info@vesopasoftware.com`; every action needs passkey/TOTP step-up)

| Route | Purpose |
|---|---|
| `/admin` | Analytics dashboard (§2) |
| `/admin/users`, `/admin/users/:id` | Search by email/phone/ID; detail: methods, sessions, apps, events; actions: force logout, reset MFA, lock |
| `/admin/invites` | Email invitations with pre-assigned roles, 7-day expiry |
| `/admin/users/:id?view-as` | **Decision: impersonation refused.** Read-only view-as, red banner, every view audit-logged *and shown to the user* in `/account/history` |
| `/admin/applications` | Third-party approval queue; unapproved apps capped at 100 users |
| `/admin/audit` | Immutable audit log of all admin + developer actions |
| `/admin/health` | DB, mail queue, webhook backlog, cert expiry, disk, pm2 |

**Public** (the only indexable routes)

| Route | Purpose |
|---|---|
| `/` | Landing: one account for all Vesopa products |
| `/docs`, `/docs/*` | Developer documentation (§3) |
| `/status` | v1: from health checks. v2: externally hosted status subdomain — a status page on this box can't report this box's death |
| `/privacy` `/cookies` `/terms` `/acceptable-use` `/dpa` `/retention` `/security` `/gdpr` | Policy pages (§5) |
| `/.well-known/security.txt` | Disclosure contact (RFC 9116) |

## 2. Analytics panel

- Append-only `auth_events`, monthly `RANGE` partitions on `ts`, oldest dropped at 90 days.
- A pm2 cron rolls events into `stats_daily` every 5 min (watermarked, idempotent upsert). **Dashboards read rollups only.** Live queries allowed solely for "last 24 h" and per-user history (via `ix_user`).
- Suspicious activity is detected at *write time*, not chart time, into `security_alerts`.

```sql
auth_events(id PK, ts DATETIME(3), user_id NULL, app_id NULL, device_id NULL,
  method ENUM('password','email_code','phone_otp','google','apple','microsoft','github','totp','sms','passkey','refresh'),
  result ENUM('success','failure','challenge','deny'), reason VARCHAR(40) NULL,
  ip VARBINARY(16), country CHAR(2), is_new_user TINYINT,
  KEY ix_ts(ts), KEY ix_user(user_id,ts), KEY ix_app(app_id,ts))
stats_daily(day, app_id, method, result, reason, is_new_user, n, PRIMARY KEY(day,app_id,method,result,reason,is_new_user))
stats_active(day, user_id, PRIMARY KEY(day,user_id))  -- exact DAU/WAU/MAU
security_alerts(id, ts, user_id NULL, ip, rule, detail JSON)  -- written at event time
```

```sql
INSERT INTO stats_daily SELECT DATE(ts),app_id,method,result,COALESCE(reason,''),is_new_user,COUNT(*)
  FROM auth_events WHERE ts>=@wm AND ts<NOW() GROUP BY 1,2,3,4,5,6
  ON DUPLICATE KEY UPDATE n=VALUES(n);            -- watermark @wm in meta table
SELECT day, 100*SUM(n*(result='success'))/SUM(n*(result IN('success','failure'))) pct
  FROM stats_daily WHERE day>=CURDATE()-30 AND app_id<=>? GROUP BY day;
```

| Metric | Chart | Source |
|---|---|---|
| Sign-in success/failure rate | Line, 24h/7d/30d | `stats_daily` |
| Method mix | Stacked bar | `stats_daily` by method |
| Social provider mix | Donut | `stats_daily`, methods google/apple/microsoft/github |
| MFA adoption | Big number + trend | Live `SELECT` on `user_mfa` (small table), 5-min cache |
| New vs returning | Grouped bar | `is_new_user` set at event time from `users.created_at` |
| Failure reasons | Ranked bar | `reason`: bad_password, unknown_user, otp_expired, rate_limited, consent_denied |
| DAU / WAU / MAU | Big numbers | `COUNT(DISTINCT user_id)` over `stats_active` — exact to ~10M rows, no HLL needed |
| Suspicious activity | Alert feed, not a chart | `security_alerts` rules: ≥5 fails/IP/10m, ≥10 fails/account/hr, new country for user, impossible travel, refresh-token reuse |
| Consent deny rate per app | Line | `result='deny'` |

## 3. Developer experience

Docs live at `/docs`, built from repo markdown. Order = build order: Quickstart → Guides (code+PKCE, refresh, logout, claims/roles, webhooks) → Endpoint reference → Error catalogue → Changelog. Every page: **curl first**, JS second. **Decision: Authorization Code + PKCE for everything; `client_credentials` for M2M; no implicit, no ROPC, no dynamic client registration in v1** — apps are created in the dashboard, which is what the approval queue hooks into.

| Endpoint | Must document |
|---|---|
| `GET /.well-known/openid-configuration` | Full discovery doc (below) |
| `GET /authorize` | `response_type=code`, S256 `code_challenge` mandatory, `state`+`nonce`, exact-match `redirect_uri` |
| `POST /token` | Code exchange, refresh (rotating), client_credentials; every error JSON shown verbatim |
| `GET /userinfo` | Claims per scope |
| `GET /.well-known/jwks.json` | RS256, `kid`, two-key overlap during rotation |
| `POST /revoke`, `POST /introspect` | RFC 7009 (revoking refresh kills the chain); RFC 7662 for resource servers |
| `GET /logout` | RP-initiated: `id_token_hint`, pre-registered `post_logout_redirect_uri` |
| Webhooks (outbound) | Events `user.created/updated/deleted`, `session.created`, `mfa.enrolled`, `grant.revoked`; header `Vesopa-Signature: t=…,v1=HMAC_SHA256(secret,t.body)`; 5 retries, exp-backoff over 24 h; replay from dashboard |

```json
{
  "issuer": "https://auth.vesopa.com",
  "authorization_endpoint": "https://auth.vesopa.com/authorize",
  "token_endpoint": "https://auth.vesopa.com/token",
  "userinfo_endpoint": "https://auth.vesopa.com/userinfo",
  "jwks_uri": "https://auth.vesopa.com/.well-known/jwks.json",
  "revocation_endpoint": "https://auth.vesopa.com/revoke",
  "introspection_endpoint": "https://auth.vesopa.com/introspect",
  "end_session_endpoint": "https://auth.vesopa.com/logout",
  "response_types_supported": ["code"], "grant_types_supported": ["authorization_code","refresh_token","client_credentials"],
  "subject_types_supported": ["public"], "id_token_signing_alg_values_supported": ["RS256"],
  "scopes_supported": ["openid","profile","email","phone","offline_access"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic","client_secret_post"],
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": ["sub","iss","aud","exp","iat","nonce","email","email_verified","name","picture","phone_number","roles"]
}
```

10-minute quickstart: 1) dashboard → create app, copy `client_id`/secret (0–2 min) 2) generate PKCE verifier/challenge with the provided one-liner (2–3) 3) open the built `/authorize` URL, log in, consent (3–5) 4) `curl -X POST /token` with code+verifier → tokens (5–7) 5) `curl /userinfo -H "Authorization: Bearer …"` (7–8) 6) verify `id_token` against JWKS with the provided Node snippet; refresh when expired (8–10).

Good beats complete: time-to-first-`/userinfo` under 10 minutes is the KPI; every curl runs verbatim against a seeded sandbox app; error responses shown exactly as returned; one golden path, not a grant-type matrix; state plainly what is unsupported — undocumented-but-working is worse than documented-as-absent.

## 4. Branding & metadata

Asset set (source SVG in `/brand`, everything else exported):
- Favicons: `favicon.ico` (16/32/48), `icon.svg` with `prefers-color-scheme` dark variant, `apple-touch-icon.png` 180².
- PWA: `site.webmanifest` ("Vesopa Account"), 192/512 + maskable 512, theme/background colours.
- Social: `og.png` 1200×630, reused for Twitter — landing/docs only.
- Email: header logo PNG @2x, ≤600 px wide, ≤50 KB; light **and** dark-bg variants; wordmark fallback.
- Consent: default Vesopa logo 256² + wordmark; per-app override via developer branding.

Exact `<head>` for `/login`:

```html
<title>Sign in · Vesopa</title>
<meta name="description" content="Sign in to your Vesopa account for EPOS, dine-in, back office and hosting.">
<link rel="canonical" href="https://auth.vesopa.com/login">
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="website">
<meta property="og:title" content="Sign in · Vesopa">
<meta property="og:description" content="One account for every Vesopa product.">
<meta property="og:url" content="https://auth.vesopa.com/login">
<meta property="og:image" content="https://auth.vesopa.com/brand/og.png">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0f14" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

Indexing: only `/`, `/docs`, `/status`, policy pages are indexable. `robots.txt` disallows `/account /admin /developers /api` but **not** `/login` — a disallowed page can't be crawled to see its `noindex`.

Accessibility (WCAG 2.2 AA, non-negotiable on a login page):
- Real `<label for>` on every input; placeholders are hints, never labels. Errors set `aria-describedby`; an `aria-live` region announces submission failure and focus moves to an error summary.
- `autocomplete` tokens: `username`, `current-password`, `new-password`, `one-time-code`, `email`, `tel`, `name`, `bday`; passkey field appends `webauthn` (enables conditional UI).
- OTP: one input, `inputmode="numeric"`, paste works, no per-box focus juggling.
- Contrast ≥4.5:1 text, ≥3:1 UI; visible focus ring; never error-by-colour alone; targets ≥24 px; usable at 320 px width and 200% zoom; `prefers-reduced-motion` honoured.
- Social buttons are real links/buttons with accessible name "Continue with Google" (logo `alt=""`, decorative).
- No CAPTCHA on login — risk-based throttling instead (CAPTCHAs fail assistive-tech users and leak traffic to third parties).

Email templates: 600 px table layout, inline CSS, forced light background, code in ≥24 px monospace, subject `Your Vesopa code: 483920`, always both HTML and plaintext parts; footer carries Vesopa Ltd + company number + registered office — legally required on UK business email (Companies Act 2006).

## 5. Policy pages

| Page | Status | Must contain / gates |
|---|---|---|
| `/privacy` | **Legally required** (UK GDPR Art 13/14) | Data categories, lawful bases, retention, subprocessors, transfers, rights, ICO complaint route. Also mandatory for Google/Apple/Microsoft/GitHub OAuth review; Google requires it on the verified domain with per-scope data use |
| `/cookies` | **Legally required** (PECR) | Table: session, CSRF, remember-device — all strictly necessary ⇒ no consent banner on auth pages; no third-party trackers on `/login` |
| `/terms` | Expected (contract) | Service scope, liability cap, suspension rights, governing law (England & Wales) |
| `/acceptable-use` | Expected | No credential harvesting, no OTP/SMS abuse, enforcement rights |
| `/dpa` | Expected (Art 28; needed for B2B) | Subprocessors: server host, transactional email, SMS gateway; transfer mechanism (IDTA/UK addendum) |
| `/retention` | Expected | Events 90 d → aggregates only; account purge ≤30 d after deletion; backups ≤35 d; DSAR export format |
| `/security` | Expected | argon2id, TLS 1.3, key rotation, disclosure via `security.txt` — the customer due-diligence page |
| `/gdpr` | **Content legally required** (may fold into `/privacy`) | DSAR route (`privacy@`), 1-month clock, ICO registration number — the ICO data-protection-fee registration itself is legally required |

Also legally required and routinely missed: registered company name, number and office in the website footer (Companies Act 2006).

Provider gates: **Google** — verify domain (Search Console), privacy + homepage on that domain, per-scope justification; ship with `openid email profile` only (non-sensitive) to avoid the video/security-assessment track; users see "unverified app" until approved, so start verification in Phase 1 — it takes weeks. **Apple** — App Store Guideline 4.8: any iOS app offering Google/GitHub login must also offer Sign in with Apple; honour private-relay addresses; provide account deletion (`/account/delete`). **Microsoft** — verified publisher (Partner Center) + verified domain, or consent screens show "unverified"; privacy + terms URLs required in app branding. **GitHub** — least strict: homepage URL, callback, privacy URL for Marketplace.

## 6. Build order

**Phase 0 — Provisioning** → *https://auth.vesopa.com returns 200 over valid TLS*
1. DNS A/AAAA for `auth.`, reserve `status.`; Hestia web domain + Let's Encrypt + force HTTPS + HSTS (S)
2. Node 20 LTS, pm2 + startup hook, logrotate (S)
3. MySQL 8: `vesopa_auth` DB, least-privilege user, `utf8mb4`, localhost bind only (S)
4. Mail on Hestia: no-reply@, security@, privacy@; SPF + DKIM + DMARC `p=quarantine`; verify inbox placement at Gmail/Outlook (M)
5. nginx → Express proxy, security headers (CSP, `frame-ancestors 'none'`), edge rate-limit zone (M)
6. Nightly encrypted off-site mysqldump; **run a restore test now** (S)

**Phase 1 — Auth core** → *a real user registers, logs in (password + email code), logs out on the live domain*
7. Migration runner + core schema: users, credentials, sessions, devices, auth_events (M)
8. argon2id hashing; `/login` register⇄login flip; remember-device cookie (M)
9. Email-code flow; phone OTP behind a provider interface, one SMS vendor (M)
10. Sessions: opaque cookie, rotate on login/MFA/privilege change, idle 24 h + absolute 30 d (M)

**Phase 2 — OIDC provider** → *a demo RP completes code+PKCE end to end*
11. `/authorize`, `/token`, `/userinfo`, JWKS (RS256, `kid`, rotation), discovery doc (L)
12. Consent screen with per-app branding; rotating refresh tokens + reuse detection (L)
13. Revoke, introspect, RP-initiated logout (M)

**Phase 3 — Social + MFA** → *all seven sign-in methods live; account area complete*
14. Google, Microsoft, GitHub inbound — **submit Google/MS verification the same day** (M)
15. Apple inbound: web flow, private relay, 4.8 check for future iOS apps (M)
16. TOTP + recovery codes; SMS MFA (M)
17. Passkeys: platform + cross-device, conditional UI (L)
18. Account area: profile, security, linked, devices, history, apps, delete (M)

**Phase 4 — Developer portal** → *a third party self-serves an app and receives a webhook*
19. App CRUD: URIs, secret roll, grants, branding (M)
20. Roles, per-app users, API keys, usage page (M)
21. Webhooks: queue worker, HMAC signing, 24 h backoff retries, dashboard replay (M)
22. Docs: quickstart, endpoint reference, webhook guide, error catalogue (M)

**Phase 5 — Admin + analytics** → *dashboard live, admin behind step-up*
23. Admin RBAC + step-up; view-as (audited, user-visible) (M)
24. Events → rollup job → §2 charts (M)
25. User search/detail, invites, app approval queue, audit log (M)
26. `security_alerts` rules + feed (S)

**Phase 6 — Migrate the four products** → *all logins via IdP, zero forced resets*
27. Reference middleware (Express) + integration doc (M)
28. Identity import: copy app users (email, verified flag, **legacy hash + algo tag**) into IdP; `app_user_links(app_id, idp_sub, legacy_user_id)`; auto-link by verified email on first login (L)
29. Hash shim: verify with legacy algo at login → transparent rehash to argon2id → clear legacy tag. Never bulk-reset. Users dormant past the soak get a "set your Vesopa password" invite via the email-code flow (M)
30. Dual-auth: each app accepts legacy session cookie **or** IdP token, behind `AUTH_PROVIDER=legacy|oidc`; legacy sessions expire naturally ≤30 d. **Decision: do not port sessions — one clean re-login per user beats importing insecure session formats** (L)
31. Cut over in risk order: QR dine-in (S) → back office (S) → hosting panel (M) → EPOS till (M) — till needs offline tolerance: cached tokens, 24 h grace on last-known-good
32. **Rollback plan**: IdP never writes to app DBs; legacy login code ships dormant; rollback = flip flag + redeploy, users re-authenticate on legacy with passwords intact. Point of no return is task 33 only
33. 90-day soak with §7 monitoring → drop legacy password columns + dormant login code, announced 30 d prior (M)

## 7. Test plan — prove on https://auth.vesopa.com before replacing any login

- **Sign-in matrix**: all 7 methods complete on Chrome, Firefox, Safari, iOS Safari, Android Chrome; every failure mode (wrong password, expired code, cancelled social) shows the right error and writes the right `auth_events` row.
- **MFA**: TOTP enrol → challenge → recovery code → disable; passkey create + auth, platform and cross-device QR; remember-me skips MFA on that device only.
- **OIDC conformance-lite** (certified lib as RP): code+PKCE happy path; `state`/`nonce` mismatch rejected; redirect_uri exact-match enforced; refresh rotation works and reuse kills the chain; revoked grant ends refresh; `id_token` verifies against JWKS and survives a key rotation.
- **Consent**: third-party app gets branded consent + working deny; revoke at `/account/apps` kills tokens; first-party Vesopa apps skip consent (decision).
- **Sessions**: cookie rotates after login and MFA (fixation); `/logout` + back button ≠ session; device revoke kills a live session.
- **Abuse**: 6 bad passwords → throttle + alert in `/admin`; OTP brute force capped; limits return 429 JSON.
- **Email**: mail-tester ≥9/10 (SPF/DKIM/DMARC); codes reach Gmail/Outlook <60 s.
- **Edge**: SSL Labs A+, securityheaders.com A; `noindex` present on `/login`, absent on `/`; OG card renders in Slack/Twitter validators; Lighthouse/aXe a11y clean on `/login`.
- **Load**: k6 100 concurrent logins p95 <500 ms, `/token` p95 <200 ms, MySQL CPU <60%.
- **Ops**: backup restores to a scratch DB; rollup counts match raw events for a sampled hour; pm2 restart <5 s.
- **Migration dry run**: staging import per app; legacy-hash login rehashes to argon2id; email-match links correctly; flag rollback exercised in production with one internal canary before the first real cutover.

## What I would get wrong first

1. **Big-bang migration.** Mass password resets or ported sessions "to avoid dual-auth complexity" — that complexity *is* the safety. Lazy rehash + dual-auth + flags is unglamorous and is the whole game.
2. **Analytics on raw events.** Live `GROUP BY` over `auth_events` feels fine at 1k users and melts the single MySQL box on the first busy Saturday across the EPOS fleet — the dashboard becomes the outage. Rollups from day one.
3. **Treating provider verification as an afterthought.** Google consent-screen verification, Microsoft publisher verification, Apple's 4.8 and private-relay rules are multi-week compliance workstreams with document prerequisites — start them in Phase 1, not when social login ships.