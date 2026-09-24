---
title: Privacy Policy
slug: privacy
summary: What Vesopa OAuth collects when you sign in, why we need each piece, who else ever sees it, and how to get it back or get rid of it.
updated: 2026-09-08
---

# Privacy Policy

Vesopa OAuth is the sign-in service at **https://auth.vesopa.com**. It exists to prove you are you, once, so that the Vesopa products you use — and any third-party app you choose to connect — do not each need their own password and their own copy of your details.

That job needs some personal data. This page says exactly which, exactly why, and exactly how to make it stop. It is written to be read, not survived.

## The short version

- We hold the minimum needed to sign you in safely: who you are, how to reach you, how to verify it is you, and a log of when it happened.
- **We do not sell your personal data. Ever.** There is no advertising on this service and no third-party analytics or tracking.
- **We do not use data received from Google — or from Apple, Microsoft or GitHub — for advertising, and we do not use it to train AI models.**
- When you sign in with Google, Apple, Microsoft or GitHub we ask for three things only: `openid`, your email address, and your basic profile. Nothing else. No contacts, no files, no calendar, no repositories.
- You can disconnect any linked provider, and you can delete your whole account, yourself, at any time.
- One email to **privacy@vesopa.com** gets you a copy of everything we hold, or gets it deleted.

## 1. Who we are

Vesopa Software Ltd is the data controller for the personal data described here. We are a company registered in the United Kingdom, company number **17362206**, registered office **Baglan, Port Talbot, SA12 7AX, Wales**.

Vesopa Software Ltd also trades as **Vesopa EPOS**. Vesopa OAuth is the identity service that sits behind those products.

| What you need | Where to write |
| --- | --- |
| Privacy questions, data requests, deletion | **privacy@vesopa.com** |
| Anything else | **info@vesopasoftware.com** |
| Security problems and vulnerability reports | **security@vesopa.com** |

All three reach a person. `privacy@vesopa.com` reaches the person responsible for data protection at Vesopa.

## 2. What Vesopa OAuth actually is

It is an identity provider. It does one thing: it authenticates people, and then tells an application "this is who just signed in".

It signs you in to:

- the **Vesopa EPOS till**, the point-of-sale software our customers run in their shops and restaurants;
- the **QR dine-in menu** at menu.vesopa.com, where a guest scans a code at a table and orders;
- the **EPOS back office**, where a business manages its menu, staff and reports;
- the **hosting control panel** at cloud.vesopa.com;
- and **applications built by third-party developers** who have registered with Vesopa OAuth.

Signing in is where our involvement ends. What an application does with your data once you have signed into it is governed by that application's own privacy policy — see section 9.

## 3. What we hold, and why we need it

We do not collect data because it might be useful one day. Each item below earns its place.

### You give us

| Data | Why we need it |
| --- | --- |
| **Name** (display name) | So an app can greet you, and so a shop's staff list is readable. |
| **Email address** | Your primary way of signing in, the address for one-time codes, and how we tell you about security events on your account. |
| **Phone number** | An alternative way to sign in, a second factor, and account recovery. |
| **Date of birth** | Only where an application needs it — for example an age-restricted item on a menu. Optional otherwise. |
| **Profile image** | Optional. It appears in the apps you sign into. |
| **Password** | Stored only as a salted, slow one-way hash. Nobody at Vesopa can read your password, including us. |

### You create by using the service

| Data | Why we need it |
| --- | --- |
| **MFA enrolment data** — which second factors you set up, and the encrypted secret for an authenticator app | So we can check a code when you sign in. |
| **Passkey public keys** (WebAuthn) | So we can verify a passkey signature. The private key never leaves your device and we never see it. |
| **IP addresses** | Security. Rate limiting, blocking attacks, and showing you where a sign-in came from. |
| **User-agent and device information** | To recognise a device you have chosen to remember, and to show you the device list in your account. |
| **Sign-in timestamps and outcomes** — including failures and the reason for them | So you can see your own sign-in history, and so we can spot someone else trying to get in. |
| **The list of applications you have connected** | So you can see them, and revoke any of them. |

