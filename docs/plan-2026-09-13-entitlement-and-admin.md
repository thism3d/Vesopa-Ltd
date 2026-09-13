# One place that knows what a venue has paid for (13 September 2026)

Licences, pricing, who may reach the admin, and what a Display does when it is
switched on. Written after reading the three systems that each hold a piece of
this and none of which reference the others.

---

## What exists, and why it cannot stay

**auth.vesopa.com already models the commercial truth**, and models it well:

| product | plan | quantity | status |
|---|---|---|---|
| epos | Till | 3 | active |
| kitchen | Kitchen screen | 2 | active |
| menu | QR dine-in menu | 1 | active |
| hosting | 100 GB | 1 | active |
| domain | vesopaepos.com | 1 | cancelled |
| display | Customer display | 1 | expired |

`subscriptions.quantity` **is** the licence count, and beside it sit `status`,
`renews_at`, `ends_at` and `payment_method_id`. There are `products` with a
`manage_url`, and `payment_methods`. This is a subscription system.

**The back office holds a second, poorer copy.** `bo_licence_limits` (added
11 September) holds the same number with no status and no lifecycle. Beside it
`offices.plan` is free text — `quarterly`, `Standard`, `Test Site`, `NULL` —
and `offices.till_licences` is NULL everywhere. Its own `subscriptions` table
is empty.

**Nothing joins them.** The auth subscriptions hang off `user_id = 4` with
`organisation_id` NULL — a person, not a venue. The back office keys everything
on `offices.contact_email`. There is no column anywhere that says which venue is
which customer.

The consequences are not theoretical:

* the same number is typed in two places and will drift, and the copy that is
  wrong is the one that refuses a kitchen screen during service;
* **status is ignored** — auth says the display subscription is *expired* and
  the domain *cancelled*, and the back office cannot tell, so an unpaid product
  works perfectly;
* Express and Loyalty have neither a product nor an OAuth application, so they
  cannot be sold or counted at all;
* `info@vesopasoftware.com` — the head of Vesopa, and the owner of the auth
  organisation — **has no back-office account of any kind.** The only admin is
  `muzahid@onzep.uk`.

---

## The shape

Two systems, two jobs, one number.

* **auth owns ENTITLEMENT.** What is paid for, how many, and whether it is
  active. It already has the products, the quantities, the statuses, the payment
  methods and the customer-facing `manage_url`. Nothing else may author this.
* **the back office ENFORCES.** Counting seats, binding a licence key to a
  machine, refusing the sixth till. That work stays exactly where it is.

`bo_licence_limits` is not deleted — it changes meaning. It becomes the local
**cache** of what auth said, plus a deliberate per-venue **override** for the
cases support needs one. It stops being the place a number is typed.

**It must fail open.** The seat code already lets a device through when the
database cannot be asked, on the grounds that a licence count must never be why
a venue cannot trade. The same rule applies to auth: if the entitlement service
is unreachable, the last known answer is used, and if there is none the device
is let through. A billing service being down must never shut a bar.

---

## 1. Finish the catalogue (auth)

* Add `express` and `loyalty` to `products`.
* Add OAuth applications for **Vesopa Kitchen**, **Vesopa Display**,
  **Vesopa Express** and **Vesopa Loyalty** — `is_first_party = 1`,
  `show_consent = 0`, same organisation.
* Set `show_consent = 0` on the existing first-party apps too. A venue should
  not be asked to authorise Vesopa to talk to Vesopa; that is the "one way in"
  rule, and it is currently being broken on every one of them.
* Move the six subscriptions from `user_id = 4` onto `organisation_id = 1`. A
  subscription belongs to a company, not to whoever happened to buy it.
* Record `info@vesopasoftware.com` (user 4) as an admin developer on every
  application, and set `applications.created_by`.

### The audience, and why this cannot be a flag day

Today `verifyTillToken` checks one `TILL_CLIENT_ID`, and the EPOS till, the
kitchen commission and the kiosk commission all check that same one. The error
it throws when a *kiosk* is refused reads "that token was not minted for the
till", which is the clearest possible evidence that this was reuse rather than
design.

Every device already in the field holds a token whose `aud` is the EPOS client.
So the split is staged:

1. each product gets its own client id;
2. `verifyTillToken` takes the client id it expects and accepts **either** that
   or the legacy EPOS one;
