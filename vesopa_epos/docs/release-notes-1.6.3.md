# Vesopa EPOS 1.6.3 — release notes

Store submission: `msix_version: 1.6.3.0` (previous build here was 1.6.2.0).
Flutter `version: 1.6.3+24`.

**Vesopa Customer Display goes to 1.6.3.0 with it**, but read the next
paragraph before planning the rollout — this is not the usual "they must ship
together". Flutter `version: 1.6.3+4`.

**Vesopa Kitchen does not move.** Nothing in it changed. It stays on 1.5.0.0.

**Patch, not minor.** Nothing here changes how the till takes money.

## Update the till first, and the display fault clears on its own

The reported fault — a customer display that pairs, says "paired", and then sits
on "Waiting for the till" — is fixed **entirely in the till**. The display's own
code has not changed at all this release beyond its version number.

A display never decides where the basket is; it follows whatever path the till
hands it in the grant, and it rewrites nothing. So a venue that installs the
1.6.3 till and leaves its screens on 1.6.2 gets a working display within about
five seconds of the till starting, with nobody re-pairing anything. The 1.6.3
display is worth installing for tidiness, not to fix this.

**Server: schema changes, already applied to backoffice.vesopaepos.com.**
`deploy.sh --schema` is required on any other server. Three new migrations —
permissions, price levels, printer categories — plus seven older ones rewritten
so that re-running them is genuinely safe. See the note at the end.

## What changed

### The two faults the venue reported

- **A swiped card no longer waits for somebody to touch the screen.** The reader
  was never at fault: the card was read correctly every time, and the prompt was
  sitting in a queue waiting for a frame that an idle till had no reason to
  draw. Touching the screen produced the frame, which is why it looked like the
  screen woke the reader up. It now asks for the frame it is waiting on, so a
  swipe acts immediately — the new-member prompt, a staff card signing somebody
  on, a loyalty card going onto the bill.

- **The customer display follows the till again.** The handshake was always
  working; the basket was not. It was written into the till's own application
  data, which on a Store install is a folder private to that package and one no
  other application may open — so the display was handed a perfectly accurate
  path to a file it was not allowed to read, and correctly reported the till as
  silent. `basket.json`, `settings.json` and `status.json` now live in
  `%PROGRAMDATA%\Vesopa\display\<terminal>`, beside the pairing handshake that
  has been working in that folder all along. Nobody re-pairs anything: the till
  rewrites every grant on start, which is what that has always been for.

### Staff permissions

- **Permission groups.** Set up roles in the back office under People → Staff
  Permissions — Staff, Supervisor and Manager come ready-made in one press — say
  what each may do at the till, then choose one for each person on the Staff
  page. Eleven keys: manager, refund, void, discount, no sale, set selling
  price, X report, Z report, unlock tables, expenses and wastage.
- **A refusal offers a manager rather than a dead end.** When somebody without
  the key tries, the till offers "Ask a manager". They type their PIN, that one
  action goes through, and the clerk stays signed on with their own name on the
  bill. Nobody signs off, fetches somebody, and signs back on.
- **Anybody in no group keeps every key.** That is how the till worked before
  this release, and it is what every member of staff has until a venue says
  otherwise. Permissions travel down with the PIN, so they are checked with the
  broadband down.

### The keypad, the clock and the keyboards

- **One PIN pad.** The Sign On key opened a smaller pad with a blank key where
  Clear belongs; the lock screen had the big one with Clear and Back spelled
  out. Signing on is the most repeated act on a till and staff do it without
  looking, so two layouts meant the muscle memory was wrong half the time. There
  is now one pad and both screens show it.
- **The Clock key clocks the person on the till.** It opened a list of everybody
  at the venue and you found your own name in it first. It now punches whoever
  is signed on, and says so: green with the time they started, red with the time
  they finished. The full list of who is on has moved to Functions → Staff On
  Shift, which is where a manager looks for it, and still asks for a PIN because
  it can punch anybody.
- **A keyboard on every box.** A member's name, a note on a line, a reason for a
  discount, a table number, a gift card code — every text box a clerk reaches at
  the counter now brings a keyboard up with it. Number pads where the answer is
  a number.

### Prices and printing

- **Six prices per product.** Price 1 is the price you already have; five more
  are optional. Leave one blank and that product simply charges Price 1 — so a
  happy hour is the six drinks it applies to, not four hundred products that
  have to be filled in. Name them what they are ("Happy Hour", "Staff",
  "Function Room") and the till key says the name. Switch the terminal between
  them from Functions → Price Level; a loyalty tier can name a level of its own,
  which wins for that customer's bill. Bills already open keep the prices they
  were rung up at.
- **Printer categories.** Set up Breakfast, Mains, Desserts, Sides in the back
  office under Programming → Printer categories, drag them into the order they
  should print, and put each product in one. A kitchen ticket then comes out in
  courses rather than in the order the customer said them:

      --- BREAKFAST ---
      2 Large Breakfast
      1 Small Breakfast
      1 Pancakes
      --- MAINS ---
      2 Cod & Chips
      1 Pizza

  Within a course nothing is reordered, a modifier never leaves the dish it
  belongs to, and a product in no category prints last under no heading.

