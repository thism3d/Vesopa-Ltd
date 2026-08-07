# Vesopa Hosting

`hosting.vesopaepos.com` — domain registration, shared hosting and the customer
control panel.

Same stack as `vesopa_web`: Express 5, EJS, mysql2, nodemailer, pm2. No build
step, no framework, no CDN.

---

## The product decision

We do not give customers cPanel. Like Hostinger, they get one interface we
control, and HestiaCP is an implementation detail they never see. Everything
Hestia can do is reached through `src/integrations/hestia.js` and nothing else
in the codebase knows the node exists.

---

## Running it locally

```bash
npm install
cp .env.example .env          # then fill in DB_USER, DB_PASSWORD and the secrets
openssl rand -hex 32          # SESSION_SECRET
openssl rand -hex 32          # ADMIN_SESSION_SECRET

mysql -u root -p -e "CREATE DATABASE vesopa_hostingdb CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
mysql -u root -p vesopa_hostingdb < schema.sql
mysql -u root -p vesopa_hostingdb < seed.sql

npm run seed:admin            # reads ADMIN_EMAIL / ADMIN_PASSWORD from .env
npm run dev
```

- Site: <http://localhost:5075>
- Admin: <http://localhost:5075/admin>

`schema.sql` and `seed.sql` are both idempotent — re-run either at any time.

---

## What we sell

Three product lines, three tables, three pricing screens in the admin.

| Line | Priced by | Terms | Admin |
| ---- | --------- | ----- | ----- |
| **Hosting** | per account | 1 month, 1 year, 2 years, 3 years | `/admin/plans` |
| **Email** | per mailbox, or per 1,000 contacts | 1 month, 1 year | `/admin/plans/email` |
| **Domains** | per year, per extension | 1–10 years | `/admin/tlds` |

### The domain catalogue

The `tlds` table carries the **whole DomainNameAPI rate card** — 715 extensions,
imported from `data/dna-rate-card.csv`:

```
node scripts/import-tlds.js --dry      # show what it would do
node scripts/import-tlds.js            # add new ones, refresh costs
node scripts/import-tlds.js --reprice  # also rewrite sell prices from the ladder
```

Costs are quoted in dollars and converted at the USD rate in the `currencies`
table, so a recorded margin and a displayed price never rest on two different
rates. **An extension already in the table keeps its sell price** — only cost and
category are refreshed — because the 23 hand-seeded ones were priced on purpose.
`--reprice` is how you say you meant it.

The markup ladder lives in `src/tld-markup.js` and is shared with the admin's
"reprice from cost" button, so the two cannot disagree.

Every run prints any extension **selling below cost**, and the admin shows the
same count as a red banner on `/admin/tlds` until it is dealt with.

Browsing is at `/domains/pricing` — filters, price bands and an infinite scroll —
with an indexable page per shelf (`/domains/category/tech`) and per extension
(`/domains/tld/agency`). Both are in the sitemap; the filtered views are not.

### The term ladder

Monthly is deliberately the **dearest** rate; every longer term brings it down.
Annual saves 50%, biennial 57%, triennial 62% — measured against monthly, which
is why lowering the monthly price shrinks the discount shown on all three.

This is not a renewal trick. Each term renews at the price it was bought at, and
the plan card prints that under every price.

### Three currencies, one price list

The catalogue is priced **once**, in GBP, in the `*_pence` columns. USD and CAD
are that base run through a stored rate and a rounding rule. Nothing is priced
twice by hand — a price change is one edit, not three.

Everything is editable under **Admin → Currencies**: the rate, the rounding, the
VAT treatment, the country mapping, and whether the currency is live at all.

**The rate is stored, not fetched.** There is no FX feed and that is deliberate.
A price that moves on its own cannot be quoted in an email, screenshotted,
cached, honoured after a support call, or reconciled at month end. An admin
changes it and every price moves at that moment — visibly, on purpose, together.

#### Rounding lands on the figure people read

