You are Kimi K3, acting as principal architect for a production identity provider.
Answer as a specification, not an essay. No preamble. GitHub-flavoured Markdown, at most
200 lines. Decision-dense: THE decision plus one line of why.

# The system

"Vesopa OAuth" at https://auth.vesopa.com — Node.js + Express + MySQL (MariaDB 11.4),
single Linux server behind nginx, pm2. It replaces every login across Vesopa Ltd: a Windows
Electron EPOS till, a QR dine-in menu, a back office, a hosting panel, plus developer apps.

Primary factors already decided: email+password, email code, phone SMS OTP (Postcoder, UK),
and social sign-in (Google, Apple, Microsoft, GitHub).

The owner now wants **multi-factor authentication: authenticator app, mobile number, and
passkeys.**

# What I need from you

1. **Passkeys / WebAuthn.** The full server-side design in Node without a heavyweight
   framework: which library, the registration ceremony, the authentication ceremony, and the
   exact table for stored credentials (credential id, public key, sign count, transports,
   AAGUID, backup eligible/state, created, last used). Decide:
   - Passkey as a FIRST factor (passwordless login) — yes or no, and the UX for
     "sign in with a passkey" on a page whose first field is an email box.
   - Discoverable credentials / conditional UI (autofill) — worth it or not.
   - `userVerification` setting, attestation setting, and RP ID choice when the login page
     is at auth.vesopa.com but apps live at menu.vesopa.com, cloud.vesopa.com and inside an
     Electron shell. This RP ID decision is the one I most need right.
   - Sign-count and cloned-authenticator handling in 2026, when most passkeys are synced.
   - What happens on the Electron till, which has no browser address bar.

2. **TOTP authenticator app.** Secret generation and storage (encrypted at rest with what
   key, kept where), the otpauth:// URI and QR, drift window, replay prevention, and the
   enrolment flow that does not lock a user out. Backup/recovery codes: how many, format,
   hashing, single-use, and where they are shown.

3. **SMS as a second factor.** Say plainly how much weaker it is and whether to offer it at
   all given the owner asked for it; if yes, what to do so it is not the weakest link
   (SIM-swap, number reuse, and the rule about a phone that is also a primary login factor).

4. **The factor policy engine.** A table-driven model: per user (their chosen factors),
   per application (what it demands), per action (step-up for sensitive operations), and per
   risk signal (new device, new IP/country, impossible travel). Give the tables and the
   evaluation order. Keep it simple enough to actually ship.

5. **Recovery, which is where every MFA system dies.** The complete matrix: lost phone, lost
   authenticator, lost passkey device, lost email access, lost everything. Include the
   recovery-phone and recovery-email the owner asked for, admin-assisted recovery and its
   audit requirement, and the cooling-off/notification rules that stop recovery becoming the
   easiest way in. State which recovery paths must NEVER be allowed to bypass MFA.

6. **Enrolment nudges without lockouts.** How to move a real user base of pub staff and
   customers onto MFA gradually: grace periods, per-role enforcement, and what an admin sees.

Finish with `## What I would get wrong first` — the three mistakes you predict.
