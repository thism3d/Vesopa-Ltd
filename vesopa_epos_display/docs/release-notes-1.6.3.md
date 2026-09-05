# Vesopa Customer Display 1.6.3 — release notes

Store submission: `msix_version: 1.6.3.0` (previous build here was 1.6.2.0).
Flutter `version: 1.6.3+4`.

Ships alongside **Vesopa EPOS 1.6.3.0**, whose notes are in
`vesopa_epos/docs/release-notes-1.6.3.md`.

## Read this before planning the rollout

**This is a version-only release. Nothing in this application's behaviour has
changed.** The two lines of code that differ from 1.6.2 are the version constant
this screen reports to the till and the one it writes into `status.json`.

The fault a venue reported — a screen that pairs, says "paired", and then sits
on "Waiting for the till" — **is fixed in the till, not here.** So:

- A venue that updates the till and leaves its screens on 1.6.2 gets a working
  display within about five seconds of the till starting.
- Nobody re-pairs anything, on either version.
- Installing 1.6.3 on the screens is tidiness, so the version the till lists
  beside each display matches the till's own.

If a rollout has to be staged, **update the tills first**. Updating only the
screens fixes nothing.

## Why the fix belonged in the till

This screen never decides where the bill comes from. It follows the path the
till hands it in the pairing grant, and derives `settings.json` and
`status.json` from that file's own folder — it computes nothing and stores no
location of its own.

The till was writing `basket.json` into its application data folder, which on a
Store install is private to that package: no other application may open it. So
the grant handed this screen a perfectly accurate path to a file it was not
allowed to read, the feed never advanced, and the screen correctly reported the
till as silent. It was right about everything except where to look, and it had
been told where to look by something that was wrong.

In 1.6.3 the till writes to `%PROGRAMDATA%\Vesopa\display\<terminal>` — beside
the pairing handshake, in a folder both applications have been reading and
writing successfully for as long as pairing has worked. This screen follows the
new path without knowing anything has changed, which is exactly what it was
built to do.

## What is now tested that was not

Both applications had tests for the handshake, and both wrote *the other side's*
files by hand to do it. That is a test of a fixture rather than of a contract,
and it is precisely how both suites stayed green while a venue looked at a
paired screen showing adverts.

There is now one contract, checked from both ends. The till's
`pairing_contract_test.dart` drives its real code and commits the files it
actually writes to `docs/pairing-contract/`; this package's test of the same
name reads those files with this application's real parser and pairing ladder.
Putting the old application-data path back into the contract turns this side
red — which is the check that was missing.

74 of this application's tests pass on a quiet machine. Two of them —
`control_test`'s "a change from the till arrives once" and `display_test`'s
"a truncated one leaves the last good bill on screen" — time out when the
machine is busy and pass repeatedly on their own. Both are timing tests over a
poll loop, both did it before any of this work, and neither is a signal about
the code under test. Worth chasing separately.

---

## Microsoft Store — "What's new in this version"

Paste into Partner Center → Store listings → What's new in this version.

```
Version 1.6.3.0 - Reconnects To The Till

Screens that paired and then sat on "Waiting for the till" now show the bill again. The two applications meet in a folder both are allowed to open.

Nothing is re-paired and nothing is set up again: update the till software and the screen reconnects on its own within a few seconds. The fix is in the till, so this update is optional - it keeps the version shown beside each screen in step with the till's.
```

---

## Store submission

| | Value |
| --- | --- |
| `version:` | 1.6.3+4 |
| `msix_version:` | 1.6.3.0 |
| Identity | `MeirionDavies.VesopaDisplay` |
| Store ID | 9P8JCLQ5M3SQ |
| PFN | `MeirionDavies.VesopaDisplay_nyzwpk2n60a5j` |
| Package | `build\store\vesopa-display-store.msix`, 33.3 MB |
| Manifest checked | `Version="1.6.3.0"`, one capability: `runFullTrust` |

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it.

Build with `powershell tool/build-store-msix.ps1`. Verify by reading
`AppxManifest.xml` out of the .msix rather than trusting the filename, which
deliberately does not carry the version — the script prints the Identity line at
the end of every build.

**Where the package lands changed this release.** It was written to
`build\windows\x64\runner\Release\` under a name identical for every version
ever built, and found afterwards by searching `build\` for the newest `.msix` —
which is not reliably the one the run produced, because a failed build leaves
the previous one in place. It is now pinned to `build\store\`, as the till's has
been since it hit that problem.