### For anybody testing a till

- **A mock card reader**, for a terminal with nothing plugged into it. Off in
  every ordinary build, including this one; a build compiled with
  `--dart-define=VESOPA_MOCK_READER=true` can produce a swipe without hardware.
  It is what made the swipe fault reproducible without posting builds to a venue
  and trying them during service.

## Back office (server) — deployed

Not part of the Store submission, but shipped alongside and already live.

- **One venue's takings never appear in another's.** Six report routes read the
  orders table with no owner at all — the Report, Sales Explorer, Till Report,
  Bill Report, Sales and the dashboard's live figures. A company created that
  morning opened its Till Report and read somebody else's trading. Two joins
  leaked as well, and more quietly: product and staff names are keyed within an
  office, not across the platform, so a report whose figures were right could
  still carry another venue's words. `/reports/end-of-day`, which needs no
  token, added every venue's day together.
- **Back office user roles.** People → Back Office User Roles. Fifty keys across
  seven groups with a Toggle All each; Owner, Manager, Accountant and Staff come
  ready-made. The menu hides what a role cannot open and names the role in the
  sidebar, and every route refuses on its own — the hiding is a courtesy, not
  the enforcement. A login with no role sees everything, as before.
- **Four more reports.** Product Sales, Discount, Customer Loyalty Spending, and
  Voids & Cancels. Each runs, exports as PDF, CSV or spreadsheet, and can be
  scheduled to arrive by email, exactly as the Financial Summary does.
- **Seven migrations that could not safely be re-run.** `deploy.sh --schema`
  re-applies every migration and its help says that is safe; for seven of them
  it was not. MySQL rolls back a whole multi-column `ALTER` when one column
  already exists, so a database that had the first column got *none* of them,
  permanently. That is why `epos_orders` was missing `discount_minor` and
  `covers`, and why the Till Report and Bill Report answered 500 on a database
  that looked migrated. All seven are now guarded per column.

---

## Microsoft Store — "What's new in this version"

Paste into Partner Center → Store listings → What's new in this version.
Re-check the length with
`python tool/check-store-listing.py vesopa_epos/docs/store-listing.md`.

```
Version 1.6.3.0 - Who Can Do What, and Two Faults Fixed

A Swipe Acts Straight Away: A card swiped at the counter no longer waits for somebody to touch the screen first. The reader was never at fault - the card was read every time, and the prompt was waiting on a screen refresh an idle till had no reason to draw.

The Customer Display Follows The Till: A screen that paired and then sat on "Waiting for the till" now shows the bill. Nothing is re-paired - update the till and the screens reconnect on their own.

Staff Permissions: Set up roles - Staff, Supervisor, Manager - say what each may do at the till, and give one to each member of staff. Refunds, voids, discounts, no sale, price overrides, X and Z reports, unlocking tables, expenses and wastage. When somebody without the key tries, the till offers to ask a manager, who approves that one action with their PIN without anybody signing off.

Six Price Levels: Every product can carry up to six prices - a happy hour, a function tariff, a staff rate. Leave one blank and it charges the normal price, so you fill in only what changes.

Printer Categories: Group what the kitchen sees and set the order it prints in, so a ticket reads Breakfast, then Mains, then Desserts.

One Keypad, A Clearer Clock: The Sign On pad now matches the lock screen. The Clock key clocks whoever is signed on and shows the time - green on shift, red once they finish. Every text box at the counter brings up a keyboard.
```

The Customer Display's own block is in
`vesopa_epos_display/docs/release-notes-1.6.3.md`.

---

## Store submission

| | Vesopa EPOS | Vesopa Customer Display |
| --- | --- | --- |
| `version:` | 1.6.3+24 | 1.6.3+4 |
| `msix_version:` | 1.6.3.0 | 1.6.3.0 |
| Identity | `MeirionDavies.Vesopa` | `MeirionDavies.VesopaDisplay` |
| Package | `build\store\vesopa-epos-store.msix`, 19.8 MB | `build\store\vesopa-display-store.msix`, 33.3 MB |
| Manifest checked | `Version="1.6.3.0"`, `runFullTrust` | `Version="1.6.3.0"`, `runFullTrust` |

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it.

Build both with `powershell tool/build-store-msix.ps1` in each project. Verify
by reading `AppxManifest.xml` out of the .msix rather than trusting the
filename, which never carries the version.

## What was tested

- 656 of the till's tests pass. Four do not and none is related to this
  release: two Dojo tests need live terminal credentials, and two golden images
  were rendered on a different machine from the one that ran them. The
  functions-page golden is additionally stale on its own account — that page
  gained a key and renamed another — and wants regenerating wherever the
  goldens are owned.
- 74 of the display's tests pass, with none failing.
- **The pairing contract is now tested across both applications.** The till's
  `pairing_contract_test.dart` drives its real code and commits the files it
  writes to `docs/pairing-contract/`; the display's test of the same name reads
  those files with its real parser. Until now each side tested against fixtures
  it had written itself, which is how both suites could be green while a venue
  looked at a display showing adverts. Putting the old AppData path back into
  the contract turns the display's side red, which is the check that was
  missing.