That is the whole list. We do not collect location beyond what an IP address implies, we do not read your messages, and we hold no advertising identifiers because we run no advertising.

## 4. Why we are allowed to process it

Under UK GDPR every use of personal data needs a lawful basis. Ours are:

- **Performance of a contract.** Your account, your credentials, and the act of signing you in. You asked us for an account; this is what an account is.
- **Legitimate interests.** Keeping the service secure: audit logs, sign-in history, rate limiting, fraud and abuse prevention, and telling you when something happens on your account. Our interest is running a sign-in service that is not trivially broken into. Yours is not being broken into. They point the same way.
- **Legal obligation.** Where the law requires us to keep or produce a record.
- **Consent.** Optional things you switch on yourself: linking a social account, a profile image, remembering a device, and any marketing email — which we send rarely, and which you can stop in one click.

Where we rely on consent you can withdraw it at any time, and withdrawing it does not make what happened before unlawful.

## 5. Signing in with Google, Apple, Microsoft or GitHub

This is optional. If you never press one of those buttons, none of this section applies to you.

### What we ask for, and what we get back

For every provider we request the **same three narrow scopes and nothing else**: `openid`, `email`, and basic `profile`.

| Provider | What it returns to us | Why we ask for it |
| --- | --- | --- |
| **Google** | A stable Google account identifier, your email address and whether Google has verified it, your name, and your profile picture URL. | The identifier is how we recognise you next time. The email is your account address. The name and picture fill in your profile so you do not have to type them. |
| **Apple** | A stable Apple identifier, your email address (real or a private relay address — see below), and your name, which Apple sends **only on the very first sign-in**. | The same reasons. Because Apple sends the name once, we store it then or not at all. |
| **Microsoft** | A stable Microsoft account or work account identifier, your email address, and your display name. | The same reasons. |
| **GitHub** | Your GitHub user id and login name, your primary email address, your name, and your avatar URL. | The same reasons. GitHub is offered mainly for developers building on Vesopa OAuth. |

We do **not** request, and could not use if we were given: your contacts, your calendar, your files, your Drive, your photos, your email content, your repositories, or the right to post anything anywhere. If you ever see Vesopa asking for one of those, it is not us — tell security@vesopa.com.

We use what comes back only to create and maintain your Vesopa account, to sign you in, and to show you which providers you have linked.

### Google Limited Use disclosure

> **Vesopa OAuth's use and transfer of information received from Google APIs to any other app will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.**

In plain terms that means all of the following, and we mean each one literally:

- We use Google user data **only** to provide and improve the sign-in feature you asked for.
- We **do not** transfer Google user data to anyone, except where you direct us to (an app you connect), where it is necessary for security or fraud prevention, or where the law compels us.
- We **do not** use Google user data for advertising of any kind.
- We **do not** use Google user data to train, fine-tune or evaluate generalised or general-purpose AI models. No part of your account data is fed to a model.
- We **do not** allow humans to read Google user data, except with your explicit consent, to resolve a specific support problem you have raised, for security purposes, or where the law requires it — and where reading is unavoidable, on aggregated or anonymised data wherever that will do.

### Apple's private email relay

If you use Sign in with Apple and choose "Hide My Email", Apple gives us a relay address ending in `@privaterelay.appleid.com` instead of your real one. That is fine by us, and we treat it as a normal address:

- We use it for exactly what we would use any address for: one-time codes, security notices, and account email.
- We have registered our sending domain with Apple so that mail we send actually reaches you through the relay.
- We store it as your account email. We do not try to unmask it, correlate it with other addresses, or work out your real address.
- If you later turn the relay off in your Apple ID settings, mail to that address stops working. Add a normal email address or a phone number to your Vesopa account before you do that, or you may lock yourself out.
- A relay address belongs to that Apple identity. It will not be matched automatically to a Vesopa account that already exists under a different address — see the linking rule below.

