# Microsoft Store submission — Vesopa EPOS 1.6.5.0

Everything below is **copy-and-paste ready** for Partner Center. Nothing here
needs editing; the character counts are inside Microsoft's limits.

Package: `vesopa_epos/build/store/vesopa-epos-store.msix`
Identity: `MeirionDavies.Vesopa` — version **1.6.5.0** — `CN=3AD172E6-2CBA-4B09-AD50-B52C88D57FB3`

**Vesopa Customer Display is not part of this submission.** Nothing in it
changed, so it stays on 1.6.4.0 in the Store.

---

## What's new in this version

> Partner Center → Store listings → *What's new in this version*.
> Limit 1,500 characters. This is 969.

```
Lay out your dining room from the till.

Arranging a floor plan in a browser means doing it in an office, from memory, about a room you are not standing in. This release puts the same editor on the till itself, where you can see the room.

• Table shapes, not just "tables". Nine presets — two-tops, four-tops, a long six, booths, bar stools — each drawn in the proportions of the real thing. Tap one to put it down, then drag it where it belongs.

• Draw the room. Real rooms are not rectangles. Tap each corner of your room and tap the first one again to close it, and an L-shaped floor is drawn as an L — on the till, in the back office, and on your customers' phones when they pick a table.

• Your colours. Give a room its own floor and walls, and pick out the tables worth noticing — the window seats, the booths. An occupied table always stays the standard colour, so a busy table is never hidden by a paint choice.

Laying out the floor needs a manager sign-on.
```

---

## Short description

> Only if you are refreshing it. The existing one is still accurate; this is
> the same text with the floor plan mentioned.
> Limit 200 characters. This is 194.

```
Till, kitchen and back office for pubs and restaurants. Take payments, run tables, print to the kitchen, and let customers order from a QR code at the table. Lay out your floor plan on the till.
```

---

## Submission checklist

1. **Version.** The Store refuses a version it has seen before, including after
   a failed certification. 1.6.4.0 is already published, so this must go up as
   **1.6.5.0** — which is what the package declares. If this submission fails
   certification, bump to 1.6.6.0 before resubmitting rather than re-uploading
   the same package.

2. **Upload** `build/store/vesopa-epos-store.msix`. It is unsigned, which is
   correct for a Store submission — Microsoft signs it.

3. **Age rating, privacy policy and support contact** are unchanged from 1.6.4.
   Nothing in this release collects anything new.

4. **Screenshots** are unchanged and still accurate. The floor editor is not in
   them; add one only if you want to show it off.

5. **Do not submit the Customer Display.** It is on 1.6.4.0 and nothing in it
   changed.

---

## If certification asks what changed

Certification occasionally queries a release that touches networking. The
honest answer:

> The application already read its floor plan from the vendor's back office over
> HTTPS. This release adds three write operations to the same host so that a
> commissioned till can save changes to its own venue's floor plan. Each is
> authenticated with the terminal's existing signed token, and the venue is
> taken from inside that token rather than from the request, so a till can only
> ever modify its own venue's data. No new permissions, capabilities or data
> collection are introduced.
