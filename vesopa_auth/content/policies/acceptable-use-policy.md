---
title: Acceptable Use Policy
slug: acceptable-use
summary: What you must not do with Vesopa OAuth, what happens if you do it, and the rules for security researchers who want to test us.
updated: 2026-09-08
---

# Acceptable Use Policy

A sign-in service is a target. If someone breaks it, or abuses it, the damage lands on ordinary people who just wanted to order a coffee or open a till. That is the whole reason this page exists.

This policy applies to everyone who touches Vesopa OAuth: people with an account, developers who have registered an application, and anyone else sending us traffic. It forms part of the [Terms of Service](/terms).

## The short version

Do not attack the service. Do not use it to deceive people. Do not use our email or SMS routes to send things nobody asked for. Do not hoover up other people's data. If you break something and tell us honestly, we will work with you.

## 1. Do not attack the service

Do not:

- try to access an account, an application or data that is not yours;
- guess, stuff or brute-force credentials, including trying stolen username and password lists against our sign-in page;
- work around rate limits, lockouts, CAPTCHA or any other protection, including by rotating IP addresses or accounts to do it;
- flood the service, or any part of it, to degrade it for other people;
- interfere with tokens, cookies, redirect URIs or the consent screen in an attempt to make the service issue credentials it should not;
- upload or distribute malware through anything we provide;
- probe or scan our systems, except under the security research rules in section 7.

## 2. Do not abuse the code and message routes

One-time codes cost real money to send and are a favourite tool of fraudsters.

Do not:

- request one-time codes in bulk, or for numbers and addresses that are not yours;
- use our SMS or email as a delivery route for anything other than signing into your own account — no messaging, no marketing, no notifications;
- run traffic-pumping schemes, where numbers are chosen to generate revenue for the network carrying the message;
- ask another person for a code we sent them. We will never ask you for one either. Anyone who does is trying to take your account.

## 3. Do not impersonate or phish

Do not:

- register an application that pretends to be Vesopa, or another brand, or a person;
- copy our sign-in page, or build anything that looks like it, to collect Vesopa credentials;
- ask a user to type a Vesopa password, one-time code or recovery code into your own interface — the entire point of OAuth is that they never have to;
- use our name, logo or domain in a way that suggests we made, approved or endorsed your product when we have not;
- write a consent screen or an app description that misdescribes what your application does with the data.

## 4. Do not misuse accounts

Do not:

- create accounts in bulk, or with false details, or automatically;
- create accounts to evade a suspension;
- sell, rent, or transfer an account, or share one to get round a per-user limit;
- use somebody else's account, with or without their permission, where that is a way round our rules.

## 5. Do not harvest data

Do not:

- enumerate users — probing the service to discover which email addresses or phone numbers have accounts;
- scrape, crawl or automatically extract personal data from any page or endpoint;
- collect data through our API beyond what the user consented to at the consent screen, or use it for a purpose you did not tell them about;
- sell, rent or broker personal data you obtained through Vesopa OAuth, or pass it to a data broker;
- use it to build advertising profiles, or to train AI models, unless the user has separately and specifically agreed to that.

## 6. Do not use the service for unlawful or harmful purposes

Do not use Vesopa OAuth in connection with fraud, money laundering, harassment, stalking, threats, the sexual exploitation or abuse of children, the distribution of unlawful material, sanctions evasion, or anything else that is a criminal offence in the United Kingdom.

We report child sexual abuse material and credible threats to life to the authorities, immediately, without warning the account holder.

## 7. Security research

We would rather you found a problem than someone else did. If you follow these rules, we will not pursue legal action against you for your research, and we will work with you on a fix.

**You may:**

- test against your own account, or an account you have created for the purpose;
- report anything you find to **security@vesopa.com**, with enough detail to reproduce it;
- take the minimum action needed to demonstrate a problem, and stop there.

**You must not:**

- access, modify, download or keep another person's data — if you stumble into it, stop, and say so in your report;
- run denial-of-service tests, load tests or automated scanning that degrades the service for anyone else;
- social-engineer Vesopa staff, customers or suppliers, or attack our physical premises;
- plant a backdoor, leave test accounts or data behind, or change anything you did not have to;
- publish the details before we have had a reasonable chance to fix it. Tell us, give us time, and we will agree a date with you.

We aim to acknowledge a report within two working days and to keep you informed while we fix it. We do not currently run a paid bug bounty, and we will not imply that we do — but we will credit you if you would like us to.

## 8. What happens if you break these rules

We match the response to the harm. In rough order:

1. **We rate limit or block** the traffic causing the problem, often automatically and immediately.
2. **We warn you** and ask you to fix it, where there is a plausible innocent explanation and no ongoing harm.
3. **We suspend** the account or the application, so it stops while we work out what happened.
4. **We terminate** the account or remove the application.
5. **We report it** to the police, to the ICO, or to an identity provider whose rules were also broken, where the conduct warrants it.

Where the harm is immediate — an attack in progress, an application harvesting user data, a phishing clone — we act first and explain afterwards.

We may also preserve evidence, including logs that would otherwise have been deleted on schedule, where we need it for an investigation or a legal claim.

## 9. Appeals

If you think we have got it wrong, write to **info@vesopasoftware.com** with the account or application name and what you think happened. A person reads it. If we made a mistake we will say so and put it back.

## 10. Reporting abuse

- Vulnerabilities, attacks in progress, phishing pages, anything security-shaped: **security@vesopa.com**
- Any other misuse of the service: **info@vesopasoftware.com**
- Something about your own data: **privacy@vesopa.com**

Tell us what you saw, when, and where. Screenshots and URLs help more than adjectives.

## 11. Changes

We update this policy as new kinds of abuse appear, which they do. The date at the top is the current version.
