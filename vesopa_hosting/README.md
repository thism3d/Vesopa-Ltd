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

### Nothing joins the account until the money does

**Checkout writes an order and its lines. That is all it writes.** No service,
no domain, no mailbox subscription. An unpaid order is a quote.

It did not always work that way, and the old behaviour was worse than untidy: a
customer who reached the payment page and left had a hosting account and a
domain sitting in their panel, and the domain row — `domains.domain` is unique —
held a name nobody had bought, so the next person to genuinely buy it collided
with it.

So the account is built at the moment of payment instead, by
`provisioning.materialiseOrder()`, from the order lines:

```
checkout   orders + order_items                    ← the only rows an unpaid order has
payment    services + domains + email_services     ← materialiseOrder()
           then provisionOrder() makes them real
```

The lines therefore have to carry everything the account needs — `plan_id`,
`email_plan_id`, the term, the units, and the free-domain entitlement as it
stood at the moment of sale. That last one is the reason the entitlement lives
on `order_items` rather than being recomputed later: an admin editing a plan
next week must not change what somebody was sold last week.

**One door, four callers.** `provisioning.activateOrder()` is what every path
that can learn an order is paid goes through — the browser return, the gateway's
IPN, the reconciler, and an admin marking it paid by hand. They used to carry
four copies of the "is a service still waiting for its domain" rule between
them, and three of the four would have been wrong the first time it changed.

**Idempotent by row lock, not by checking first.** `orders.activated_at` is
claimed under `SELECT … FOR UPDATE`. The browser return and the IPN routinely
arrive within milliseconds of each other and both call this; the loser sees the
timestamp the winner wrote and does nothing. A read-then-write would leave a
window, and that window is where a customer gets two hosting accounts for one
payment.

### The server checks the gateway, because the browser is not evidence

A customer who pays and closes the tab never reaches the return URL. Stripe and
PayPal send no notification of their own. Their money moved and only the gateway
knows it.

So `src/jobs.js` asks. Every pending payment attempt is re-checked against the
gateway that owns it until it settles or its session dies:

| Gateway | How it is checked |
| ------- | ----------------- |
| Stripe | the Checkout Session is retrieved by id; `expired` closes the attempt |
| PayPal | the order is read back — and an `APPROVED` one, which is exactly what a closed tab leaves behind, is captured |
| SSLCommerz | no status endpoint exists through BosheBoshe. Settlement is by signed IPN and signed return; the reconciler only ages the attempt out |

An attempt past `expires_at` — `PAYMENT_SESSION_MINUTES`, 90 by default — is
closed as cancelled, so "nothing has been charged, you can try again" is true
when the customer reads it. The same pass also finishes any order that is paid
but has no `activated_at`, which is the process having been restarted mid-flight.

### The free domain

**One domain free with any hosting plan bought for 12 months or more.** Never on
the monthly plan: a registration costs real money at the registry the moment it
happens and cannot be handed back, so it must not ride on a term that can be
cancelled after four weeks.

The entitlement is **frozen onto the order line** at the moment of sale
(`order_items.free_domain_eligible`), not recomputed later — an admin editing a
plan must not change what someone was already sold. It is copied onto the
service when the order is paid. `free_domain_claimed` is what stops a second one
being taken; it is set either by the basket zeroing a domain already in it, or
by the wizard, **never both**.

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

### Domains on an account

**Anyone with an account can add a domain they already own.** Registering one
through us is a purchase and goes through checkout; naming one you own is not,
and gating it behind a sale would mean a customer moving a live site cannot see
the panel they are being asked to trust. `/panel/domains/add`.

**It gets them nothing until the nameservers agree.** A domain typed into a form
is a claim, not a fact — the person typing it may not own it, and a platform
that will serve a site, accept mail and issue a certificate for any name it is
handed is a platform for impersonating other people's domains. The delegation is
the proof: `src/nameservers.js` asks the *public* DNS (1.1.1.1 and 8.8.8.8, not
the node's own resolver, which would answer authoritatively for zones it holds
and turn the check into "do we have a zone for this") and every nameserver it
answers with has to be one of ours. One of two is not enough — a domain
delegated half to us and half to somebody else is served by both at random.

| `domains.source` | Where it came from | Can it be dropped? |
| ---------------- | ------------------ | ------------------ |
| `registered` | bought through us at the registry | **Never.** It was paid for and it is theirs. |
| `transfer` | transferred in | **Never**, same reason. |
| `external` | registered elsewhere, added here | Yes, if it never points at us. |

**An external domain has `DOMAIN_NS_GRACE_DAYS` — three — to point at us.** The
deadline is written onto the row when it is added, so the date the customer is
shown is the date that is enforced. Past it, the sweep sets the row `removed`,
logs it and emails them what to do about it; the domain itself is untouched and
adding it again later is allowed. Leaving it in the list forever would mean the
panel shows domains this company does not host.

**The sweep will not run at all unless `NS1` and `NS2` themselves resolve.**
If our own nameservers are not answering, then nobody can point a domain at
them, every check fails for a reason that is entirely ours, and a grace period
enforced on top of that would delete customers' domains as punishment for our
outage. The job logs loudly and does nothing instead.

