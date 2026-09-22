# Vesopa EPOS 1.3.5 — release notes

Store submission: `msix_version: 1.3.5.0` (previous submission was 1.3.4.0).
Flutter `version: 1.3.5+8`.

1.3.4.0 shipped the new sale screen and the six kitchen printers. This release
is about the printing underneath them: how the bytes actually reach the paper,
and what happens when they do not.

Server: already deployed, including `schema_printer_names.sql`. On a fresh
server run the migration set as usual — every file is guarded, so
`deploy.sh --schema` (or `deploy.ps1 -Schema` on Windows) can run the whole
`schema_*.sql` set on every deploy.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. Written for a venue owner: no spooler internals, no API names, and
every claim is something they can see happen. 1,460 of the 1,500 characters
Partner Center allows — check the count again if you edit it.

Prose rather than bullets, matching how 1.3.4.0 was written.

```
Version 1.3.5.0 – Printing That Doesn't Wait, and a Printer for Every Job

Printing has been rebuilt. Receipts and kitchen tickets now go straight to the printer instead of queuing through Windows — the difference between paper appearing now and paper appearing eventually.

Direct Printing: USB printers are driven directly, with the Windows print spooler out of the way entirely. Network and serial printers already worked this way. A printer already set up in Windows can still be picked from a list. Every printer gets a Test Print key, so you find a problem while setting up rather than with a customer waiting.

A Printer for Every Job: Choose a different printer for the customer's receipt, your own copy, the bill, the X and Z reports, the cash drawer, and each kitchen station. Your own copy can print on card sales, every sale, or never. Anything you don't set follows the receipt printer, exactly as before.

Kitchen Tickets: A marker in the top right tells you the kitchen got the ticket, without ever interrupting a sale. If a station fails you are told which one, and can send it again to just that station. A dead printer at one station no longer causes duplicate tickets at the others.

Printer Names: Name your printers once in the Back Office — call KP 3 "Fryer" and it reads Fryer on the tills, on the tickets and in your product list. The receipt printer can now take kitchen tickets too, so the counter gets its own copy of an item.
```

---

## What changed, and why

### Printers and jobs are no longer the same thing

A printer used to *be* "the receipt printer" — the job was a property of the
device. That made the thing venues most often ask for impossible to say: the
customer's copy on the counter printer and the venue's own copy on the printer
in the office.

Now a printer is a device, and a **target** is a job. Targets are KP 1–6, the
receipt printer, the merchant copy, the bill, the X/Z report and the cash
drawer. Any target can point at any device, and several can share one — which
is the small venue with a single printer.

Unset targets follow a fallback chain to the receipt printer, so a terminal
that upgrades and never opens the screen behaves exactly as it did. The
kitchen stations deliberately have **no** fallback: food routed to KP 3 with no
KP 3 set up is reported, never quietly printed at the counter where nobody in
the kitchen would see it.

Existing settings migrate on read. Each old printer becomes a device and its
old role becomes that device's one assignment. Covered by
`test/printer_settings_test.dart`.

### Direct printing, and what "direct" honestly means

Four connections, three of which put the bytes on the wire themselves:

| Connection | Spooler in the path? | Where it works |
| --- | --- | --- |
| USB (direct) | **No** | Windows |
| Network (9100) | **No** | Everywhere |
| Serial / COM | **No** | Desktop |
| Windows printer | Yes, as a RAW job | Windows |

USB direct writes to the printer's `usbprint.sys` device interface with
`CreateFile`/`WriteFile`. No driver renders anything, nothing is queued, and no
driver swap is needed — `usbprint.sys` is the in-box driver Windows binds to a
printer installed the ordinary way. Printers are discovered by walking the
device tree, so the setup screen lists what is actually plugged in rather than
asking anyone to type a device path.

The Windows printer option sends the same raw ESC/POS to a named queue under
the `RAW` datatype. The driver still renders nothing, but the spooler does queue
it. It is kept for printers already set up in Windows, printers on a Windows
share, and any printer whose vendor driver does not expose a `usbprint`
interface. The setup screen says which of the two a printer is using rather
than letting anyone assume.

Both Win32 paths block until the printer has taken the bytes, so both run on a
worker isolate. A printer that has run out of paper can hold a write open for
seconds; doing that on the UI isolate would freeze the sale screen mid-service,
which is the exact thing direct printing exists to prevent.

### The kitchen tells you when it failed

Kitchen tickets fire after the order is saved or the money is taken, so by the
time anything can go wrong the sale is done and the next customer is already at
the counter. The old behaviour put a message in the middle of the screen and
offered nothing to do about it.

Now the outcome goes to a chip in the top bar, beside the sync badge. It never
blocks anything. A clean run clears itself after a few seconds; a failure stays
until it is dealt with, and opens a list of exactly which stations printed and
which did not — with a **Print again** that re-sends the same ticket to only
the stations that failed.

This also fixes a real bug. Lines used to be left unsent after a partial
failure, so the *next* save re-fired them: a venue with one dead printer got a
duplicate ticket at every working station every time anybody touched the bill.
Lines are now marked once the run is over, and the failed stations are reported
instead.

### Naming belongs to the venue, hardware belongs to the till

Which IP, which USB device, which COM port stays on the terminal, because that
is physical to a counter — two tills in the same room have different printers
plugged into them.

What the venue owns is the vocabulary. Back office → **Till & printers** now
names the seven slots, and the name reaches every till through the till-settings
row the terminal already fetches. Call KP 3 "Fryer" and it reads "Fryer" on the
product editor, in the catalogue, on the printer setup screen, and at the top of
the ticket that comes out of it.

### Known issues, unchanged by this release

Three tests were already failing on `main` before this work and still are:
`functions_page_layout_test` (stale golden), `widget_test` (pending-timers
assertion) and `dojo_terminal_live_test` (needs a live account).
