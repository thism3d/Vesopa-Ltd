---
title: Security Statement
slug: security
summary: How Vesopa OAuth protects accounts and the data behind them, what we do when something goes wrong, and what we do not claim.
updated: 2026-09-08
---

# Security Statement

Vesopa OAuth is the front door to every Vesopa product. If it fails, everything behind it fails with it. This page describes what we do about that.

It is written to be checked. If something here is not true of the running service, that is a bug and we want to hear about it at **security@vesopa.com**.

## 1. Passwords and codes

- Passwords are stored **only** as salted hashes, produced by a slow, purpose-built password hashing function. Nobody at Vesopa can read your password, and no support process ever involves us seeing it.
- We check new passwords against known-breached password lists and refuse the obvious ones, because a password that is already in a public dump is not a password.
- One-time codes are random, short-lived, single-use, stored hashed rather than in the clear, and deleted within 24 hours. A code that has been used, or has expired, cannot be used again.
- Codes and sign-in attempts are rate limited — per account, per destination address or number, and per IP address — so that guessing them is not practical.
- We will **never** ask you for your password or a one-time code by email, phone or message. Anyone who does is attacking you.

## 2. Multi-factor authentication

You can add a second factor, and we would rather you did:

- **Passkeys (WebAuthn)** — the strongest option, and the one we recommend. The private key never leaves your device; we store only the public key. A passkey cannot be phished, because it will not sign anything for a website that is not ours.
- **Authenticator app (TOTP)** — the secret is encrypted at rest, codes are checked within a narrow time window, and a code cannot be replayed once used.
- **SMS** — better than nothing and convenient, but the weakest of the three: text messages can be intercepted and phone numbers can be taken over by SIM swap. We offer it because it is the factor most people can actually use, and we treat it accordingly.

Recovery codes are single-use, stored hashed, and shown to you once. Keep them somewhere that is not the device you sign in with.

Sensitive actions — changing a password, removing a factor, deleting the account — can require you to prove yourself again, even mid-session.

## 3. Sessions, cookies and devices

- Session cookies are `HttpOnly`, `Secure` and carry a `SameSite` attribute. JavaScript cannot read them and other sites cannot make your browser send them along with a cross-site request.
- Sessions carry a random identifier and no personal data.
- Every state-changing form carries a CSRF token, and we reject anything where it does not match.
- "Remember this device" is bound to a device record we hold, not just to a cookie. Revoking the device in your account kills it instantly, wherever the cookie is.
- Your account shows every active session, every remembered device, and your sign-in history with IP addresses, so you can spot something that is not you and end it yourself.

## 4. The protocol

Vesopa OAuth implements OAuth 2.1 and OpenID Connect, and it declines the parts of older OAuth that are known to be unsafe.

- **PKCE** on authorisation code flows, so an intercepted code is useless without the verifier.
- **Exact redirect URI matching.** Registered URIs are matched exactly; no wildcards, no prefix matching, no open redirect.
- Authorisation codes are **single-use and short-lived**, and reuse invalidates the exchange.
- **Refresh token rotation with reuse detection.** A refresh token is exchanged once. If an old one is presented again, we treat the whole chain as compromised and revoke it.
- Tokens are signed with rotating keys published at a JWKS endpoint, so any resource server can verify them and we can retire a key without an outage.
- The **implicit grant and the resource owner password grant are not implemented**, because they hand credentials and tokens to places they should not go.
- Applications are isolated from one another by default. Two applications share a user only when the same developer owns both and the user has agreed to it.

## 5. In transit and at rest

- Everything is served over HTTPS, and plain HTTP is redirected to it.
- Passwords are hashed. Authenticator secrets are encrypted at rest. Passkeys exist here only as public keys, which are not secret by design.
- Database access is restricted to the application, over a private path, with credentials that are not shared with anything else.

## 6. Infrastructure and access

- Vesopa OAuth runs on **Vesopa's own servers in the EU and the UK**. There is no third-party cloud provider holding account data.
- Access to production servers and databases is limited to the people whose job requires it, is protected by multi-factor authentication, and is logged.
- We patch the operating system and dependencies on a routine schedule, and out of schedule when something serious is published.
- The service sits behind a firewall and a reverse proxy, with rate limiting applied before requests reach the application.
- Backups are taken regularly, and restores are tested rather than assumed. A backup nobody has restored is a hope, not a backup.

## 7. Logging and monitoring

We keep an audit log of sign-ins and security events: what happened, when, from which IP address and user-agent, and — when it failed — why. It runs for 13 months and then expires.

Automated checks look at each sign-in attempt for the things that usually mean trouble: an unfamiliar device, an unusual location, an impossible journey between two sign-ins, a run of failures. A check can demand a second factor or block the attempt. We tell you by email when something significant happens to your account — a new device, a password change, a factor added or removed, a provider linked or unlinked — so that if it was not you, you find out from us rather than later.

## 8. When something goes wrong

We do not assume it will not. The procedure is:

1. **Triage and contain.** Stop the bleeding first — revoke tokens, block traffic, take the affected path offline if that is what it takes.
2. **Investigate.** Establish what was reached, by whom, and for how long, using the audit log.
3. **Notify.** If a breach is likely to risk people's rights and freedoms, we report it to the Information Commissioner's Office **within 72 hours** of becoming aware. If the risk to you is high, we tell you **without undue delay**, in plain terms: what happened, what it means for you, and what to do.
4. **Fix and learn.** Close the hole, then work out what let it open and change that too.
5. **Tell business customers.** Where the data is theirs and we are the processor, we tell them without undue delay so they can meet their own obligations.

## 9. Reporting a vulnerability

Send it to **security@vesopa.com**, with enough detail to reproduce it. We aim to acknowledge within two working days and to keep you posted while we fix it.

The rules for testing — what is in bounds, what is not, and our commitment not to pursue researchers who follow them — are in section 7 of the [Acceptable Use Policy](/acceptable-use). The short version: test your own account, take the minimum action needed to prove the problem, never touch anyone else's data, do not run denial-of-service tests, and give us a reasonable chance to fix it before publishing.

We do not run a paid bug bounty. We will credit you if you would like to be credited.

## 10. What we do not claim

Being straight about this matters more than looking impressive on a questionnaire.

- We **do not hold** ISO 27001, SOC 2 or PCI DSS certification, and we will not tick a box saying otherwise.
- Vesopa OAuth **does not process card details**. Payments in Vesopa products are handled elsewhere and never reach the sign-in service.
- We have **not** had an independent penetration test published as of the date at the top of this page. If that changes, this line changes.
- No system is perfectly secure, ours included. Anyone who tells you their system is has either not looked or is selling something.

## 11. What you can do

The two things that matter most are yours to do, not ours:

- **Add a passkey.** It takes about twenty seconds and it removes phishing as a way into your account.
- **Never give anyone a one-time code**, however plausible the reason and however much they sound like us. That single habit defeats most real-world account takeovers.

Beyond those: use a password you have not used anywhere else, check your device list occasionally, and if an email tells you something happened to your account that you did not do, act on it.

## 12. Contact

- Security reports and vulnerabilities: **security@vesopa.com**
- Data protection questions: **privacy@vesopa.com**
- Anything else: **info@vesopasoftware.com**