### Linking, and why we do not link silently

If you sign in with a provider whose email matches an existing Vesopa account, we do **not** merge the two automatically. Anyone can create an account at some provider using an address; silently trusting that would be a way to take over somebody else's Vesopa account. We ask you to sign in with your existing credentials first and confirm the link deliberately.

### Disconnecting a provider, and what happens to the data

You can unlink any provider yourself, from **Linked accounts** in your Vesopa account area. When you do:

- We delete the link record and the provider's identifier for you, along with any access or refresh token we held for that provider. We stop being able to sign you in that way immediately.
- Profile details that came from the provider and were copied onto your Vesopa profile — your name, your picture — stay, because they are now your Vesopa profile. You can edit or clear them yourself on the profile page.
- The fact that a link existed and was removed stays in your audit log for the period in the [retention policy](/retention). A security log you can edit is not a security log.
- We keep a minimal one-way record so that provider identity can be reconnected later without being silently claimed by someone else. It holds no profile data.
- Unlinking at our end does not revoke the permission at the provider's end. To do that as well: Google — [myaccount.google.com/permissions](https://myaccount.google.com/permissions); Apple — Settings, your name, Sign in with Apple; Microsoft — [account.live.com/consent/Manage](https://account.live.com/consent/Manage); GitHub — Settings, Applications.

We will not let you unlink your **last remaining way of signing in**. If a provider is the only credential on your account, add a password, a phone number or a passkey first. This is not a trick to keep you; it is to stop you locking yourself out of your own account.

## 6. Phone numbers and SMS

If you give us a phone number we use it to send a one-time code, as a second factor, and for account recovery. UK text messages are sent through **Postcoder**, a UK provider, which receives your phone number and the message for that purpose only. We do not send marketing by SMS.

## 7. Cookies

Vesopa OAuth sets three cookies: a session cookie that keeps you signed in, a CSRF token that stops other websites submitting forms as you, and an optional "remember this device" cookie that is set **only if you tick the box**. There are no advertising cookies and no third-party analytics cookies, because we run no advertising and no third-party analytics. The detail is in the [cookie policy](/cookies).

## 8. What we never do

- **We do not sell your personal data**, to anybody, for any price. There is no arrangement under which a third party pays us for access to it.
- **We do not use your data for advertising**, ours or anyone else's, and we build no advertising or marketing profiles.
- **We do not use your personal data to train AI models**, general-purpose or otherwise.
- **We do not track you across other websites.** No third-party analytics, no pixel, no tag manager, no fingerprinting.
- We do not pass your data to data brokers.

## 9. Who else sees your data

Four categories of people, and no others.

**1. Us.** A small number of Vesopa staff, only where their job requires it, and their access is logged.

**2. The applications you sign into.** When you sign into an app through Vesopa OAuth, we tell that app who you are. Before that happens for the first time you see a consent screen naming the app and what it will receive, and you can refuse. For Vesopa's own products that means the EPOS till, the menu, the back office and the hosting panel. For a third-party developer's app, **the developer becomes an independent controller** of what they then hold, and their privacy policy governs it — not this one. You can see every connected app and revoke any of them from **Connected apps** in your account.

**3. Our sub-processors.** A short list: Google, Apple, Microsoft and GitHub as identity providers, and only when you choose them; and Postcoder for UK SMS codes. Hosting is on **Vesopa's own servers in the EU and the UK**. Each is named, with what they receive and why, in [Data processing and sub-processors](/data-processing).

**4. Anyone the law compels.** If we receive a valid legal demand we comply with it, and we tell you unless we are legally forbidden from doing so.

Nobody else. Not advertisers, not brokers, not "partners".

## 10. Where your data lives, and transfers out of the UK

