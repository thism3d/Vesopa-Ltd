# Vesopa EPOS 1.6.1 — release notes

Store submission: `msix_version: 1.6.1.0` (previous build here was 1.6.0.0).
Flutter `version: 1.6.1+22`.

**Vesopa Customer Display goes to 1.6.1.0 with it**, and the two must ship
together: this release adds a control channel between them, and a till on 1.6.1
paired with a display on 1.6.0 gets a display that ignores everything set on the
till. Flutter `version: 1.6.1+2`.

**Vesopa Kitchen does not move.** Nothing in it changed. It stays on 1.5.0.0.

**Patch, not minor.** Nothing here changes how the till takes money. It is the
customer display growing up: found automatically instead of configured by hand,
set up from the till instead of from a screen with no keyboard, and able to play
the video it always claimed to.

**Server: no changes.** No migrations, no new dependencies, nothing to deploy.

---

## The till now says where it writes

`%PROGRAMDATA%\Vesopa\customer-display.json`, rewritten on every start.

Until now the display worked its own way to the till's basket file, and doing
that meant knowing two things that are facts about how the till happens to be
built rather than promises: that path_provider composes the folder from the
executable's `CompanyName` and `ProductName` resources, and that the Store then
redirects the whole thing into a package folder whose name ends in a hash of the
publisher.

Both were wrong in the display's own code. It looked under
`%LOCALAPPDATA%\com.vesopa\vesopa_epos\`, which is not where any till has ever
written. A display installed beside a till would have found nothing and shown the
setup card, and the fix for that would have been reading a path down the phone.

So the till says it instead, in ProgramData — the one place that is not
virtualised for a packaged app and is readable by every account on the machine.
The display reads that first and computes nothing.

Best effort throughout: a machine whose ProgramData cannot be written to loses
the note and nothing else.

## Settings → Customer display

A new page. Everything the display does is on it:

- **which screen**, listed by number and resolution as the display itself
  reported them, and applied the moment you pick one so you can look up and
  check you got the right monitor;
- **full screen**, on by default;
- **the advert folder**, with a live count of what it found in there;
- **how long each picture stays up**, and **how long before the adverts take the
  whole screen**;
- **sound on video adverts**, off unless you turn it up;
- **fill the panel**, cropping an advert to fill rather than letterboxing it;
- **which side the bill is on**, and **how much of the screen it takes**;
- **a line across the bottom of the adverts** — "Ask about our loyalty card";
- **whether a price shows against each line**, and the message after payment.

Every change is written immediately rather than behind a Save button, because
the display applies within about two seconds and the point is to watch it happen.

At the top, whether a display is actually running. Every control on the page is
pointless if nothing is listening, and "I changed it and nothing happened" is the
support call that card exists to prevent.

**The protocol** is two more files beside the basket:
`settings.json`, which the till writes and the display reads, and `status.json`,
which the display writes and the till reads. Same folder, same reasoning as the
basket — see `lib/data/customer_display_control.dart`.

The status file is what makes the screen picker possible at all: the till cannot
enumerate the display's monitors, so it asks the display to report them and
offers back what it was told.

---

## In the display itself

**It puts itself on the right monitor.** It never could before — it opened
1280×720 on the primary screen, which on a two-screen till is the till's own
screen, and somebody had to drag it across and maximise it every morning. The
monitor is remembered by the panel's hardware id rather than by the port it is
plugged into, so unplugging both screens to move the counter and plugging them
back the other way round does not leave the bill facing the wall.

**Proper full screen**, with no title bar and nothing to drag. Escape always
brings the window back, and there is an Exit in the display's own settings — the
same question the till asks before closing, in the same place.

**Video adverts actually play.** They never did on Windows. The `video_player`
plugin has no Windows implementation registered at all, so every MP4 failed
silently. Adding one was not enough either: the obvious choice goes through
Windows Media Foundation, which is absent on Windows Server and on N editions of
Windows and wants a GPU it can talk to, and on a machine without it the failure
took the whole process down — a black customer screen with nobody watching it for
faults.

The display now carries its own decoder (`media_kit`). That is most of the
package's 34 MB and worth it: the venue's promo is whatever their agency
exported, on whatever PC is under the counter.

**A clip that will not play is struck off rather than retried.** In a folder
holding one video, a failed open used to advance to the next advert — which
wrapped straight back to the same file, opened it again, and span until the
process died. Now the file is remembered as broken and skipped, the list is
cleared when the folder changes, and if everything in the folder fails the panel
falls back to the Vesopa card.

**Leaving full screen restores a window you can see.** A window made full screen
before it was ever shown has no earlier size for Windows to put it back to, and
turning full screen off left it at zero by zero — running, invisible. It now
always ends with an explicit size.

**Branding.** The window title bar, the taskbar and the executable's own file
properties all said `vesopa_epos_display`. They say Vesopa Customer Display now.

---

## Store submission

| | Vesopa EPOS | Vesopa Customer Display |
| --- | --- | --- |
| `version:` | 1.6.1+22 | 1.6.1+2 |
| `msix_version:` | 1.6.1.0 | 1.6.1.0 |
| Identity | `MeirionDavies.Vesopa` | `MeirionDavies.VesopaDisplay` |
| Store ID | already listed | `9P8JCLQ5M3SQ` |
| Package | `build\store\vesopa-epos-store.msix`, 20.2 MB | `build\windows\x64\runner\Release\vesopa_epos_display.msix`, 33.9 MB |

**The fourth part of a Store version must be 0.** Microsoft reserves the revision
field and rejects a package that sets it.

**The display's identity is not its display name, and that is fine.** Three names
are reserved for it — Vesopa Display, Vesopa EPOS Display and Vesopa Customer
Display — and Partner Center cut the identity from the first
(`MeirionDavies.VesopaDisplay`, package family
`MeirionDavies.VesopaDisplay_nyzwpk2n60a5j`) while the tile, the window and the
taskbar all say the third. Nothing needs reconciling.

Listing copy for both apps is in `docs/store-listing.md` in each project, with
every field's character count checked by `tool/check-store-listing.py` at the
repository root.

Build both with `pwsh tool/build-store-msix.ps1` in each project. Verify by
reading `AppxManifest.xml` out of the .msix rather than trusting the filename,
which never carries the version.

## What's new in this version — for the till's Store listing

> The customer display is now set up entirely from the till. A new page under
> Settings → Customer display chooses which monitor it uses, where your adverts
> come from, how the screen is split and what the customer reads — and tells you
> whether a display is connected. The display also finds this till on its own,
> with nothing to type in.
