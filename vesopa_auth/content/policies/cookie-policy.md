---
title: Cookie Policy
slug: cookies
summary: The three cookies Vesopa OAuth sets, what each one does, how long it lasts, and why there is no cookie banner asking you to accept tracking.
updated: 2026-09-08
---

# Cookie Policy

Vesopa OAuth sets three cookies. All three exist to sign you in and keep that sign-in safe. There are no advertising cookies, no third-party analytics cookies, and no tracking of any kind.

That is the whole policy. The rest of this page is the detail behind it.

## What a cookie is here

A cookie is a small piece of text your browser stores for a website and sends back on the next request. Without one, a website cannot tell that the person asking for the second page is the same person who signed in on the first. That is precisely the problem a sign-in service has to solve, which is why we use cookies at all.

## The cookies we set

All three are set on **auth.vesopa.com** by us. None of them is readable by another website.

| Cookie | What it does | When it is set | How long it lasts | Type |
| --- | --- | --- | --- | --- |
| **Session / SSO cookie** | Keeps you signed in and makes the second Vesopa app you open a one-click sign-in instead of a second password. It holds a random session identifier and nothing else — no name, no email, nothing readable. | When you sign in. | Until you sign out, or the session expires through inactivity. It is deleted when you close the browser unless you asked us to remember the device. | Strictly necessary |
| **CSRF token cookie** | Stops another website from making your browser submit a form to us while you are signed in — changing your password, say, or linking an account. Every form we serve carries a matching token, and we reject anything where the two do not agree. | On first visit to the sign-in page. | The length of the session. | Strictly necessary |
| **"Remember this device" cookie** | Lets you skip signing in from scratch on a device you use often, and lets us recognise that device rather than treating it as a stranger. | **Only if you tick the box.** Never by default, never silently. | Deliberately long-lived, so it survives closing the browser. It ends when you sign out on that device, when you remove the device from **Devices** in your account, when you change your password, or when it expires. | Set by your explicit choice |

Technical settings, for anyone who wants them: all three are `Secure` (sent only over HTTPS), the session and remember-device cookies are `HttpOnly` (JavaScript cannot read them), and all three carry a `SameSite` attribute that stops them being sent along with cross-site requests.

The remember-device cookie is not a permanent key to your account. It is tied to a device record we hold, and that record can be revoked from your account page at any moment. Revoking it makes the cookie useless immediately, even if it is still sitting in the browser.

## What we do not set

- **No advertising cookies.** We run no advertising.
- **No third-party analytics cookies.** No Google Analytics, no tag manager, no marketing pixel, no session recorder.
- **No cross-site tracking.** We have no interest in what you do on other websites and no mechanism for finding out.
- **No fingerprinting.** We record your user-agent and IP address as part of the sign-in log, which is a security record, not a tracking profile — see the [privacy policy](/privacy).

If you find a cookie on auth.vesopa.com that is not in the table above, that is a bug or worse. Tell **security@vesopa.com** and we will want to know quickly.

## Cookies set by other people

If you choose to sign in with Google, Apple, Microsoft or GitHub, your browser goes to that provider's own website to do it. That provider will set its own cookies on its own domain, under its own policy. We do not control those and cannot read them.

We only send you there when you press the button.

## Why there is no cookie banner

Under UK law (PECR) you must be asked before cookies are set, unless a cookie is strictly necessary for a service you have asked for. Ours are: two are required to sign you in and keep the session safe, and the third is set only when you tick a box, which is a clearer act of consent than dismissing a banner. There is nothing left to ask you about, so we do not interrupt you to ask it.

If we ever wanted to add a cookie that was not strictly necessary, we would ask first, properly, and "no" would be as easy to press as "yes".

## Controlling cookies yourself

Every browser lets you see, block and delete cookies, usually under Settings, Privacy. You can also open the sign-in page in a private window, which throws everything away when you close it.

One honest warning: **blocking the session and CSRF cookies means you cannot sign in.** They are not optional extras; they are the mechanism. Blocking only the remember-device cookie costs you nothing except having to sign in each time, which some people prefer.

## Do Not Track and Global Privacy Control

We do not track you, so there is nothing for these signals to switch off. We honour them by having built nothing that needs to be honoured.

## Changes

If the cookies change, this table changes with them, and the date at the top changes too.

## Contact

Questions about this page: **privacy@vesopa.com**. Anything else: **info@vesopasoftware.com**.
