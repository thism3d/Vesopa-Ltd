---
title: Data Retention and Deletion
slug: retention
summary: How long Vesopa OAuth keeps each kind of data and why, what happens when you delete your account, and the few things that survive it.
updated: 2026-09-08
---

# Data Retention and Deletion

Data you no longer need is not an asset. It is a liability sitting on a disk waiting to be stolen. So we keep things for as long as they do a job, and then we get rid of them.

Three numbers cover most of it:

- **13 months** — audit and sign-in logs.
- **30 days** — the outside limit for purging everything after you delete your account.
- **24 hours** — one-time codes and their hashes, which usually go much sooner.

## 1. The full table

| What | How long we keep it | Why that long |
| --- | --- | --- |
| **Profile** — name, email address, phone number, date of birth, profile image | Until you delete the account, then purged within **30 days** | It is your account. It exists while the account exists. |
| **Password hash** | Until you change it or delete the account | We store only a salted, slow one-way hash, and we do not keep old ones after a change. |
| **MFA enrolments** — authenticator app secret (encrypted), enrolled phone number, passkey public keys | Until you remove the factor, or delete the account | Needed to check your second factor. Removing a factor removes its record. |
| **Recovery codes** | Until used, regenerated, or the account is deleted | Stored hashed and single-use. Generating a new set destroys the old one. |
| **One-time codes** — emailed codes, SMS codes and their hashes | Deleted within **24 hours** | They are valid for minutes. Keeping them any longer serves nobody and creates a target. In practice they are cleared shortly after use or expiry; 24 hours is the outer limit. |
| **Sessions** | Until you sign out, or the session expires through inactivity | It is what keeps you signed in. |
| **Remembered devices** | Until you sign out on that device, revoke it, change your password, or it expires | You can see and end every one of them from your account. |
| **Audit and sign-in logs** — timestamps, outcomes and reasons, IP addresses, user-agent and device information, security events such as a password change or a provider being linked | **13 months** | Long enough to investigate something noticed a year later and to compare a period against the same period last year. Beyond that the risk of holding it outweighs what it tells us. |
| **Connected application grants** | Until you revoke the application, or delete the account | It is the record of what you consented to, and what you can withdraw. |
| **Linked provider records** — Google, Apple, Microsoft, GitHub | Until you unlink | Unlinking deletes the identifier and any token we held. See section 5. |
| **Support correspondence** | While the matter is open, and a reasonable period afterwards so we can show what we told you | Then deleted. |
| **Records the law requires** — for example financial records where you have paid us for something | For the period the law sets | We have no choice, and neither do you. |

## 2. What happens when you delete your account

You can start it yourself: sign in at **https://auth.vesopa.com**, open your account, go to **Security**, and choose **Delete my account**. The direct link is <https://auth.vesopa.com/account/delete>. If you cannot sign in, email **privacy@vesopa.com** from the address on the account.

**Straight away:**

- Every session ends and every remembered device stops working. You are signed out everywhere.
- Every connected application's access is revoked. We stop telling any of them anything about you.
- Your credentials stop working — password, passkeys, MFA factors, linked providers.
- Your profile stops being visible to any application.

**Within 30 days:**

- Your profile, password hash, MFA enrolments, passkey public keys, recovery codes, sessions, device records, connected-app grants and linked provider records are permanently deleted.
- Personal identifiers are removed from audit and sign-in log entries, leaving only what a security log needs to remain useful.

We give ourselves 30 days rather than claiming "instantly" because purges run on a schedule and because a deletion that has to be reversed for fraud reasons is better caught inside a window than never. In practice most of it goes in the first pass.

## 3. What survives deletion, and why

Only two things, and neither of them is a profile of you.

**Minimised audit records.** Security log entries reach their 13-month expiry on their own schedule and then go. Until then they are stripped back — enough to show that an event happened, not enough to identify you. We cannot let deleting an account erase the evidence of what that account did, or account deletion becomes the last step of every attack.

**Records the law makes us keep.** If you have paid us for something, financial records have their own statutory life. If we are subject to a legal hold or an ongoing investigation, we keep what it covers until it ends, and then we delete it.

That is all. There is no shadow copy, no marketing list you are quietly moved to, no "deactivated" state that keeps everything in case you come back.

## 4. Backups

Backups exist so that a failed disk does not cost you your account. They roll over on a fixed schedule and are overwritten in the ordinary course.

A record you deleted may sit in an unrestored backup until that backup is overwritten. It is not accessible in the running service, and we do not restore a backup in order to bring a deleted account back. If we ever restore one for an unrelated reason, we re-apply outstanding deletions afterwards.

## 5. Deleting things without deleting the account

Most of the time you want to remove one thing, not everything. All of these are self-service:

| To remove | Where | What happens |
| --- | --- | --- |
| A linked Google, Apple, Microsoft or GitHub account | Linked accounts | The identifier and any token we held are deleted. Profile details already copied to your Vesopa profile stay, and you can edit them. The audit entry stays for its 13 months. |
| A passkey | Security | Its public key is deleted. Delete it at your device's end too, or it will keep offering itself. |
| An authenticator app or an SMS factor | Security | The enrolment and any encrypted secret are deleted. |
| A remembered device | Devices | The device record is revoked and its cookie stops working immediately, even if it is still in that browser. |
| A connected application | Connected apps | Its access is revoked. We stop telling it anything. It may still hold what it received — ask that application to delete it. |
| Your profile image, date of birth, display name | Profile | Edited or cleared on the spot. |
| Your phone number or email address | Profile | Removed, provided you still have another way to sign in. |

We will not let you remove your **last remaining way of signing in**. Add another credential first.

## 6. Inactive accounts

We do not currently delete accounts for inactivity. A till account used twice a year is still someone's till account. If we ever introduce an inactivity rule, we will publish it here and warn you by email, more than once, before anything is deleted.

## 7. Applications you connected

Deleting your Vesopa account stops us sending anything further to any application. It does not reach into a third-party application and delete what it already stored — we have no such power, and an identity provider that did would be a worse thing than one that does not.

Ask the application directly, using the contact details in its own privacy policy. If you cannot find them, write to **privacy@vesopa.com** with the application name and we will point you at the operator.

For Vesopa's own products, deletion of your identity is handled together with the data those products hold about you.

## 8. Asking us instead

You do not have to use the self-service route. Email **privacy@vesopa.com** from the address on the account and ask for deletion, and we will do it. We will check it is your account first, which is an identity check rather than an obstacle — anyone able to delete someone else's account by asking would be a serious flaw.

We confirm when it is done, and we answer within one month at the latest. It costs nothing.

## 9. Changes

If a retention period changes, this table changes with it and the date at the top changes too.
