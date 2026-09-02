# Apple Wallet push updates — what shipped, and how to verify it on Windows

Deployed to `backoffice.vesopaepos.com` on **2026-09-02**, commit `6a01d42`.
Repo: `Vesopa-Ltd` (`main`). No other tenant on the box was touched; only
`vesopa_backoffice` was restarted.

---

## 1. What changed

Two separate things went out together.

### The sign-up bug you hit

`https://backoffice.vesopaepos.com/wallet/join/vesopa-kitchen` handed an iPhone a
**`.json` file to download** instead of a card.

The live server has Apple Wallet fully configured and **no `GOOGLE_WALLET_*`
keys at all**. The join route minted the Google pass first, `mint()` raised a
503, the global error handler answered `res.json({error})`, and iOS downloaded
that. Your customer account was created *before* the failure, so scanning again
produced the same file every time.

Fixed: the two platforms now fail independently. Google is minted best-effort,
Apple is offered whenever the server can sign, and a badge only appears when the
platform behind it can actually deliver. Old QR codes landing on `/wallet/s/`
fall back to Apple too — but only for devices that can open a `.pkpass`, because
the two routes hand devices to each other and an unconditional fallback would
bounce an Android between them forever.

### Push updates for passes already in a wallet

A card in somebody's pocket can now change by itself. No app on their phone, and
none needed — Wallet does all of it.

There is **no `.p8`, no Key ID, and no App ID**. A Pass Type ID certificate is
its own APNs client certificate, so the five `.p12` bundles already on the server
both sign passes and authenticate the push.

---

## 2. Verify it on your iPhone (5 minutes)

### Step 1 — sign up, and get a card

Open on the iPhone:

```
https://backoffice.vesopaepos.com/wallet/join/vesopa-kitchen
```

Fill the form. **Expected:** a page saying "You're in" with an *Add to Apple
Wallet* badge and **no Google badge** (Google isn't configured, so offering it
would be a button that leads to an error).

Tap the badge. The pass should open in Wallet and add.

> **If a `.json` downloads again** — you are on a cached page. Close the Safari
> tab and reopen the link.

### Step 2 — confirm the phone registered itself

This is the step that proves push will work. In the back office, or by URL:

```
https://backoffice.vesopaepos.com/api/wallet/apple/status
```

Look for:

```json
{
  "push_updates": true,
  "web_service_url": "https://backoffice.vesopaepos.com",
  "devices_registered": 1,
  "devices_failing": 0
}
```

`devices_registered` should become **1** within a few seconds of adding the card.

> **Zero is the diagnosis, not a delay.** It means iOS never reached the update
> service. Check that `https://backoffice.vesopaepos.com` is publicly reachable
> with a valid certificate — iOS refuses to talk to it otherwise and reports
> nothing when it won't.

### Step 3 — make the card change by itself

Put the phone down with the card visible. In the back office, add or remove
loyalty points for that customer.

**Expected:** the points on the card in Wallet change within a few seconds,
without touching the phone.

### Step 4 — force a push if it doesn't

```
POST https://backoffice.vesopaepos.com/api/wallet/apple/loyalty/<customerId>/push
```

Needs your back office session. This runs the same code a sale runs, but keeps
the result instead of discarding it, and reports per device:

```json
{ "pushed": 1, "failed": 0, "forgotten": 0,
  "devices": [ { "device_id": "...", "last_push_at": "...", "last_error": null } ] }
```

---

## 3. When it fails, these three places speak

This feature's whole failure mode is silence — no app, no client log, no error
on the phone. Three places now talk:

| Where | What it tells you |
|---|---|
| Server log (`./deploy.sh --logs`) | iOS's own complaints, arriving at `/v1/log`. "Authentication failed", "invalid pass". The only channel the phone has. |
| `epos_wallet_devices.last_error` | APNs' rejection for that device, written when it happened. |
| `/api/wallet/apple/status` | Registered and failing device counts for the venue. |

### Reading the common APNs reasons

| Reason | Means |
|---|---|
| `BadDeviceToken` | Token is dead, or you're pointed at the sandbox host. The device row is deleted automatically. |
| `Unregistered` | The holder deleted the pass. Row deleted automatically. |
| `TopicDisallowed` | The certificate on the connection doesn't match the pass type. |
| `TooManyRequests`, `ServiceUnavailable` | Weather. The device is kept and retried next time. |

---

## 4. The one setting that cannot be fixed afterwards

```
APPLE_WALLET_WEB_SERVICE_URL=https://backoffice.vesopaepos.com
```

An **origin, no path, no trailing slash**. iOS appends `/v1/...` itself.

It is written **into each pass at the moment it is issued**, and a pass in a
wallet is permanent. Every card issued while this value was wrong will keep
asking the wrong URL forever, and the only repair is to reissue that card to that
customer. It is set correctly on live now — don't change it without understanding
that every existing card keeps the old one.

