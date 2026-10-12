# Pontardawe RFC: everything Google Play asks for

Package: `com.vesopaepos.pontardawerfc`. The listing text itself (name, short
and full description) is in `listing.md`; the pictures are in this folder.
This page is every other box in Play Console, in the order Play shows them,
with the answer to give. (Written 2026-10-12.)

## Main store listing (Grow users > Store presence > Main store listing)

| Field | Answer |
|---|---|
| App name | Pontardawe RFC |
| Short description | Your Pontardawe RFC membership card, members' discount and club news. |
| Full description | The "Full description" in `listing.md` |
| App icon | `play-icon-512.png` (512x512, the crest on transparent) |
| Feature graphic | `play-feature-graphic-1024x500.png` |
| Phone screenshots | `screenshots/android-phone/` (1080x1920 and up, 2 to 8) |
| 7-inch tablet screenshots | `screenshots/android-tablet-7/` |
| 10-inch tablet screenshots | `screenshots/android-tablet-10/` |
| Wear OS screenshots | `screenshots/wear-os/` (only once the Wear OS form factor is added, below) |
| Video | none |

## Store settings (Grow users > Store presence > Store settings)

| Field | Answer |
|---|---|
| App or game | App |
| Category | Lifestyle |
| Tags | Sports, Membership, Rewards & loyalty (pick the closest Play offers) |
| Email address | info@vesopasoftware.com |
| Phone | leave blank |
| Website | https://pontardawerfc.com/ |
| External marketing | On |

## App content (Policy and programmes > App content)

**Privacy policy:** https://pontardawerfc.com/privacy

**App access:** "All or some functionality is restricted". Add instructions:
- Name: Members' sign-in
- Username: test@test.com
- Password: 123456
- Any other information: "On the sign-in screen tap Use a password, then enter the email address and password. The account is a test member of the club with sample visits, points and news."

**Ads:** No, the app does not contain ads.

**Content rating:** start the IARC questionnaire, category "All other app types".
Answer No to violence, sexuality, language, controlled substances, gambling,
user-generated content shared between users, and location sharing with other
users. Two to note:
- "Does the app reference or depict alcohol?" The club bar's purchases can show
  drink names in Activity. Answer Yes to "references to alcohol" only if Play's
  wording covers a receipt line; otherwise No. Expected rating: PEGI 3 / Everyone,
  or PEGI 12 / Teen if alcohol is ticked. Either is fine.
- "Does the app share the user's current physical location with other users?" No.

**Target audience and content:** 18 and over only (a members' club with a bar;
choosing 18+ keeps the app out of the Families programme). "Could the app
unintentionally appeal to children?" No.

**News app:** No (club news is a feature, not the app's purpose).

**COVID-19, government, financial features, health:** No / not applicable to each.

**Advertising ID:** No, the app does not use an advertising ID. (Firebase is
used only to deliver notifications; no analytics or ads SDK is included.)

**Data safety:** collected, none shared with third parties, all encrypted in
transit, users can ask for deletion.

| Data type | Collected | Optional? | Purposes |
|---|---|---|---|
| Personal info: Name | Yes | Required | App functionality, Account management |
| Personal info: Email address | Yes | Required | App functionality, Account management |
| Personal info: Phone number | Yes | Optional | App functionality, Account management |
| Personal info: User IDs (member and card number) | Yes | Required | App functionality, Account management |
| Financial info: Purchase history (spend at the club) | Yes | Required | App functionality |
| Photos | Yes | Optional (member photo) | App functionality |
| Location: Approximate and Precise | Yes, processed on the device and compared with the club's, not stored | Optional | App functionality |
| Device or other IDs (the notification token) | Yes | Required for notifications | App functionality |
| App activity: App interactions (the app's activity log) | Yes | Required | Analytics, App functionality |
| App info and performance: Crash logs, Diagnostics | Yes | Required | App functionality |

- "Is all of the user data collected by your app encrypted in transit?" Yes.
- "Do you provide a way for users to request that their data is deleted?" Yes.
- Delete account URL: https://auth.vesopa.com/delete-account/pontardawe-rfc

**Government apps:** No.

## Advanced settings > Form factors

Add **Wear OS** to ship the watch app on this listing. Then upload the Wear
bundle as its own release on the Wear OS track (it has its own version code).
Tablets need no separate form factor: the phone bundle covers them.

## Releases

Internal testing first (already running), then Closed or Open testing, then
Production. Release notes for 1.2.0:

```
<en-GB>
New look with the club crest, a welcome tour, and your photo cropped how you like it.
Settings for dark or light mode, screen brightness on your card, and notifications.
Your card on your Wear OS watch, and in Apple Wallet on iPhone.
</en-GB>
```