£5.99 × 1.27 = $7.6073, and nobody charges $7.61. Two things fix that:

1. **The rule** turns it into a price a person would write. `charm9` (the
   default) gives $7.59; `charm99` gives $7.99.
2. **It is applied to the per-month figure**, not the term total. A yearly plan
   is *sold* as a total but *shopped* as a monthly rate, so the rate is rounded
   and multiplied back up — $3.79/mo billing $45.48, both of which read like
   prices and agree when the customer multiplies.

`charm99` is available but is **not** the default, because a whole-unit step is
enormous down at the cheap end of this ladder. The 2-year and 3-year rungs are
£2.59 and £2.29 a month, and at 1.27 *both* round to $2.99 under `charm99` — the
longer term would cost the same and save nothing. The currencies screen previews
a real plan and **flags any plan whose term ladder has stopped descending**, in
any currency, from any cause.

| Term | GBP | USD | CAD |
| ---- | --- | --- | --- |
| Monthly | £5.99 | $7.59 | CA$10.29 |
| 1 year | £2.99 | $3.79 | CA$5.09 |
| 2 years | £2.59 | $3.29 | CA$4.49 |
| 3 years | £2.29 | $2.89 | CA$3.89 |

#### When conversion is wrong, type the number

`price_overrides` fixes one field, in one currency, to an exact amount — for a
plan pitched at a US competitor, or a TLD whose wholesale cost is quoted to us
in dollars and does not move with the pound. An override is **not** rounded (an
admin who typed $2.99 meant $2.99) and **clearing the box hands it back to the
converter**, which is the only way back from a pinned price.

Set them on each plan's edit page, or per-currency on `/admin/tlds?currency=USD`.

#### Which currency a visitor sees

1. **What they chose** — a click always beats a guess, and once set the lookup
   never runs again for them.
2. **Where they appear to be** — first visit only, resolved **on the server**.
3. **The default** — everyone else, and anyone whose lookup did not answer.

UK → GBP, Canada → CAD, everywhere else → USD. That mapping is a column on the
currency row, not a `switch` in code, so "and Ireland should see EUR" is an
admin edit.

**The geo lookup never happens in the browser.** `ipwho.is` is called from Node.
A request fired from the page would put a third-party host in the CSP, appear in
every visitor's network tab, be blocked outright by most ad-blockers (leaving
those visitors on the wrong currency), and hand a company we have no agreement
with a log of everyone who opens the site.

One lookup per new address. It is cached in memory, in `geo_cache` (with the
address **hashed**, so the table cannot be read back into a list of visitors),
and in the visitor's own cookie for a year. If `ipwho.is` goes down, a circuit
breaker stops calling it after three failures and serves the default currency —
our availability is not theirs to determine.

### VAT is included, never added — and it is per currency

**Every price on this site is VAT-inclusive.** The customer pays exactly the
number they were shown; nothing is bolted on at the last screen. On GBP the
basket shows a VAT row marked "we pay this" — it reports the portion inside the
total and deliberately does not change it.

**The arithmetic is not `total × 20%`.** On a £59.88 VAT-inclusive price:

```
net = 59.88 ÷ 1.2 = 49.90
VAT = 59.88 − 49.90 =  9.98      NOT 59.88 × 0.20 = 11.98
```

The naive version overstates VAT by a fifth on every order. `vatIncludedIn()` in
`src/currency.js` is the only place this is worked out.

**A USD or CAD price carries no VAT at all** — `vat_percent` is 0 on those rows,
`vat_pence` is 0 on the order, and no VAT line is drawn anywhere. UK VAT is not
chargeable on these services to a consumer outside the UK, and showing an
American customer a UK VAT figure would be inventing a tax.

Orders store `subtotal_pence` as the **net**, so `subtotal + vat = total` and an
invoice adds up. That is not the same number the basket shows next to
"Subtotal", which is the gross of the lines.

