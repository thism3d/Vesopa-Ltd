---
title: Data Processing and Sub-processors
slug: data-processing
summary: Who is the controller and who is the processor in each situation, the complete list of sub-processors we use, and what each of them receives.
updated: 2026-09-08
---

# Data Processing and Sub-processors

This page is for anyone who needs the formal picture: a business using Vesopa products, a developer building on Vesopa OAuth, or a person who simply wants the complete list of companies that ever touch their data.

The list is short, and that is deliberate. Every name on it is one more place your data can go wrong, so we add names reluctantly.

## 1. Who is the controller

"Controller" means the organisation that decides why and how personal data is used. "Processor" means one that only acts on the controller's instructions. Which one we are depends on what is happening.

| Situation | Controller | Processor | Notes |
| --- | --- | --- | --- |
| Your Vesopa account itself — credentials, profile, MFA, sign-in logs | **Vesopa Software Ltd** | — | We decide what an account needs and how to secure it, so this is ours to answer for. The [privacy policy](/privacy) is the controller notice for it. |
| Signing you into a **Vesopa product** (EPOS till, menu, back office, hosting panel) | **Vesopa Software Ltd** | — | Same account, same controller. |
| Signing you into a **third-party developer's application** | Vesopa (for the identity data we hold) and the **developer** (for what their application does with what it receives) | — | Two independent controllers, each answering for their own part. We are not their processor, and they are not ours. |
| A **business customer's** own data inside a Vesopa product we host or run for them — their staff records, their customers' orders | The **business customer** | **Vesopa Software Ltd** | We act on their instructions. Their privacy policy governs it, and a data processing agreement is available from privacy@vesopa.com. |

The distinction matters when you want something done. For your Vesopa account, come to us. For what an app did with your data after you signed in, go to the app — and if you cannot find them, we will help you.

## 2. Sub-processors

These are the only third parties that ever receive personal data from Vesopa OAuth.

### Identity providers — only when you choose them

| Sub-processor | What it does | What it receives | Where |
| --- | --- | --- | --- |
| **Google** | Sign in with Google | The fact that a sign-in was requested, and whatever your browser and Google exchange to complete it. Google returns your Google id, email, name and picture to us. | United States and Google's global infrastructure |
| **Apple** | Sign in with Apple | The same, for Apple. Apple returns your Apple id, an email address (real or a private relay address), and your name on first sign-in only. | United States and Apple's global infrastructure |
| **Microsoft** | Sign in with Microsoft | The same, for Microsoft. Microsoft returns your Microsoft id, email and display name. | United States and Microsoft's global infrastructure |
| **GitHub** | Sign in with GitHub | The same, for GitHub. GitHub returns your user id, login, email, name and avatar. | United States |

**None of these is used unless you press that provider's button.** If you sign in with an email address or a phone number, no data reaches any of them. Each acts as a controller in its own right for the account you hold with it, under its own privacy policy.

We request the same three scopes everywhere — `openid`, `email`, basic `profile` — and nothing else. Details are in the [privacy policy](/privacy).

### Message delivery

| Sub-processor | What it does | What it receives | Where |
| --- | --- | --- | --- |
| **Postcoder** | Sends UK SMS one-time codes | Your phone number and the code message | United Kingdom |

Postcoder receives your phone number for the purpose of delivering that message, and for nothing else. Mobile networks then carry the message, as networks do.

### Hosting

Vesopa OAuth runs on **Vesopa's own servers in the EU and the UK**. There is no third-party cloud provider holding your account data. This is why the list above is as short as it is.

### That is the complete list

There is no analytics provider, no advertising network, no marketing platform, no data enrichment service, no AI vendor, and no data broker. If a company is not named above, it does not receive personal data from Vesopa OAuth.

## 3. How we choose a sub-processor

Before anyone joins the list we look at what they would actually receive (and try to make it less), where they hold it, what their security is like, what their contract says about using data for their own purposes, and what happens to the data when we stop using them. We prefer a supplier in the UK or the EU, and we prefer no supplier at all.

Each sub-processor is engaged under a written contract that requires appropriate security and restricts them to acting on our instructions, except for the identity providers, which act as controllers in their own right for the accounts you hold with them.

## 4. Changes to this list

We will publish a change here, and update the date at the top, **at least 30 days before** a new sub-processor starts processing personal data — unless the change is urgent and necessary for security, in which case we publish it as soon as we can.

Business customers with a data processing agreement can ask to be notified by email of changes: write to **privacy@vesopa.com** and we will add you to that list. If you object to a new sub-processor on reasonable data protection grounds, tell us and we will discuss it with you before it goes live.

## 5. International transfers

Account data stays on our servers in the EU and the UK. Two things cross a border:

- **Social sign-in**, if you use it. The providers above are US companies.
- **SMS**, which goes through Postcoder in the UK and then across mobile networks.

Where a transfer leaves the UK we rely on the safeguards UK law recognises: an adequacy decision, or the UK Extension to the EU–US Data Privacy Framework where the recipient is certified under it, and otherwise the International Data Transfer Agreement or the EU Standard Contractual Clauses with the UK Addendum. We keep a record of which applies to which supplier and will show it to a business customer who asks.

## 6. What we do as a processor

Where we act as a processor for a business customer, we commit to the following, and a full data processing agreement is available on request from privacy@vesopa.com:

- We process personal data only on the customer's documented instructions, including on transfers, unless the law requires otherwise — and then we tell them, unless the law forbids that too.
- Everyone with access is bound by confidentiality.
- We apply the technical and organisational measures described in the [security statement](/security).
- We do not engage a new sub-processor without the notice described in section 4.
- We help the customer respond to data subject requests, and with data protection impact assessments and consultations, so far as we reasonably can.
- We notify the customer **without undue delay** after becoming aware of a personal data breach affecting their data, with what we know at the time and more as we learn it.
- On request at the end of the relationship we delete or return the personal data, subject to what the law makes us keep.
- We make available the information needed to demonstrate compliance, and allow audits on reasonable notice and reasonable terms.

## 7. Security measures

Rather than repeat them here, they are set out in full in the [security statement](/security): encryption in transit, hashed passwords, hashed and short-lived one-time codes, MFA including passkeys, CSRF protection, rate limiting, audit logging, restricted production access, tested backups, and our incident procedure.

We do not currently hold ISO 27001, SOC 2 or PCI DSS certification, and we will not claim otherwise on a form.

## 8. Retention

Set out in [Data retention and deletion](/retention). In brief: audit and sign-in logs for 13 months, account data until the account is deleted and then purged within 30 days, one-time codes and their hashes within 24 hours.

## 9. Contact

For a data processing agreement, a sub-processor notification list, a transfer record, or a security questionnaire: **privacy@vesopa.com**.

Vesopa Software Ltd, company number **17362206**, registered office **Baglan, Port Talbot, SA12 7AX, Wales**.
