# Partner Center — what to paste, 1.6.6.0

Two submissions. The kitchen app is unchanged and is not resubmitted.

---

## Vesopa EPOS 1.6.6.0

Partner Center → Submission → **Release notes**. 1,443 characters.

```
Split a bill the way a table asks for one. The bill starts as a pool: pick a
few items, press once, and they become a share of their own. The pool drains
to zero in front of you. Every share is a card with its own total, its own
bill to print and its own Pay Now button, so three people can have three
slips before anybody pays.

By round splits a table two people served an hour apart in one press.

An offer on the bill is now shared out in proportion, rather than going
entirely to whoever paid first.

Refund mode. Find the sale, tick what is coming back, and the screen says how
it was paid so it goes back the same way. Refunds without a receipt need a
manager and a reason.

Barcodes. Scan a product and it rings up. Scan one the till has never seen and
it offers to add it, and sends it to the back office so every till gets it.

Count the drawer. Enter the float at the start of a shift, and count up at
the end if you want to: the Z then prints BALANCED, OVER or SHORT.

New keys you can place anywhere: Table Plan, Price Check, Product Search,
Price Override, Refund and Split.

Reprint any Z report from the last seven days.

Also: the customer now shows on the bill with a way to change them; products
can be marked as modifiers that only sell attached to another item; the check
view fits a 4:3 till properly; the payment screen takes your own top and
bottom bars; and repeated items can be listed separately instead of added up.
```

---

## Vesopa Customer Display 1.6.5.0

Partner Center → Submission → **Release notes**. 409 characters.

```
The finished sale now holds on screen for its own time rather than the idle
time — twenty seconds by default, and adjustable from the till or here. Ringing
anything up before then shows the new sale straight away.

That figure used to be the same one that decides when adverts take over a bill
still being rung up, which is a different question: a paid sale is somebody
checking their change and walking away.
```

---

## Checks before uploading

* Package identity is assigned by the Store and must match character for
  character. Both packages were verified after building:
  * `MeirionDavies.Vesopa` / `CN=3AD172E6-…` / **1.6.6.0** / x64
  * `MeirionDavies.VesopaDisplay` / `CN=3AD172E6-…` / **1.6.5.0** / x64
* Both are **unsigned**, which is correct — Microsoft signs Store packages.
* A version can never be reused. A resubmission after failed certification
  needs another bump in `pubspec.yaml` (`version:` **and** `msix_version:`).

## Files

* `vesopa_epos/build/store/vesopa-epos-store.msix` — 19.9 MB
* `vesopa_epos_display/build/store/vesopa-display-store.msix` — 33.5 MB
