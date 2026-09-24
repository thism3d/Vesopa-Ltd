# Vesopa Customer Display 1.6.4 — release notes

Store submission: `msix_version: 1.6.4.0` (previous build here was 1.6.3.0).
Flutter `version: 1.6.4+5`.

**Install this alongside the 1.6.4 till.** Unlike 1.6.3, which was a till-side
fix a screen could sit out, this release has both halves of one feature in it:
the child lock is written by the till and read by the display, so a 1.6.4 till
talking to a 1.6.3 screen can turn the lock on and nothing will happen.

---

## What changed

### Connected means connected

The bar along the bottom used to say **"The till is not running"**. It said it at
screens that were, at that moment, drawing that till's bill — and it said it
during every quiet spell in a working service.

The cause was a category error. The till writes a heartbeat every few seconds,
and the display was reporting whether it had seen one recently. But this screen
publishes its state only when something it cares about actually changes,
otherwise the whole screen would rebuild every few seconds and restart a playing
advert — so the timestamp it was measuring against was frozen at the last
publish, and went stale twenty seconds later however fresh the file on disk was.

The bar now reports the **pairing**, which is the honest answer to "what is this
screen connected to": it is the thing that would have to be undone for the
answer to change. A till that is merely quiet has not disconnected from
anything.

### The controls moved, and hid

- **Top right: volume and settings.** The top right is the one part of a
  customer display nothing important ever occupies, and it is where a hand
  already goes — whoever is setting the screen up is standing at the till,
  reaching across the counter.
- **Bottom: what it is connected to**, out of the way of both the bill and the
  advert.
- **Both are hidden until the screen is tapped**, and both leave together after
  the delay the venue chose: 5, 10, 15 seconds, 1, 2, 5 minutes, or never.
- **Volume is on the bar** rather than only in settings. It is the one thing on
  this screen anybody changes twice a day — a function room at lunchtime and the
  same room at nine in the evening want different answers, and neither is worth
  walking into a settings page for. The speaker icon opens a slider and puts it
  away once it has been set.

### The settings header was invisible

Not missing — invisible. Material 3 paints a header in the theme's surface
colour, which on this screen is the same value as the page behind it, so the
title, the back arrow and the whole bar were being drawn onto an unlit strip.
Somebody looking for the way out of Settings found nothing to aim at.

It now has its own colour, a line under it, and a **Back button with the word
on it** — a bare chevron on a screen mounted on a bracket is a 24-pixel target
that half the people who need it do not recognise. It is pinned, as it always
was, so setting the advert folder at the bottom of a long page does not mean
scrolling back to the top to leave.

### Five settings that were never saved

`advertVolume`, `billOnRight`, `billShare`, `fillScreen` and `standingMessage`
were on the settings object and in `copyWith` and in **neither** the read nor
the write. A manager set them, they applied for the session, and they were gone
by morning. They are saved now.

### The child lock

The till can tell this screen to ignore being touched. It carries on showing the
bill and the adverts; a tap says the screen is locked and where to unlock it,
and does nothing else.

There is deliberately no switch for it here. A lock the locked screen can undo
is not a lock.

### Orders from the tables need nothing here

The till's new dine-in feature puts a customer's phone order onto a table's bill.
Nothing in this application had to change for that, and nothing did: an accepted
order is an ordinary line on an ordinary bill by the time it reaches this
screen, and it draws exactly as a keyed one does. It is worth saying plainly
because it is the point — a feature that needed a special case on the customer
display would be a feature that had not been finished on the till.

### Reporting itself properly

The screen now tells the till the size it is actually running at, which is not
the same question as what its monitor could do — a display left windowed on a 4K
panel reports 1280x720, and that is the number a manager needs to see before
they wonder why the bill looks small. It also reports whether the lock is really
on, so the till shows what is true rather than what it last sent.

---

## Microsoft Store — "What's new in this version"

```
Version 1.6.4.0 - Connected Means Connected

No More "Waiting For The Till": A screen showing a live bill no longer reports the till as missing. It says what it is connected to, and stays saying it.

Controls Where Your Hand Goes: One tap brings up volume and settings in the top corner and the connection along the bottom, and they hide themselves again after a delay you choose - five seconds to five minutes, or never. Nothing sits over the adverts until you ask for it.

Volume Without A Settings Page: A speaker on the top bar opens a slider and puts it away once you have set it.

A Settings Screen You Can Leave: The header at the top of Settings is now visible, stays put as you scroll, and has a Back button with the word on it.

Your Settings Are Remembered: Advert volume, which side the bill sits on, how wide it is, whether pictures fill the screen and your standing message are all saved now, instead of resetting overnight.

Child Lock: Your till can lock this screen so it ignores being touched, for a counter with children at it or a cloth at the end of the night. It keeps showing the bill throughout.
```

---

## What was tested

- The display suite passes, including a regression test for the staleness bug
  above: "a presence that has gone stale is not still reported as running".
- The pairing contract test moves with the version, which is what keeps the two
  applications from being released out of step. `till-presence.json` was
  regenerated at 1.6.4 and the display's own contract test re-run against it —
  it had been left reading 1.6.3 after the version bump, which is the exact
  mistake the file exists to catch.
- Both store packages were verified by reading `AppxManifest.xml` out of the
  built `.msix` rather than by trusting the filename, which never carries a
  version: `MeirionDavies.Vesopa` and `MeirionDavies.VesopaDisplay`, both
  `1.6.4.0`.
- The full split-screen behaviour was checked on a real pair of applications
  with a real order: a bill on one side, a full-bleed advert on the other.