> **Worth a word with your accountant.** Showing a VAT line labelled "we pay
> this" is unusual on a UK invoice: strictly, the customer *is* paying the VAT —
> it is inside the price — and we remit it. The wording is what was asked for
> and the arithmetic underneath is correct either way, but if you are VAT
> registered, the standard invoice wording is "VAT included at 20%". If you are
> **not** VAT registered you should not show a VAT line at all; set GBP's
> `vat_percent` to 0 under Admin → Currencies and it disappears.
>
> The zero rate on USD and CAD is the ordinary place-of-supply treatment for
> digital services to a consumer outside the UK, but it is a column on the
> currency row precisely so an accountant can change it without a deploy.

#### What an order remembers

An order freezes its currency, **the rate that applied that day**, and what it
was worth in the base currency at that rate. None of the three can be re-derived
later: editing the USD rate next month must not retrospectively change what
somebody paid in March, or what March was worth.

That is also why the admin dashboard sums `base_total_pence` and never
`total_pence` — adding $79 to £59 and reporting 138 is the failure this column
exists to prevent. The revenue tile carries a per-currency split underneath it.

### Discount codes

Real, with limits that hold. `src/coupons.js` owns every rule; the basket, the
re-price on each page load and the checkout transaction all call the same
`evaluate()`.

A code is written **once**, in the base currency, and converted like any other
price — otherwise every campaign becomes three campaigns with three `used`
counters. A percentage needs no conversion and is the same offer everywhere; a
fixed amount and a minimum spend are converted at the currency's own rate, so
"£10 off over £50" reads as "$13 off over $65" and means the same thing to us.

- Percentage or fixed, scoped to `all` / `hosting` / `email` / `domain`
- Minimum spend, expiry, maximum uses, first-order-only
- A fixed code never exceeds what the qualifying lines are worth
- **Redemption is counted inside the checkout transaction** with a
  `WHERE used < max_uses` guard, so two people racing for the last use cannot
  both get it. Losing that race rolls the whole checkout back rather than
  charging one price and recording another.
- A code that fails validation leaves an already-applied code alone — mistyping
  a second code must not silently discard the discount someone already had.

Scope matters commercially: domains are bought in at close to what we sell them
for, so a percentage off "everything" is most of that margin. Managed at
`/admin/coupons`.

### The buying journey

```
plan button  →  /cart  →  /checkout  →  pay  →  /panel/setup/:id  →  panel
                                                 ├─ claim the free domain
                                                 └─ watch it build, live
```

**Two steps: basket, then checkout.** Choosing anything — a plan, an email plan,
a domain — adds it and shows the basket. The basket's one button goes to the
payment form.

The basket is where the term can still be changed, a domain added, a discount
code applied and the total checked. Everything that is a *question about the
purchase* happens there; checkout only asks for an address and payment.

**Nothing in the basket reloads the page.** Changing the term, the quantity,
removing a line or applying a code posts in the background and swaps the two
columns in place — no scroll jump, no losing your place halfway down a long
basket.

**The browser never works out a price.** It posts the change; the server prices
the basket exactly as it does for a full page load and returns the two columns
already rendered. Patching the numbers client-side would have meant a second
copy of the discount rules, the free-domain rules, the VAT arithmetic and the
term ladder in another language, and the customer would be the one to find the
day the two disagreed.

Every control is a real submit button in a real form, so with JavaScript blocked
or still loading it posts and redirects exactly as it always did. Same route,
same validation, same result — only the reply differs.

The billing period is a **row of tabs, not a dropdown**. Four options is too few
to hide behind a click, and it is the most consequential choice on the page: the
rate halves between its ends. Each tab carries its own per-month price and its
saving, so all four and what they are worth are visible at once. On a phone they
fold to two rows of two rather than shrinking to fit.

Questions about *setup* are asked after payment, in the wizard — a customer who
has decided to buy should not meet a form about DNS on the way to paying.

