# A licence section in every product, and a lock when it lapses

Written after the entitlement work of 13 September, which put the quantities in
one place. This is the half a venue sees.

## What was asked

* Every product's settings gains a **Licence** section: the licence key, the
  device it is registered to, and how long the subscription runs.
* The admin **issues product keys**, grants a Vesopa account access, and watches
  subscriptions.
* When a subscription ends, the app **warns and then locks**.
* The admin decides **per account** whether locking applies at all.
* The Display's **Skip** goes: connect with Vesopa, then pair.

## Decisions taken with the owner

| | |
|---|---|
| What locks | **The app will not open.** Not read-only, not partial. |
| When it bites | **Immediately**, on the next config fetch. |
| Display offline | Sign-in required, but **remembered** — a screen that has connected once works offline for ever; only a never-connected one is held. |

### The concern, recorded once

Hard lock plus immediate is the most aggressive pair available. A venue whose
card expires unnoticed loses the ability to trade, mid-service, without warning
to whoever is standing at the till. That was put to the owner with the
alternatives and chosen deliberately, so it is what gets built.

Three rails follow from it, and none of them soften the decision:

1. **Locking is off per account and starts off.** Nothing locks anywhere until
   somebody switches it on for that venue. Deploying this changes nothing.
2. **The fourteen-day grace still applies.** `expired` does not mean locked
   until the grace is spent — the same grace the seat counts already use.
3. **An unknown answer never locks.** Entitlement unreadable, auth unreachable,
   venue unlinked, migration not run: the app opens. A billing service being
   down must never be why a bar cannot open, and that rule already runs through
   every layer of this system.

---

## The tasks

### 1. Server: the licence a device can see

- [ ] `offices.licence_lock_enabled TINYINT(1) NOT NULL DEFAULT 0` — the per-account switch.
- [ ] `GET /api/licence/state` — for a signed-in device, scoped to its own product:
      the key's visible prefix, the machine it is registered to, the subscription
      status and dates, and `locked` with a reason.
- [ ] Lock decision in one place (`licences.js`): locked only when the switch is
      on **and** entitlement is known **and** status is not active **and** grace
      is spent. Any unknown answers "not locked".

### 2. Server: the admin's side

- [ ] Toggle `licence_lock_enabled` per venue, from Licences & pricing.
- [ ] Issue a product key — **exists** (`POST /admin/offices/:id/licence-keys`).
- [ ] Grant a Vesopa account access — **exists** (`POST /api/users`, which invites
      through auth). Surface it on the licence screen rather than rebuilding it.
- [ ] Show, per venue: keys issued, which machine each is on, subscription dates,
      and whether locking is on.

### 3. The apps: a Licence section in settings

One panel, the same four facts, in each of EPOS, Kitchen, Display and Express:

- [ ] Licence key — the prefix only. The whole key is shown once when issued and
      is stored hashed; a settings page that could display it would make every
      screen in a venue a place to read one off.
- [ ] Registered device — the machine this licence is bound to.
- [ ] Subscription — status and the date it renews or ended.
- [ ] A renewal warning while the grace is running.

### 4. The apps: the lock

- [ ] On config fetch, a locked product shows a renew screen and nothing else.
- [ ] The screen says which venue, which product, and how to renew. A lock that
      does not say what to do is a support call.
- [ ] EPOS, Kitchen, Display, Express. Loyalty is a customer app and is not
      locked — a member of the public is not the person who has not paid.

### 5. Display: the Skip goes

- [ ] Remove "Set up later".
- [ ] A screen that has signed in once keeps its commissioning and works offline
      for ever after.
- [ ] A never-connected screen with no network says so and retries, rather than
      showing a dead button.

---

## Order, and why

1 before 2 before 3 before 4: the apps cannot show a licence until the server
can describe one, and cannot lock until it can say whether to. 5 is independent
and small, so it rides along with 3.

Nothing in 1 or 2 changes what a venue sees. 3 adds a panel. Only 4 can stop
anybody working, and only for an account somebody has switched it on for.

## Releases

EPOS, Kitchen, Display and Express all change, so all four are resubmitted. The
Store submissions are Manual, so nothing reaches a till until it is published.