> This is not a hypothetical guard. When it was written,
> `ns1.vesopaepos.com` and `ns2.vesopaepos.com` had **no DNS records at all** —
> `vesopaepos.com` is delegated to `ns1/ns2.onzep.uk` and the glue for the
> hosting nameservers was never published. Until A records (and, since they are
> inside the domain they serve, glue at the registry) exist for both, domain
> verification cannot succeed for anybody, and the boot log says so on the line
> that starts `[jobs]`.

Verification runs from three places, all the same function: the sweep every
`DOMAIN_RECHECK_MINUTES`, the customer's own **Check now** button, and the SSL
retry — because somebody pressing that button has usually *just* changed their
nameservers, and the stored answer is by definition the one from before they
did. When it passes, `pointAtNode()` creates the zone, the website and the mail
domain and issues the certificate, all tolerating "already exists".

**DNS is editable for any domain we are answering for.** The zone lives on the
node — our nameservers *are* the node — so `/panel/domains/:id/dns` is editing
the file that answers the query, with no copy in our database to drift and no
publish step. It is refused when the domain is delegated elsewhere, because an
editor writing into a zone nobody queries is worse than no editor at all: the
customer would believe the change had been made.

### SSL

**Three conditions, all checked in the route and all explained on the page:**

1. the hosting is ours — a certificate is installed on a web server, and we can
   only install one on ours;
2. the hosting is **paid and active** — `status = 'active'` is reachable only
   through a settled payment;
3. the domain resolves to us — Let's Encrypt proves control by fetching over the
   domain, so issuing for a name we do not serve is not possible and would be
   certifying somebody else's domain if it were.

### Email

Business email provisions automatically: a paid order creates the mail domain on
the Hestia node, reusing the customer's existing account if they have one.

**Mailboxes are free with a hosting plan** — how many is `plans.mailboxes`, per
plan, editable in the admin — and a business email plan adds more by the
mailbox. `src/mailboxes.js` adds the two together, counts what is in use **on
the node** rather than from a counter of our own (support can add a mailbox by
hand, and a counter would be wrong in the direction that lets somebody exceed
what they bought), and the create route re-checks the allowance at the moment of
the click rather than trusting the page it was drawn on.

Both sources only count while `active`: a suspended hosting account or a lapsed
mail subscription grants nothing. Marketing plans count for nothing here — they
are contact lists, not inboxes.

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
3. **Payments.** Set the gateway credentials and take the adapters off mock.
   Everything downstream of a confirmed payment already runs through
   `provisioning.activateOrder(orderId)` — the same function the admin's "Mark
   paid" button and the reconciler call — which is why that logic is a module
   and not inline in a route.
4. **Nameservers.** `NS1` and `NS2` must actually be the hosting node, because
   they are what every domain is checked against. Point them at the box, then
   confirm from somewhere else on the internet that they answer.

---

## The background jobs

`src/jobs.js`, started from `server.js`, one timer, three duties. All three
exist for the same reason: something outside this process changes state and
never tells us.

| Job | What it does |
| --- | ------------ |
| `reconcilePayments()` | asks each gateway what became of every pending attempt; closes the ones whose session has died |
| `finishPaidOrders()` | builds the account for any order that is paid but has no `activated_at` |
| `sweepDomains()` | checks delegations, serves what now points here, drops external domains past their grace period |

```
JOB_INTERVAL_MINUTES     5     how often a pass runs. 0 turns the timers off
JOB_BATCH                25    rows one job will touch in a pass
PAYMENT_SESSION_MINUTES  90    how long an attempt is worth asking about
PAYMENT_RECHECK_MINUTES  5     floor between two questions about the same attempt
DOMAIN_NS_GRACE_DAYS     3     how long an external domain has to point at us
DOMAIN_RECHECK_MINUTES   15    floor between two lookups of the same domain
DOMAIN_PROBE_DAYS        45    stop probing a domain that has never pointed here
DNS_RESOLVERS            1.1.1.1,8.8.8.8
```

**A timer, not cron.** Every job needs the same pool, adapters and provisioning
code as the web routes; a crontab entry would be a second copy of the boot
sequence maintained by hand. **If this ever runs on more than one node**, set
`JOB_INTERVAL_MINUTES=0` on all but one of them — the jobs are safe to run twice
(every write is guarded) but there is nothing to be gained by it.

Every job swallows its own errors and every one is batched: a sweep that throws
must not take the web server down, and a weekend's backlog must not open four
hundred sockets at once. The pass logs **only when something happened** — a line
every five minutes saying "nothing to do" is a log nobody reads, and this is a
log that has to be read on the day a payment goes missing.

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
  apps.js                the apps/runtimes broker client, and health()
  app-catalogue.js       what can be installed — half of a contract with
                         apps/broker.py, checked by `npm run check:apps`
  integrations/
    domainnameapi.js     registrar
    hestia.js            hosting node
  routes/
    pages.js  legal.js  domains-api.js  cart.js
    auth-routes.js  panel.js  setup.js  admin.js
    panel-apps.js  panel-databases.js  panel-files.js  panel-mail.js