Everything that was asked before checkout is now asked **after payment**, in the
setup wizard at `src/routes/setup.js`. It has three states and the server picks
which, from the order and the service, never from the URL:

| State | When | What the customer does |
| ----- | ---- | ---------------------- |
| `pay` | order not paid | Nothing. No domain is offered and nothing is provisioned. |
| `domain` | paid, service still at the `domain` step | Claims the free domain, names one they own, or skips. |
| `provisioning` | domain settled | Watches the build, step by step. |

**Marking an order paid no longer provisions it** if a hosting service is still
waiting at the `domain` step — that would answer the domain question with "none"
before the customer ever saw it, and quietly lose them the free domain they are
owed. The admin's "Provision now" button overrides this for the customer who
telephones instead of finishing the wizard.

### The free domain

**One domain free with any hosting plan bought for 12 months or more.** Never on
the monthly plan: a registration costs real money at the registry the moment it
happens and cannot be handed back, so it must not ride on a term that can be
cancelled after four weeks.

The entitlement is **frozen onto the service row** at the moment of sale
(`free_domain_eligible`), not recomputed later — an admin editing a plan must
not change what someone was already sold. `free_domain_claimed` is what stops a
second one being taken; it is set either by the basket zeroing a domain already
in it, or by the wizard, **never both**.

Which extensions qualify is a **price cap, not a list** — `tldQualifiesFree()`
in `src/config.js`. A list has to be edited every time a TLD is added and the
day someone forgets is the day a £39.99 `.io` is given away with a £35.88 plan.

Both the register **and the renewal** price must be inside the cap. `.shop`
costs £2.99 to register and £29.99 to renew; handing that over as a gift and
billing £29.99 a year later is the exact renewal cliff this site's own pricing
page says it does not run. Checking both leaves .co.uk, .uk, .com, .net, .org,
.dev, .app, .biz and .eu.

### Live setup progress

`provisionOrder()` writes a row per step into `setup_steps` — `pending` →
`running` → `ok`/`failed`/`skipped` — and the wizard polls
`/panel/setup/:id/status` once a second.

**Polling, not server-sent events.** SSE needs `proxy_buffering off` in nginx to
work at all, and a progress bar that silently never moves in production because
of a missing directive is worse than a request a second.

Provisioning is **not awaited by the HTTP request** that starts it. It takes
seconds to a minute; holding the request open would show a blank tab and then
time out behind nginx.

### Email

Business email provisions automatically: a paid order creates the mail domain on
the Hestia node, reusing the customer's existing account if they have one.

**Marketing email is set up by hand and says so on the page.** Bulk sending is
deliberately kept off the web servers — a campaign from a shared node damages
its sending reputation and takes every other customer's ordinary mail with it.
A paid order records the subscription and logs `email.manual_setup_required`.

---

## Mock, test and live

**Both integrations default to mock, and that is deliberate.** The entire site
works end to end without a single credential: you can search a domain, buy a
plan, check out, and provision the order. Nothing is bought and no account is
created.

| Variable       | Values                                                            |
| -------------- | ----------------------------------------------------------------- |
| `DNA_MODE`     | `mock` fake · `test` real API, sandbox registry · `live` real money |
| `HESTIA_MODE`  | `mock` logs the commands · `live` real accounts on the node        |
| `SSLCZ_MODE`   | `mock` a fake gateway page at `/pay/mock/*` · `live` real payments  |
| `PAYMENTS_MODE`| `manual` — the fallback when no gateway is available at all         |

The admin dashboard shows an amber banner whenever either is in mock mode, so
"why did no domain get registered" is answered before it is asked.

### Searches run against production even in test mode

`DNA_MODE=test` sends **registrations** to the OTE sandbox but **availability
searches to the live gateway**, because the sandbox carries a reduced TLD set:
`.co.uk` and `.uk` return nothing at all from it — not "taken", simply absent.
Pointing the search box there would tell a British customer that the one
extension they came for does not exist.