Your account data is stored on Vesopa's own servers in the **EU and the UK**. We do not put it on a third-party cloud beyond that.

Two things cross a border, and only these:

- **Social sign-in**, if you choose it. Google, Apple, Microsoft and GitHub are US companies and the exchange happens with their infrastructure. This only ever happens because you pressed their button.
- **SMS delivery**, handled by Postcoder in the UK and then by mobile networks, which route messages as networks do.

Where a transfer leaves the UK we rely on the safeguards UK law recognises: an adequacy decision, or the UK Extension to the EU–US Data Privacy Framework where the recipient is certified under it, and otherwise the International Data Transfer Agreement, or the EU Standard Contractual Clauses with the UK Addendum.

## 11. How long we keep it

The short answer: audit and sign-in logs for **13 months**; account data until you delete the account, then purged within **30 days**; one-time codes and their hashes deleted within **24 hours**. The full table, and what deletion does and does not reach, is in [Data retention and deletion](/retention).

## 12. How we protect it

Passwords are stored only as salted hashes. Everything is served over HTTPS. Session cookies are HttpOnly, Secure and SameSite. Every state-changing form carries a CSRF token. Sign-in attempts are rate limited, and one-time codes are short-lived, hashed and single-use. You can add an authenticator app, SMS or a passkey as a second factor, and we recommend a passkey because it cannot be phished. The full picture is in the [security statement](/security).

No system is perfectly secure. If a breach ever puts your rights at risk we will tell the Information Commissioner's Office within 72 hours and tell you without undue delay.

## 13. Automated decisions

We run automated checks on sign-in attempts — an unfamiliar device, an unusual location, too many failures — and those checks can block an attempt or demand a second factor. That is security, not profiling, and it has no legal or similarly significant effect on you beyond having to prove it is you. If a check has locked you out unfairly, write to privacy@vesopa.com and a person will look at it.

## 14. Your rights

You have the right to a copy of your data, to have it corrected, to have it deleted, to restrict or object to what we do with it, to portability, and to withdraw consent. Exercising any of them is free, and we answer within one month. How to do it, and how to complain to the ICO if we get it wrong, is in [Your data rights](/your-data-rights).

## 15. Deleting your account

There is a route and it works:

1. Sign in at **https://auth.vesopa.com**, open your account, go to **Security**, and choose **Delete my account**. The direct link is <https://auth.vesopa.com/account/delete>.
2. We ask you to confirm, because it cannot be undone.
3. Your profile, credentials, passkeys, MFA enrolments, linked provider records and connected-app grants are deleted, and every remaining record is purged **within 30 days**.

If you cannot sign in, email **privacy@vesopa.com** from the address on the account and ask us to delete it. We will check that it is your account and then do it, within the same 30 days.

Deleting your Vesopa account signs you out of every app that used it. It does not delete data a third-party app has separately stored about you — ask that app, using the contact details in its own privacy policy. The full detail, including the few records we must keep and why, is in [Data retention and deletion](/retention).

## 16. Children

Vesopa OAuth is built for people using business software and for guests ordering in a restaurant. It is not directed at children and we do not knowingly create accounts for anyone under 16. If you believe a child has an account, write to privacy@vesopa.com and we will delete it.

## 17. Changes to this policy

We update this page when the service changes. The date at the top is always the current version. Where a change materially affects how we use your data we will tell you by email before it takes effect, rather than quietly editing the page.

## 18. Complaints

Come to us first, at **privacy@vesopa.com**. Most problems are a misunderstanding we can fix the same day.

If you are still unhappy you can complain to the Information Commissioner's Office, the UK supervisory authority, at [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint) or on 0303 123 1113. You do not have to come to us first, though we would rather you did.

> **Information Commissioner's Office**
> Wycliffe House, Water Lane, Wilmslow, Cheshire SK9 5AF
> 0303 123 1113 · [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint)

You can complain to the ICO without asking us first. We would rather you gave us the chance, but it is your right either way.
