You are Kimi K3, acting as principal architect and product lead for a production identity
provider. No preamble. GitHub-flavoured Markdown, at most 260 lines. Decision-dense.

# The system

"Vesopa OAuth" at https://auth.vesopa.com — Node.js + Express + MySQL, nginx, pm2, on a
Hestia-managed Linux server. It becomes the single login for every Vesopa Ltd product
(EPOS till, QR dine-in menu, back office, hosting panel) and later for third-party
developers. Sign-in: email+password, email code, phone OTP, Google, Apple, Microsoft,
GitHub. MFA: TOTP, SMS, passkeys. The identity model, protocol design and MFA design are
being specified separately — do NOT re-specify them. This document is about the SURFACE and
the BUILD ORDER.

# What I need from you

1. **The complete page inventory**, grouped by audience, each with its route and its one-line
   purpose. Four audiences:
   - **End user**: the login/registration page (one page, one form, a link under the button
     that flips "Log in" ⇄ "Register"; email first with a toggle to phone; social buttons;
     "remember me on this device"), the code/OTP screen, the consent screen, and the account
     area — profile (image, display name, date of birth), security (password, MFA, passkeys),
     linked accounts (Google/Microsoft/Apple/GitHub, recovery phone, recovery email),
     devices, login history with IP, connected apps with revoke.
   - **Developer**: application list, create application, application settings (redirect URIs,
     client secrets, allowed grants, branding of the consent screen), users of that
     application, roles, webhooks, API keys, usage.
   - **Admin** (info@vesopasoftware.com): the analytics dashboard, user search and detail,
     invitations, impersonation-with-audit or its refusal, application approval, audit log,
     system health.
   - **Public**: landing, developer documentation, status, and the policy pages.

2. **The analytics panel.** Which metrics actually matter for an IdP, which charts, and the
   SQL shape behind each (aggregate tables vs live queries — decide, given MySQL and a
   single box). Include sign-in success/failure rate, method mix, MFA adoption, new vs
   returning, provider mix, failure reasons, suspicious-activity surfacing.

3. **Developer experience.** The documentation set, written as curl examples first, with
   webhooks second. List every endpoint that must be documented, the exact discovery
   document (`/.well-known/openid-configuration`) contents, and a "10-minute quickstart"
   outline. Say what makes an IdP's docs good rather than complete.

4. **Branding and metadata, done properly.** The asset set to produce (favicon set, apple
   touch icon, PWA manifest, OG/Twitter card images, email header logo, consent-screen logo,
   dark and light variants), the exact `<head>` for the login page (title, description,
   canonical, OG, Twitter, theme-color, robots — a login page should NOT be indexed except
   the landing/docs), and the email template branding. Note the accessibility requirements a
   login page must meet (labels, focus order, contrast, autocomplete tokens like
   `username`, `current-password`, `one-time-code`, screen-reader announcements for errors).

5. **The policy pages** required for a UK company operating an IdP, with a one-line note on
   what each must contain and the specific things Google/Apple/Microsoft/GitHub require to be
   in them before they approve an OAuth app: privacy policy, cookie policy, terms of service,
   acceptable use, data processing / subprocessors, data retention & deletion, security
   statement, GDPR rights (UK GDPR, ICO registration, DSAR route). Say which are legally
   required and which are merely expected.

6. **The build order.** A phased plan with numbered tasks an implementer can work through
   top to bottom, each phase ending in something demonstrable. Phase 0 is server provisioning
   (Node app under Hestia, MySQL database, mail accounts, TLS, DNS). The final phases are
   migrating the four existing Vesopa apps onto this IdP WITHOUT locking existing users out —
   spell out the migration of existing password hashes and existing sessions, and the
   rollback plan. Mark each task with a rough size (S/M/L).

7. **The test plan.** What must be proven end-to-end on the live domain before this replaces
   any existing login, listed as concrete checks.

Finish with `## What I would get wrong first` — the three mistakes you predict.
