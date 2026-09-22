# Vesopa EPOS 1.6.2 — release notes

Store submission: `msix_version: 1.6.2.0` (previous build here was 1.6.1.0).
Flutter `version: 1.6.2+23`.

**Vesopa Customer Display goes to 1.6.2.0 with it**, and the two must ship
together: pairing replaces discovery, and a 1.6.1 display paired against a 1.6.2
till (or the other way round) never connects. Flutter `version: 1.6.2+3`.

**Vesopa Kitchen does not move.** Nothing in it changed. It stays on 1.5.0.0.

**Patch, not minor.** Nothing here changes how the till takes money.

**Server: schema changes.** `deploy.ps1 -Schema` is required — `epos_orders`
gains `terminal`, and the card, device and Apple Wallet tables are new. Every
statement is guarded, so it is safe to re-run.

## What changed

- **Swipe cards.** Stripe readers, QR scanners and USB tag readers are all
  keyboards to Windows, so one state machine reads all three. A number is
  classified by its prefix and routed to a member of staff, a member, or a gift
  card. Prefixes are the venue's own, carried over from the system they are
  leaving. Staff sign-on resolves against the till's cached list, so it works
  with the broadband down. Settings → Swipe cards shows what the reader sends,
  issues a card, and prints the track to encode.
- **Apple Wallet, beside Google.** A `.pkpass` is built and signed on demand so
  it carries today's balance. One link serves either phone. The till can put the
  customer's code on the screen facing them, and restores what was there after.
- **Pairing replaces discovery.** The display no longer guesses at the till's
  data folder. It shows four digits, the till puts the request in front of
  whoever is standing at it, and Connect hands the path over. The grant is
  rewritten on every start, so an upgrade or reinstall keeps the screens.
  Paired screens register into `bo_devices` / `bo_device_log`.
- **Every sale carries its till.** Stamped as the outbox drains, so sales queued
  before this release are attributed too. Reports can filter by terminal.
- **The counter's card buttons are the venue's to switch off.** Back office →
  Cards → At the till: offer a card on a phone, offer to print one, and whether
  the customer's code goes to the screen facing them. Both buttons default on.
  The till re-reads these the moment they are saved rather than on the next
  restart — it now listens for the `cards` push it was already being sent.
- **The code reaches the customer's screen.** "Show on the customer screen"
  reported success and drew nothing whenever the basket was empty, which is
  almost always: "I cannot find my loyalty card" is said before anything is rung
  up. A code the till has put up now beats the idle rule and takes the panel at
  a size somebody can scan. **This is a Customer Display fix** — a 1.6.1 screen
  will not have it.

---

## Microsoft Store — "What's new in this version"

Paste into Partner Center → Store listings → What's new in this version. 1,407
of the 1,500 characters allowed; re-check with
`python tool/check-store-listing.py vesopa_epos/docs/store-listing.md`.

```
Version 1.6.2.0 – Cards at the Counter, and a Screen That Pairs Itself

Staff, Loyalty and Gift Cards: A card reader plugged into this PC is now read by the till itself. One swipe signs a member of staff on, brings up a customer's loyalty account, or puts a gift card against the bill — and it reads the prefixes from your old system, so every card already in a customer's wallet keeps working. Settings then Swipe cards shows exactly what the reader is sending, issues a card to somebody who has not got one, and prints the number to encode onto it. Signing on works with the broadband down.

The Same Card on a Phone: A customer who has left their card at home can hold up their phone instead. One link adds it to Apple Wallet or Google Wallet, whichever they carry, and it carries today's balance rather than the day it was issued. The till can put their code on the screen facing them, so nobody leans across the counter.

Pairing Instead of Guessing: A customer display no longer hunts for the till. The screen shows four digits, the till puts the request in front of whoever is standing at it, and Connect is the whole setup. It stays paired through an upgrade or a reinstall, and a screen that is not connected says which of the reasons it is.

Every Sale Says Which Till: Sales now record the machine that rang them up, so a venue with more than one counter can split the day's takings between them.
```

The Customer Display's own block is in `vesopa_epos_display/docs/store-listing.md`
(1,146 characters).

---

## Store submission

| | Vesopa EPOS | Vesopa Customer Display |
| --- | --- | --- |
| `version:` | 1.6.2+23 | 1.6.2+3 |
| `msix_version:` | 1.6.2.0 | 1.6.2.0 |
| Identity | `MeirionDavies.Vesopa` | `MeirionDavies.VesopaDisplay` |
| Package | `build\store\vesopa-epos-store.msix`, 20.3 MB | `build\windows\x64\runner\Release\vesopa_epos_display.msix`, 34.0 MB |

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it.

Build both with `pwsh tool/build-store-msix.ps1` in each project. Verify by
reading `AppxManifest.xml` out of the .msix rather than trusting the filename,
which never carries the version.
