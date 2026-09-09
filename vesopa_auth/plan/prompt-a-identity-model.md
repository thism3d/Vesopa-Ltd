You are Kimi K3, acting as principal architect for a production identity provider.
Answer as a specification, not an essay. No preamble, no summary, no apologies.
Output GitHub-flavoured Markdown, at most 220 lines. Be decision-dense: state THE
decision and one line of why. Where you reject an alternative, say so in half a line.

# The system

"Vesopa OAuth" — a single sign-on / identity provider at https://auth.vesopa.com that
will replace EVERY login across Vesopa Ltd's products: the EPOS till app (Windows/Electron),
the QR dine-in menu (menu.vesopa.com), the EPOS back office (web), the hosting control panel
(cloud.vesopa.com), and future apps. Node.js + Express + MySQL (MariaDB 11.4). Single server,
Hestia-managed, pm2. Scale: thousands of end users now, low hundreds of thousands later.

Sign-in methods, all landing in ONE account:
- Email + password
- Email + emailed one-time code
- Phone + SMS OTP (UK only via Postcoder today)
- Google, Apple, Microsoft, GitHub (OIDC/OAuth). More providers later.

Product rules given by the owner, which you must honour:
- The login page IS the registration page. One form; a link below the button flips the
  button between "Log in" and "Register". No separate signup URL.
- Email first, with a toggle to phone. (The dine-in menu does phone first; the global one is
  email first.)
- A NEW email typed at auth.vesopa.com must be verified by emailed code the first time.
  An email that arrives from Google/Microsoft/Apple/GitHub is NOT re-verified.
- A NEW phone gets an SMS OTP; once verified the user is offered a password, and afterwards
  may choose password or OTP each time.
- Uniqueness: one Google account (or GitHub, or email, or phone) may be attached to exactly
  ONE Vesopa account WHILE ACTIVE. If the user revokes/unlinks it, that identifier becomes
  free again and may be linked to a different account. History must be retained.
- Users can edit profile image, display name, date of birth, and link/unlink: phone, recovery
  phone, recovery email, Google, Microsoft, Apple, GitHub.

# What I need from you

1. **The account model.** Exactly which tables, and why the split. Cover: the person, the
   identifiers they authenticate with, the credentials (password, TOTP later), and the
   external providers. Name the columns that matter and their types. I want the classic
   `users` / `identities` / `credentials` separation argued for or against explicitly.

2. **The uniqueness + revocation rule, expressed as a database constraint.** How do you make
   "unique while active, reusable after revocation, history retained" a real UNIQUE INDEX in
   MySQL — MySQL has no partial indexes. Give the exact index definition and the exact
   INSERT/UPDATE dance. Name the race condition and how the constraint closes it.

3. **Identifier normalisation before storage.** Email (case, gmail dots, plus-addressing —
   decide and justify), phone (E.164), and what Apple's private relay addresses
   (@privaterelay.appleid.com) mean for "same person, same email".

4. **Account linking and takeover.** A user signs in with Google whose email matches an
   existing password account. Do you auto-link? State the attack that makes the naive answer
   wrong, and give the rule you would ship. Also: what happens when a user tries to unlink
   their LAST way of signing in.

5. **Verification and OTP storage.** Table design for email codes and phone OTPs, hashing,
   TTL, attempt limits, rate limits per destination / per IP / per account. Note that phone
   OTP is generated and verified by a third party (Postcoder) and never seen by us — how does
   that change the table.

6. **Merging duplicate accounts.** People will end up with two. What is the minimum safe
   merge, and what must never be merged.

Finish with a short section titled `## What I would get wrong first` — the three mistakes you
predict an implementer makes on exactly this design.