A lookup is read-only. It registers nothing and costs nothing. Set
`DNA_SEARCH_ENDPOINT=mode` to force searches onto the sandbox too.

### Going live

1. **Registrar.** `DNA_MODE=live`, restart. Before you do:
   - **Fund the account.** The live balance was $0.00 as of 2026-08-05. Searches
     work perfectly on an empty account and registrations fail *after* the
     customer has paid. The admin Settings page shows the live balance in red
     when it is zero.
   - **Check the rate card.** The registrar bills in **USD**; our prices are in
     GBP. The `cost_pence` figures in `seed.sql` are informed estimates in GBP
     and have not been reconciled against a real invoice.
2. **Hosting node.** Set `HESTIA_HOST` to the Azure box, `HESTIA_ADMIN_PASSWORD`
   to the Hestia admin password, `HESTIA_MODE=live`.
   Create the packages `starter`, `business` and `pro` on the node first — they
   are what actually enforce the plan limits, and `v-add-user` fails without
   them. Add this server's IP to Hestia's API allow list.
3. **Payments.** `src/routes/cart.js` already writes the order, the lines, the
   service and the domain rows. Only the charge step is missing. The webhook
   should call `provisioning.provisionOrder(orderId)` — the same function the
   admin's "Mark paid & provision" button calls, which is why that logic is a
   module and not inline in the route.

---

## Layout

```
src/
  server.js              boot, middleware, locals, error handling
  config.js              constants and terms (integer minor units throughout)
  currency.js            rates, rounding, formatting, inclusive VAT
  currency-context.js    which currency this request is in; the switcher route
  geo.js                 server-side ipwho.is, cached and circuit-broken
  db.js                  pool, transaction(), activity log, settings cache
  auth.js                sessions, passwords, CSRF, single-use tokens
  mailer.js              SMTP + the one HTML shell every email uses
  pricing.js             base catalogue -> one priced catalogue per currency
  provisioning.js        paid order -> live services. Idempotent.
  icons.js               inline SVG set, exposed as res.locals.icon
  http-utils.js          flash, rate limiting, field trimming, paging
  integrations/
    domainnameapi.js     registrar
    hestia.js            hosting node
  routes/
    pages.js  legal.js  domains-api.js  cart.js
    auth-routes.js  panel.js  setup.js  admin.js
  coupons.js             discount code rules, in one place
views/
  partials/  public/  auth/  panel/  admin/
public/assets/           app.css, sections.css, cart.css, setup.css, panel.css,
                         app.js, domain-search.js, cart.js, setup.js
```

`views/partials/header.ejs` defines the nav ONCE and renders it twice — as the
desktop bar and as the full-screen sheet. `hero-net.ejs` is the animated network
behind the hero.

`views/partials/cart-main.ejs` and `cart-summary.ejs` are the basket's two
columns. They are partials rather than part of the page because the server
re-renders them on their own after every basket change and hands them back as
fragments — see below.

## The header

**Nav labels never wrap.** `white-space: nowrap` on `.nav-link`, which means the
only two outcomes left are "fits" and "pushes the document sideways" — there is
no graceful middle any more, by design. So the breakpoint is **measured**: the
row is brand 235 + links 485 + actions 260 + gutters 88 = 1068px in CAD, and
"CA$" being wider than "£" is what makes Canadian dollars set it. It collapses
to the sheet at 1140px, which is deliberately about seventy pixels of headroom
rather than the tightest number that fits.

**On the homepage the bar sits over the hero.** `navOver` makes it transparent
with light text, and it fades to the ordinary white bar once the hero has
scrolled past — one `.is-stuck` class and one scroll listener, so the two states
cannot disagree about the threshold. Both wordmarks ship and CSS picks between
them; swapping the `src` in JavaScript would show a black logo on black for the
first frame.

