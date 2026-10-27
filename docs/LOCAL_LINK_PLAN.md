# Vesopa Local Link — devices talking on the venue's own network

Asked by Nicki (Pontardawe RFC), 2026-10-27: "Any luck with getting 2 or more
terminals to talk to each other through local IP? to share table plan etc …
needs to be locally just in case they lose internet. Newbridge does it by
windows file sharing but I find it poor. ICR uses each till's IP to
communicate … and needs to be kind of instant."

## Today

Everything that crosses devices goes through the cloud back office:

| What | Route today | Without internet |
|---|---|---|
| Open bills / table plan | each till pushes, others poll every 3 s (bill_sync.dart) | each till on its own |
| Kitchen tickets | POST /till/kitchen/tickets, queued on failure (kitchen_screens.dart) | kitchen gets nothing until it is back |
| Customer display, same PC | loopback WebSocket + files (display_link.dart) | works |
| Customer display, other PC | back office /ws relay | blank |
| Vesopa Go | back office API, own outbox | queued |
| Points, gift cards, vouchers, memberships | back office, checked there | not available |
| Card payments (Dojo/Teya) | the provider's cloud | not available (unchanged by this plan) |

No device reports its LAN address, so we do not yet know whether a venue's
network lets devices see each other (Wi-Fi client isolation, guest networks).

## Decisions (owner, 2026-10-27)

- **Shape:** one main till hosts the link; the others connect to it; another
  till takes over automatically if it goes off. The cloud stays in sync for the
  back office.
- **Main till:** chosen automatically (longest running); the back office can
  pin a preferred one.
- **Scope:** everything — tables, kitchen tickets, displays on another PC,
  Vesopa Go, and the rest of the shared data.
- **Who may join:** devices signed in to the same venue, traffic encrypted. A
  guest on the club Wi-Fi can neither read nor send.
- **Firewall:** the EXE installer adds a private-network rule; a Store install
  shows Windows' prompt once and an admin clicks Allow.
- **Balances offline:** the main till holds points, gift cards, vouchers and
  memberships, applies spends in order, and syncs to the cloud when it returns.
- **Conflicts on reconnect:** newest change (main till's clock) wins; the other
  is logged in the back office.
- **First step:** check the venue's network before building.

## Phases

### 1. Network check (small, ships first)
Tills, kitchen and display report on their heartbeat: their LAN addresses,
network type (private/public profile), and whether a UDP broadcast and a TCP
probe reach the other devices of the venue. Go reports the same from the
phone. Shown in admin › venue › devices as a reachability grid. Nothing listens
beyond the probe; no behaviour changes.

### 2. The link (tills)
- Discovery: UDP broadcast + mDNS (`_vesopa._tcp`), venue-scoped.
- Main-till election with heartbeat and takeover in a few seconds.
- Secure WebSocket on the LAN; join by venue key (issued by the back office,
  per venue, rotated), mutual challenge, encrypted frames.
- Open bills move over it at once; the cloud poll remains the backstop.

### 3. Kitchen and displays
Kitchen screens and other-PC displays connect to the main till; tickets,
bumps, recalls and baskets move locally; the cloud relay stays as fallback.

### 4. Balances and the rest of the data
Main till keeps the ledger for points, gift cards, vouchers, memberships while
offline; journal replayed to the cloud on reconnect with conflict logging.

### 5. Vesopa Go
Go finds the main till on the LAN (iOS Local Network permission + Bonjour
entry), sends orders and reads tables through it, cloud as fallback.

### 6. Installer and rollout
Firewall rule in the EXE installer; Store package declares
privateNetworkClientServer. Venues updated only when the owner says.

## Status (2026-10-27)

Built: phases 1-4 and 6 (EPOS 1.16.33, Kitchen 1.7.16, Display 1.7.6, back office).
Phase 5 (Vesopa Go) left out at the owner's request.

- Library: `vesopa_epos/lib/data/lan/lan_link.dart` + `lan_service.dart`, copied into the
  kitchen and display by `tool/sync_lan_link.py`. Plain TCP with TCP_NODELAY (not a
  WebSocket: Nagle could hold a small frame ~200 ms on Windows); HMAC-SHA256 keystream +
  encrypt-then-MAC per connection; UDP 47820 discovery, TCP 47821 link.
- Measured on loopback: one change ~1 ms median, p95 2.3 ms; a bill reaches the other
  till in ~70 ms end to end with the cloud timing out (the local pass never waits on it).
- Devices are known by their own random id, never MAC or IP: Wi-Fi MAC randomisation
  and new DHCP leases are followed at the next announce (tested).
- Firewall: rule "Vesopa local link", all profiles (Public networks too); installer asks
  once on a manual till install; Settings › Local network has Allow for Store copies.
- Will not work across Wi-Fi client isolation / a guest network that blocks devices from
  each other: the back office's Devices › Local network shows it, and everything falls
  back to the cloud as before.
- Offline money: `offline_ledger.dart` (rules) + `offline_money.dart`; server
  `/api/lan/snapshot` (lists replayed ids) and `X-Vesopa-Offline-Id` dedupe (src/lan.js).
- Tests: vesopa_epos test/lan_link_test.dart, lan_offline_test.dart; kitchen
  test/lan_kitchen_test.dart; server test/lan.test.js.
