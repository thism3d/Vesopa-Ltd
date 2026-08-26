# Vesopa Kitchen 1.4.4 — release notes

Store submission: `msix_version: 1.4.4.0` (previous submission was 1.4.0.0).
Flutter `version: 1.4.4+5`.

Jumped from 1.4.0 to 1.4.4 to sit level with Vesopa EPOS, which is what this
release is about: the two now have to agree about what is on a ticket.

**Server: changes required, and already applied to live.** Deployed with
`.\deploy.ps1 -Schema` on 26/08/2026. `schema_screens_modifiers_lines.sql` adds
`is_modifier` to `epos_kitchen_ticket_lines`. Guarded and safe to re-run;
verified present on live.

**Update this alongside the till.** A till on 1.4.4 sends modifier lines to the
kitchen; a board on 1.4.0 receives them, but draws each one as a dish of its own
sitting beside the thing it belongs to — "Dash Coke" as a separate item next to
the gin. It is not wrong, but it reads as two orders rather than one.

An older till against this board is harmless: it sends no modifier lines and
nothing on the board changes.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. 650 of the 1,500 characters Partner Center allows.

```
Version 1.4.4.0 – Modifiers On The Board

Works with Vesopa EPOS 1.4.4.

Modifiers Under Their Dish: When a till asks how the steak is cooked or which mixer goes in the gin, the answer now appears on the board underneath the dish it belongs to — indented and in red, exactly as a typed note already did. No more reading "Rare" as a separate order sitting next to a steak.

Ticked Off Together: A modifier is part of its dish, so it is not something to cross off on its own. Tick the steak and its temperature is crossed through with it.

The Same On Paper: A ticket printed from the board reads the same way, with each answer indented under its item.
```

---

## What changed, in full

Almost nothing, and that is the point. `TicketLine` already had `seq` — "the
order the clerk rang them in; a kitchen reads a ticket top to bottom, and a
re-sorted ticket is a re-plated dish" — and already had a `note` drawn indented
in red under its line, described in the source as "the modifier ... the only
colour in the body of the card, which is what keeps it meaning *read this bit*
rather than becoming decoration."

So the board already had the concept and the styling. What it did not have was
any way to know that a line arriving from the till was an answer about the line
above it rather than a dish of its own. That is one boolean, carried from the
till through `epos_kitchen_ticket_lines` to here.

* A line marked as a modifier is drawn in the note treatment: indented, red,
  no quantity column, no station chip — the chip would only ever repeat the line
  above, since a modifier is routed wherever its dish is routed.
* It is **not** offered as something to tick off. Nobody crosses "Rare" off
  separately from the steak. It strikes through when its dish does, which is
  worked out from the dish above it in `seq` order.
* The detail sheet and the board's own PDF print draw it the same way, so the
  ticket a chef is looking at and the one that comes off the printer do not
  describe the same order two different ways.

### The icon it was actually shipping

Worth writing down, because it had been wrong since the app existed and nobody
had a reason to look.

`assets/brand/kitchen_mark.ico` has held a proper seven-frame icon all along.
It was never what shipped. `flutter_launcher_icons` is configured here with
`icon_size: 256`, and that package writes the runner's `app_icon.ico` with a
*single* image at that size — so it overwrote the good one, and what went out
was one 256x256 frame.

Windows then rescaled that frame for every context it uses. The two that matter
on a kitchen screen are the title bar and the taskbar, both 16px: a 256px mark
squeezed by sixteen at draw time, which is what made it look soft next to the
till sitting beside it.

`tool/make_windows_icon.dart` now builds all ten frames the shell asks for,
resampled once each from the 1024px master. It is the till's tool, which has
existed for exactly this reason — the kitchen simply never got a copy. Run it
after any `flutter_launcher_icons`, which will undo it again.

---

## Before submitting

1. `dart run tool/make_windows_icon.dart` if `flutter_launcher_icons` has been
   re-run since the last build — it overwrites the multi-frame icon with one
   256px frame.
2. `dart run msix:create --store`
3. `msix_version` can never be reused. If certification fails, bump to 1.4.4.1
   (or 1.4.5.0) before resubmitting — a resubmission at 1.4.4.0 is rejected.