Blanking it later does **not** stop already-issued cards from calling, which is
why the `/v1/...` routes stay mounted whether or not push is switched on.

---

## 5. Endpoint smoke test (works from Windows PowerShell)

Copy-paste; all four should match:

```powershell
# 200 - iOS's log channel
curl.exe -s -o NUL -w "%{http_code} expect 200`n" -X POST `
  https://backoffice.vesopaepos.com/v1/log `
  -H "Content-Type: application/json" -d "{\"logs\":[\"test\"]}"

# 401 - a pass cannot be fetched without its token
curl.exe -s -o NUL -w "%{http_code} expect 401`n" `
  https://backoffice.vesopaepos.com/v1/passes/pass.com.vesopa.loyalty/nope

# 204 - an unknown device is told nothing changed
curl.exe -s -o NUL -w "%{http_code} expect 204`n" `
  "https://backoffice.vesopaepos.com/v1/devices/TEST/registrations/pass.com.vesopa.loyalty?passesUpdatedSince=0"

# 200 text/html - the sign-up page (NOT application/json)
curl.exe -s -o NUL -w "%{http_code} %{content_type} expect 200 text/html`n" `
  https://backoffice.vesopaepos.com/wallet/join/vesopa-kitchen
```

All four were verified green on live at deploy time.

---

## 6. Files, if you need to read the code

| File | What it holds |
|---|---|
| `vesopa_server/src/wallet_apple_push.js` | The APNs client. HTTP/2, TLS client cert, empty payload. |
| `vesopa_server/src/wallet_apple_webservice.js` | The five endpoints iOS calls. |
| `vesopa_server/src/wallet_apple.js` | Pass building and signing. `pemForKind()` feeds the push client. |
| `vesopa_server/src/wallet.js` | The join flow and the Google half. |
| `vesopa_server/schema_wallet_apple_push.sql` | `apple_updated_at`, `last_push_at`, `last_error`. |
| `vesopa_server/test/wallet-apple-push.test.js` | 23 checks. `npm test` runs them. |

---

## 7. What the card looks like now

Verified on live, by pulling real `.pkpass` files off the server and opening
them:

| | Loyalty | Gift card | Promo |
|---|---|---|---|
| Header | `NEXT REWARD · 55 to go` | `GIFT CARD · ···· PH37` | `ENDS IN` |
| Primary | `POINTS · 45` | `BALANCE · £30.00` | `OFFER · 20% OFF` |
| Secondary | Member, tier | `of £60.00` loaded, for | `WHEN · Every day, 5pm–7pm` |
| Auxiliary | `MEMBER NO. · VK · 0001` | — | — |
| Strip | banded to 50% | plain | plain |

All five kinds are `eventTicket` with `groupingIdentifier: venue:vesopa-kitchen`,
so a venue's cards collapse into one stack. `logoText` is the venue's name.

**The progress bar is an image, not a field.** PassKit has fields and images and
nothing in between, and the server has no image codec. `tools/wallet_art` renders
eleven states at build time (`strip_loyalty_p000` … `p100`) and the server picks
the nearest — 45 points against a 100 floor served `p050`. Each pass still ships
one strip at the size it always did.

The other three decorations the design asked for — the tier chip, the gift-card
spend bar, the staff initials disc — restate text already on the card, so they
are fields rather than per-customer images.

## 8. Still outstanding

- **Staff and promo cards don't push.** Only loyalty points and gift-card
  balances trigger one. Those two change during a sale; staff and promo change
  from back office edits and need a hook in a different file.
- **Google Wallet is not configured on live.** Every Android customer currently
  gets no card at all. The sign-up no longer breaks because of it, but they still
  leave empty-handed. Needs `GOOGLE_WALLET_ISSUER_ID` and a service account.
- **Staff `SHIFT` and `AUTHORISES`** have no data model — there is no roster
  table and no permissions model to read. Unlike `NEXT REWARD`, which turned out
  to have had its data in `epos_loyalty_settings` all along, these two genuinely
  do not exist yet.
- **`featuredActions` is unverified against a real iOS 27 device.** It ships
  because older iOS ignores the key, and the same link is also a tappable back
  field so the pages work today. `APPLE_WALLET_FEATURED_ACTIONS=off` stops the
  tiles if a pass ever fails to install.
- **Venue photographs** still cannot reach an Apple strip: `photo_url` is stored
  and feeds Google, but Apple needs bytes at an exact size and the resize has to
  happen somewhere. The back office cropper already does this in a browser
  canvas, which is the likely home.

---

## 8. Rotate these

- The **root password** for `3.72.113.21` was shared in plain text on 2026-09-02.
- `vesopa_server/.env.local` is in `vesopa_backoffice`'s git **history** with
  `DB_PASSWORD`, `JWT_SECRET` and `DOJO_API_KEY`. Removing it from the current
  commit did not remove it from past ones. `DOJO_API_KEY` first — it's the
  payment one.