**Below 1140px it is a full-screen sheet**, not a dropdown. The dropdown had to
scroll inside itself on a short phone and covered only part of the page behind
it. The sheet has room for a line of description per link and puts the account
buttons where a thumb reaches; on a tablet it uses two columns. It traps focus,
closes on Escape, and **pins the scroll position** rather than only hiding
overflow — on iOS the page behind still scrolls under an `overflow: hidden`
body, so closing the menu would drop you somewhere else on the page.

## The hero

Full viewport (`100svh`, not `100vh` — `vh` counts the mobile URL bar as though
it were not there, which pushes the search box below the fold on the one device
where that matters most).

Behind it is an **inline SVG network**: sites linked in a mesh, data packets
travelling the links, status pings, two server racks with activity lights that
blink out of step, and a slowly turning globe. It is masked out of the middle,
because it sits behind a headline that has to stay readable.

Inline SVG rather than an image or a canvas: an image cannot animate and would
be a second download before first paint; a canvas would need a rAF loop running
for as long as the page is open and draws nothing until JavaScript has parsed.
The SVG paints with the document, costs no request, and keeps running with
scripting blocked. **Every animation is transform or opacity only**, so nothing
here can force a layout.

Micro-interactions, all of which degrade to nothing:

| Input | What happens |
| ----- | ------------ |
| Mouse | Auroras, mesh and a spotlight move at three different depths — one rAF per frame at most, never per event |
| Touch | A ring from where the finger landed (there is no hover on a phone, so the spotlight never fires there) |
| Scroll | The mesh drifts up more slowly than the page, capped at one viewport |
| Idle | The placeholder types real example domains, and stops for good the moment the field is focused |

## Three. Two. Online.

The claim everywhere else is "online in minutes". This section is where it stops
being a sentence: a countdown, the three things that actually happen with the
real elapsed time against each, and a browser window that goes from a spinner to
a padlock and a live page.

Steps on the left, window on the right, so cause and effect are beside each
other and the whole thing lands in **885px — one screen**. Stacked it ran to
nearly two, and the countdown had scrolled away before the window finished
animating, so the two halves never appeared together.

It runs **once**, when scrolled into view, then holds its finished state. A loop
turns a demonstration into wallpaper, and something moving in the corner of the
eye while somebody reads the price above it is a cost with no benefit.

Everything it says is in the markup already; the JavaScript only reveals it in
order. Under `prefers-reduced-motion` it shows the finished article immediately
— the information is the three steps and their timings, and none of it lives in
the animation. The network stays drawn but stops moving: the request is about
motion, not about wanting a blank page.

`views/partials/cart-main.ejs` and `cart-summary.ejs` are the basket's two
columns. They are partials rather than part of the page because the server
re-renders them on their own after every basket change and hands them back as
fragments — see below.

---

## Decisions worth knowing

**Money is integer pence, everywhere.** A float pound value rounds wrong on the
third multi-year order and nobody notices until a reconcile.

**The registrar rejects concurrent requests with 429.** Two bulk searches issued
at the same instant, one succeeds and one fails. Chunks therefore run
sequentially, never `Promise.all`. An earlier version fanned them out and
roughly half of every search came back "could not check" for no visible reason.

**The search box asks two questions, not one.** `/api/domains/check` looks up
only the exact name the visitor typed and answers in about a second;
`/api/domains/suggestions` fetches the alternatives afterwards. One combined
call took four seconds before anything could be shown, and six sevenths of that
wait was for a cross-sell nobody asked for.

**A grid or flex child needs `min-width: 0`.** It defaults to `min-width: auto`
and refuses to shrink below its content, so one `white-space: pre` block or one
unwrapped table widens its column, its grid, and then the whole document —
every section on the page scrolls sideways, not just the one at fault. There
are rules for this in both `app.css` and `panel.css`; do not remove them.

**Never set `grid-template-columns` in an inline `style`.** An inline style
beats every stylesheet rule, so no media query can collapse it. Both the contact
and checkout pages did this and stayed two-column on a 360px phone.

