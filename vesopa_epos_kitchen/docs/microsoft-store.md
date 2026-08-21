# Vesopa Kitchen in the Microsoft Store

Everything needed to build a package the Store will accept, and the identity it
has to carry.

## Identity

These are **assigned by the Store** and are not ours to choose. They are what
binds an upload to the listing; get either of the first two wrong and the upload
is rejected with a message about the publisher not matching.

| | |
| --- | --- |
| `Package/Identity/Name` | `MeirionDavies.VesopaEPOSKitchen` |
| `Package/Identity/Publisher` | `CN=3AD172E6-2CBA-4B09-AD50-B52C88D57FB3` |
| `Package/Properties/PublisherDisplayName` | `Vesopa EPOS Ltd` |
| Package Family Name | `MeirionDavies.VesopaEPOSKitchen_nyzwpk2n60a5j` |
| Store ID | `9P29NN3R5PGS` |
| Listing | https://apps.microsoft.com/detail/9P29NN3R5PGS |
| Protocol link | `ms-windows-store://pdp/?productid=9P29NN3R5PGS` |
| MSA app ID | `65138264-6da6-40b4-8a5e-a08d529bdbaa` |

The first three are in `pubspec.yaml` under `msix_config`. The rest are not
declared anywhere — they are calculated by the Store, and are here so a support
call or a deep link does not need a Partner Center login to answer.

### Why the identity still says "EPOS" and the app does not

The product is called **Vesopa Kitchen**. The package identity is
`MeirionDavies.VesopaEPOSKitchen`, from before the name was shortened.

That mismatch is deliberate and must stay. A package identity is registered and
immutable: changing it produces a *different application* as far as Windows is
concerned, so every installed copy would be orphaned and every customer would
have to find and install the new one. Changing the display name costs nothing
and is what a customer actually reads.

The same reasoning applies to the Dart package (`vesopa_epos_kitchen`), the
binary (`vesopa_epos_kitchen.exe`) and this directory. None of them is shown to
a customer.

## The package SID

```
S-1-15-2-1573717047-881371572-3275799542-2250686186-2856624974-3635625912-625410742
```

Only needed if a firewall rule, a service ACL or a loopback exemption has to
name this app specifically. Nothing in the current build requires it — the app
makes ordinary outbound HTTPS and WebSocket calls, which the two declared
capabilities already cover.

## Capabilities

| Capability | Why |
| --- | --- |
| `internetClient` | Reaching the back office over HTTPS and `wss://`. |
| `privateNetworkClientServer` | Reaching a back office on the venue's **own LAN**, which is how a site with a local server runs. Outbound only in practice, but the Store treats private-network access as one capability either way. |

Nothing else is asked for. In particular there is no `runFullTrust`: the app
prints through the standard print dialog rather than driving a printer directly,
so it does not need desktop-bridge privileges. Adding capabilities the app does
not use slows certification down and puts extra warnings on the listing.

## Building the package

```bash
cd vesopa_epos_kitchen
flutter build windows --release
dart run msix:create --store
```

`--store` produces an unsigned `.msix` for upload — the Store signs it. Do not
sign it locally; a package carrying our own certificate is rejected because the
signature will not match the registered publisher.

The output lands in `build/windows/x64/runner/Release/`.

### Version numbering

`msix_version` in `pubspec.yaml` is four parts, and **the last must be `0`** —
the Store reserves the revision field and rejects anything else. It tracks the
`version:` at the top of the same file:

```
version:      1.3.6+1        the Flutter version and build number
msix_version: 1.3.6.0        what the Store sees
```

Every upload needs a *higher* version than the last one, or Partner Center
refuses it. Bump the patch for a fix, and remember both lines.

## Icons

The Kitchen mark is a **recolour of the Vesopa brand mark**, not a redrawing:
`tool/make_icons.py` maps lime→chrome, white→lime, black→white, so the V's
angles are the brand's own pixels rather than something traced by hand.

```bash
python tool/make_icons.py assets/brand/512x512.png assets/brand/kitchen_mark.png
dart run flutter_launcher_icons
```

The first writes `kitchen_mark.png`, a multi-size `.ico`, and 44/150/256 PNGs
for the Store tiles. The second installs the `.ico` into
`windows/runner/resources/app_icon.ico`.

The inversion is the point: a venue running both the till and the kitchen screen
pins both to one taskbar, and two identical lime squares there is a chef opening
the till by mistake in the middle of a service.

## Before submitting

- [ ] `flutter test` passes
- [ ] `flutter build windows --release` succeeds and the built `.exe` shows
      **Vesopa Kitchen** under Properties → Details
- [ ] `msix_version` is higher than the last accepted upload
- [ ] The app was signed into against the live server at least once, since a
      certification tester will launch it and get the sign-in page
- [ ] Store listing screenshots are current — the board, the Counts tab, and
      the sign-in page

### What a certification tester will see

They cannot sign in: the sign-in page needs a venue's office email and a kitchen
login, which they will not have. That is expected and is not a crash — the page
renders, the on-screen keyboard works, and a wrong password is refused with a
readable message. Note it in the submission's *Notes for certification* so the
app is not failed for "cannot be evaluated".