terminal/  files/  apps/         the three root brokers, one per capability:
                         a shell, a customer's files, and installing/running
                         applications. Each is a small Python program, its
                         systemd unit and a README.
  coupons.js             discount code rules, in one place
views/
  partials/  public/  auth/  panel/  admin/
public/assets/           app.css, sections.css, cart.css, setup.css, panel.css,
                         files.css, terminal.css, apps.css,
                         app.js, domain-search.js, cart.js, setup.js,
                         panel.js, files.js, terminal.js, apps.js
public/assets/img/apps/  brand marks for the catalogue (Simple Icons, CC0)
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

**Two servers, two scripts.** They are not interchangeable and neither has been
taught the other's addresses on purpose — editing one to reach both would break
deploys of whichever site it was not pointed at that day.

```bash
./deploy-cloud.sh            # cloud.vesopa.com — the current product
./deploy-cloud.sh --schema   # also applies schema.sql
./deploy-cloud.sh --brokers  # also installs/refreshes the three root brokers
./deploy-cloud.sh --logs     # tail the right pm2 files

./deploy.sh                  # hosting.vesopaepos.com — the older box
```

`--brokers` is opt-in rather than part of every deploy: restarting them drops
every open terminal and file-manager session on the machine, which a routine
"push the CSS fix" should not do. Run it when `terminal/`, `files/` or `apps/`
has changed, and check what it prints — a unit that starts and then dies leaves
the panel silently on mock data, which looks exactly like everything working.

**pm2 is per user on the cloud box.** One daemon per Hestia account, as
`pm2-hestia@<user>.service`. Running pm2 as root there starts a *second* copy of
the app beside the running one and the two fight over the port; everything in
the script goes through `su - vesopasoftware`. On the older box every pm2
command names `vesopa_hosting` explicitly — never `pm2 restart all`, because a
number of unrelated applications share that account.

**Never re-run `v-add-nodejs-app` to restart something.** It regenerates `.env`
with a two-line stub: it is idempotent for the app and not for its environment,
and it has wiped a 57-setting file and left the app crash-looping on a missing
`DB_USER`. Restore the file and `pm2 restart`.

nginx needs a server block proxying the site's name to the app's port —
`127.0.0.1:5075` on the older box, `127.0.0.1:20001` on the cloud one.

---

## Applications

`/panel/apps` installs software onto a customer's site, `/panel/apps/node`
manages the Node processes, and `/panel/apps/runtime` picks the language version
and its settings. Three pieces:

| Piece | Where | What it is |
|---|---|---|
| Catalogue | `src/app-catalogue.js` | Names, blurbs, logos, what each app needs. No executable content. |
| Recipes | `apps/broker.py` | The commands, keyed by the same slug, running as the customer. |
| Panel | `src/routes/panel-apps.js` | Sends a slug and validated arguments, never a command. |

The two slug lists are a contract; `npm run check:apps` fails the build if they
drift, because a card with no recipe is a button that 500s.

**"Working" is a claim we only make when it is true.** pm2 reports `online` for
a process that exists — including one that is crash-looping, that never bound
its port, or that throws on every request. A panel repeating that word next to a
green dot tells a customer their broken site is fine, they believe it, and the
ticket arrives two days later. So `health()` in `src/apps.js` combines three
facts that are allowed to disagree — the pm2 status, the restart count read
against uptime, and a real HTTP probe of the app's port — and the pessimistic
one wins. That is the whole reason the Node pages exist.

**Nothing an install touches is deleted.** Every recipe assembles under
`~/.vesopa/build/<id>` and is moved into place only on success, and whatever was
in the web root goes to `~/.vesopa/replaced/<name>-<timestamp>`. A failed install
leaves the site exactly as it was.

**The mock is the same shape as the real thing.** With no broker socket the
whole feature is clickable on invented data, which is how the pages were built.
Two bugs have already come out of the mock diverging from the live answer — a
version list with no extensions, and a job with no `finished` flag that polled
for ever — so the two go through the same shaping code now. On a server this
must be `APPS_MODE=live`: the automatic fallback would report a dead site as
Working, and `npm run preflight` fails if it is not set.

## Not built yet

- **Crypto checkout** — shown at the checkout, disabled, with no adapter behind
  it. SSLCommerz, Stripe and PayPal are wired. Adding one is a matter of writing
  an adapter and having it report itself configured; `payments.gateways()`
  computes availability rather than being told it. A new adapter should also get
  a branch in `payments.reconcilePayment()` — without one, its abandoned
  attempts can only be aged out, never recovered.
- **Refunds** — `payments.status` has a `refunded` value and the API secret can
  sign a refund request, but nothing calls it. Refunds are manual at the gateway
  today, and must be worked out from `charged_minor`, not the order total.
- **Renewal charging through the gateway** — `next_due_at` is set and shown; no
  job charges a stored card, and no card is stored.
- **DNS templates** — records are editable one at a time. There is no "set this
  up for Google Workspace" button that writes five MX records at once.
- **Python app deploys** — advertised in the "vibe code" section alongside Node.
  Node is built (see *Applications* above); Python has no runtime on the node and
  no installer. Confirm before that section goes public.
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