**Prices live in the database, not in code.** Unlike the EPOS subscription
plans, nothing external is created from a hosting price, so an admin editing one
cannot desynchronise anything already sold. Edits are live on the site
immediately — `pricing.invalidate()` runs on every admin write.

**The registrar's price is never quoted to a customer.** Availability comes from
the API; the price always comes from our `tlds` table. A registrar changing its
rate card mid-session must not change what someone is charged halfway through a
checkout.

**The basket is a cookie holding references only** — a plan slug, a domain, a
term. Every price is looked up again server-side at checkout, because anything
else lets a customer with a text editor set their own price.

**Every VARCHAR pins `COLLATE utf8mb4_general_ci`.** On the live MariaDB a bare
`utf8mb4` resolves to `uca1400_ai_ci`, which does not compare against
`general_ci` — an email column left bare joins fine on a dev machine and
silently matches nothing in production. `schema.sql` ends with a repair pass
that fixes any column that has drifted.

**Sessions are stateless signed cookies** carrying a fingerprint of the password
hash. Changing a password changes the fingerprint, which invalidates every
cookie already issued — that is how "sign out everywhere" works without a
session table.

**Expiry never suspends anything by itself.** Same rule as the EPOS
subscriptions: a lapsed date raises a flag and sends an email. Suspension is a
deliberate act by a human.

**Provisioning is idempotent and tolerates partial failure.** If the account is
created and SSL then fails because DNS has not propagated, the customer keeps a
working account and gets a clear message. Rolling back a live account over a
certificate that will succeed in an hour would be worse for everyone.

---

## Deploying

```bash
./deploy.sh              # rsync + npm install + pm2 restart
./deploy.sh --schema     # also applies schema.sql and seed.sql
./deploy.sh --logs       # tail
```

The live box runs a number of unrelated applications under the same account.
Every pm2 command names `vesopa_hosting` explicitly — never `pm2 restart all`.

nginx needs a server block for `hosting.vesopaepos.com` proxying to `127.0.0.1:5075`.

---

## Not built yet

- **Stripe and crypto checkout** — both are shown at the checkout, disabled, with
  no adapter behind them. SSLCommerz is live. Adding one is a matter of writing
  an adapter and having it report itself configured; `payments.gateways()`
  computes availability rather than being told it.
- **Refunds** — `payments.status` has a `refunded` value and the API secret can
  sign a refund request, but nothing calls it. Refunds are manual at the gateway
  today, and must be worked out from `charged_minor`, not the order total.
- **Renewal charging through the gateway** — `next_due_at` is set and shown; no
  job charges a stored card, and no card is stored.
- **DNS record editor** — the panel sets nameservers; per-record editing is not built.
- **One-click WordPress** — advertised on the site, needs `v-add-web-app` wiring.
- **Node/Python app deploys** — advertised in the "vibe code" section. Static and
  PHP work today; the Node and Python runtimes need proxy templates on the Hestia
  node and have **not** been proven. Confirm before that section goes public.
- **Marketing email sending** — sold, recorded, flagged for manual setup. No ESP
  is integrated.
- **Renewal billing job** — `next_due_at` is set and shown, nothing charges it yet.
- **Automated tests** — the flow has been walked by hand end to end; there is no suite.

## Known registrar limitations

Measured against the account on 2026-08-05, not assumed:

- **Live balance is $0.00.** Nothing can be registered until it is funded.
- **OTE cannot register anything.** A correctly-validated `.com` registration
  returns `Dna.DomainService:Epp:10001 — An error occurred in the EPP
  integration`, and `.co.uk` is not carried by the sandbox at all. The request
  payload is correct (it passes validation); this is theirs to fix. Worth raising
  with DomainNameAPI support before relying on the sandbox for a dress rehearsal.
- **`phoneCountryCode` must be bare digits** — `44`, never `+44`. Sending the
  plus fails the whole registration with a generic "Validation failed"; the
  field name is only in the `validationErrors` array, which `call()` now unpacks
  into the error message.
