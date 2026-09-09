# Vesopa OAuth — policy pages

The legal and policy content for **Vesopa OAuth**, the identity provider at https://auth.vesopa.com, operated by Vesopa Software Ltd (United Kingdom).

Each file is one page. Each has YAML frontmatter with `title`, `slug`, `summary` and `updated`. The slug is the intended public path, so `slug: privacy` is served at `/privacy`, and the cross-links between the files already assume that.

## The pages

| File | Slug | What it covers |
| --- | --- | --- |
| `privacy-policy.md` | `privacy` | The controller notice: what we hold, why, the lawful bases, the social sign-in scopes and what each provider returns, the Google Limited Use disclosure, Apple's private email relay, unlinking a provider, who else sees the data, transfers, and the account deletion route. This is the page Google, Apple, Microsoft and GitHub read when they review the application. |
| `cookie-policy.md` | `cookies` | The three cookies — session/SSO, CSRF, optional "remember this device" — with purpose and lifetime, why there is no advertising or third-party analytics, and why there is no cookie banner. |
| `terms-of-service.md` | `terms` | The agreement: what the service does, account rules, connected applications, the extra obligations for developers who register an application, availability, suspension and termination, liability, and governing law. |
| `acceptable-use-policy.md` | `acceptable-use` | What you must not do — attacks, one-time code and SMS abuse, impersonation and phishing, account abuse, data harvesting, unlawful use — the security research rules and safe harbour, enforcement, and how to appeal. |
| `data-processing-and-subprocessors.md` | `data-processing` | Who is controller and who is processor in each situation, the complete sub-processor list (Google, Apple, Microsoft, GitHub, Postcoder; hosting on Vesopa's own EU/UK servers), sub-processor change notice, transfers, and our processor commitments. |
| `data-retention-and-deletion.md` | `retention` | How long each kind of data is kept and why — 13 months for logs, 30 days to purge after deletion, 24 hours for one-time codes — what account deletion does, what survives it, backups, and how to delete one thing without deleting everything. |
| `security-statement.md` | `security` | Password and code handling, MFA including passkeys, sessions and cookies, the OAuth 2.1 / OIDC protocol decisions, infrastructure and access control, logging, incident response and ICO notification, vulnerability disclosure, and an explicit list of what we do **not** claim. |
| `your-data-rights.md` | `your-data-rights` | The UK GDPR rights one by one, what you can do self-service, how to make a DSAR to privacy@vesopa.com, identity checks, timescales and costs, automated decisions, and the route to complain to the ICO. |

## Contact addresses used throughout

| Purpose | Address |
| --- | --- |
| Privacy, data requests, deletion | privacy@vesopa.com |
| General | info@vesopasoftware.com |
| Security reports and vulnerabilities | security@vesopa.com |

## Placeholders a human must fill in

Every one of these appears in the text as literal bracketed text. Search for `[` across the folder to find them all.

| Placeholder | What it needs | Appears in |
| --- | --- | --- |
| ~~`[COMPANY NUMBER]`~~ | **Filled in: 17362206** | — |
| ~~`[REGISTERED OFFICE]`~~ | **Filled in: Baglan, Port Talbot, SA12 7AX, Wales** | — |
| ~~`[DELETE ACCOUNT URL]`~~ | **Filled in: https://auth.vesopa.com/account/delete** — the page exists and resolves | — |
| `[ICO REGISTRATION]` | **Removed rather than filled.** Vesopa's own ICO register entry number was not available, and inventing one would be worse than omitting it. The sentences that used to carry it now give the ICO complaint route instead — which is the part UK GDPR actually requires. **The data-protection fee registration is itself a legal requirement**: once Vesopa is registered, add the number back to `privacy-policy.md` and `your-data-rights.md`. | privacy-policy, your-data-rights |

## Also check before publishing

Not placeholders, but claims that must match the shipped service:

- The self-service page names used in the text — **Profile**, **Security**, **Devices**, **Login history**, **Linked accounts**, **Connected apps** — should match the labels in the account area, and the "Delete my account" control should live under **Security**.
- `security-statement.md` states that there is no published independent penetration test and no ISO 27001, SOC 2 or PCI DSS certification. Update that line if either changes; do not add a certification claim that is not true.
- `data-processing-and-subprocessors.md` commits to at least **30 days'** notice before a new sub-processor starts processing. Confirm that is a commitment Vesopa wants to make.
- The retention figures (13 months / 30 days / 24 hours) appear in four files. If one changes, change all of them.
- Apple's email relay section assumes the sending domain and addresses are registered with Apple for the private relay. That registration must stay valid or relay mail will bounce.