3. the apps ship pointing at their own client;
4. the legacy audience is dropped only once nothing is presenting it.

Step 2 is what makes this a change nobody notices instead of a Saturday morning
with no kitchen screens.

---

## 2. The entitlement API (auth)

`GET /api/entitlements/:organisationId` — machine to machine, first-party only.

```json
{ "organisation": 1,
  "products": {
    "epos":    { "quantity": 3, "status": "active",  "renews_at": "…" },
    "kitchen": { "quantity": 2, "status": "active",  "renews_at": "…" },
    "display": { "quantity": 1, "status": "expired", "ends_at":  "…" } } }
```

Status is returned rather than resolved, because what "expired" should *do* is
the back office's decision and differs per product.

---

## 3. The join, and the cache (back office)

* `offices.auth_organisation_id INT NULL` — the missing link. NULL means "not
  yet mapped", and an unmapped venue keeps today's behaviour exactly.
* A refresh, on a schedule and on demand, writes what auth says into
  `bo_licence_limits` with `source = 'auth'` and a `checked_at`.
* A row with `source = 'override'` wins and is never overwritten — that is the
  support escape hatch, and it is visible as an override rather than
  indistinguishable from the truth.
* **Status handling**: `active` → the quantity. `expired` or `cancelled` → a
  grace period during which the back office warns loudly and enforces nothing,
  and only then reduces. Nobody's till stops mid-service because a card expired.

---

## 4. The admin, signed in with Vesopa

> "vesopaepos.com/admin should have OAuth login, and info@vesopasoftware.com
> should be able to check and view all the licences, pricing, add new users to
> access the EPOS app — everything."

The back office already has *a* Vesopa sign-in: application 13, redirecting to
`/auth/vesopa/callback`. What is missing is that it grants nothing above an
ordinary office user, and that the person who should hold everything has no
account.

* Create `info@vesopasoftware.com` as a back-office user with `role = 'admin'`,
  reached through **Continue with Vesopa** rather than a password.
* Platform admin is decided by the Vesopa account, not by a row somebody
  remembered to set: an account that is staff on auth and a member of the Vesopa
  organisation is an admin here. One source of truth for that too.
* The admin area gains **Licences & pricing**: every venue, what each is
  entitled to, what it is using, what it costs, and what has expired — read from
  auth, with a link to `manage_url` to change it. Read here, changed there.
* **Add a user to EPOS** from the same screen: invite an address, choose the
  venue and the role. Today that is a manual INSERT.

---

## 5. Vesopa Display: connect first, pair second

> "keep the option as it is but the first screen should connect with Vesopa and
> verify the licences and then continue the till connection."

Today a Display is paired by a till and has no sign-in at all, which is why it
has no OAuth application and cannot be counted honestly.

The new first run is:

1. **Continue with Vesopa** — the same door as every other product.
2. The screen checks the venue's `display` entitlement. Within the quantity it
   claims a seat; over it, it says which displays hold the licences and offers
   to take one — the same sentence the till already uses.
3. **Then** the existing pairing with a till, unchanged.

Pairing is not replaced, it is preceded. A Display already in a venue keeps
working: the first screen appears on a fresh install or after a reset, and an
unmapped venue skips the check entirely.

This is also what lets the display licence mean anything. It is the one product
whose subscription is currently *expired* and whose screens work regardless.

---

## Order of work

1. Auth catalogue: products, applications, subscriptions onto the organisation,
   ownership. *(Data and configuration; no app changes.)*
2. Entitlement API, and the back-office join and cache. *(Both fail open.)*
3. The admin: Vesopa sign-in for `info@vesopasoftware.com`, licences and pricing,
   inviting users.
4. The audience split, with the legacy audience still accepted.
5. Display first-run.

Nothing in 1 or 2 changes what a venue sees. Nothing in 4 signs a device out.
5 is the only one that changes an app's first screen, and only on a fresh
install.

## Risks

* **A billing outage must never stop a sale.** Every path added here fails open,
  and the local cache is what it falls open onto.
* **An expired subscription is a conversation, not a cliff.** Grace, and a loud
  warning in the back office, before anything is refused.
* **Unmapped venues.** `auth_organisation_id` NULL means today's behaviour, so
  the mapping can be done one venue at a time rather than all at once.
* **The Display first run** is the only visible change; it is gated on a fresh
  install and on the venue being mapped.
