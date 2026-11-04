/// Vesopa Go as a Vesopa Kitchen screen (owner, 2026-11-03).
///
/// The Windows kitchen screen's board (tickets from the back office and,
/// first, from the tills over the venue's network; bump, cross off, recall,
/// rush; queued while offline), drawn for a phone or an iPad:
///
///   iPad / wide   the open tickets in a grid of equal boxes, oldest first,
///                 rushed at the front, each with its Done button; a ticket
///                 with more than fits opens whole when tapped (2026-11-04)
///   phone         one column; swipe a ticket left to mark it done, right to
///                 rush it, the way Mail's swipe actions work
///
/// Ages turn amber, then red, at the board's own times. A new ticket chimes
/// and the device taps. The screen stays awake. Settings are behind a
/// manager's PIN (lib/modes/mode_settings.dart).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../../modes/mode_settings.dart';
import '../../ui/pages/connection_page.dart';
import '../../ui/sounds.dart';
import '../../ui/theme.dart';
import '../../data/lan/lan_service.dart';
import '../data/dinein_orders.dart';
import '../data/kitchen_api.dart';
import '../data/kitchen_session.dart';
import '../data/providers.dart';
import '../data/screen_profile.dart';
import '../data/ticket.dart';
import '../kitchen_printer.dart';

const _amber = Color(0xFFFF9F0A);
const _red = Color(0xFFFF453A);

enum _Tab { open, done, orders }

class KitchenModePage extends ConsumerStatefulWidget {
  const KitchenModePage({super.key});
  @override
  ConsumerState<KitchenModePage> createState() => _KitchenModePageState();
}

class _KitchenModePageState extends ConsumerState<KitchenModePage> {
  _Tab _tab = _Tab.open;
  String? _problem;
  bool _starting = false;
  String? _boardFor;
  final Set<String> _flash = {};

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable().catchError((Object _) {});
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  @override
  void dispose() {
    WakelockPlus.disable().catchError((Object _) {});
    super.dispose();
  }

  /// The kitchen credential for this venue, then the board.
  Future<void> _start() async {
    if (_starting) return;
    _starting = true;
    setState(() => _problem = null);
    try {
      var session = await ref.read(kitchenSessionProvider.future);
      final venue = ref.read(tapProvider).venue;
      if (!session.signedIn || session.office != venue?.office) {
        final r = await ref.read(apiProvider).goModeToken('kitchen', deviceName: ref.read(tapProvider.notifier).terminalName);
        await ref.read(kitchenSessionProvider.notifier).startWith(
              token: '${r['token']}',
              office: '${r['office'] ?? venue?.office ?? ''}',
              venue: (r['venue'] as String?) ?? venue?.name,
            );
        session = ref.read(kitchenSessionProvider).value ?? session;
      }
      if (!mounted) return;
      final board = ref.read(ticketBoardProvider.notifier)..onNewTicket = _announce;
      ref.read(dineInInboxProvider.notifier).onNewOrder = (_) => _chime();
      if (_boardFor != session.office) {
        _boardFor = session.office;
        await board.start(session.office!, ref.read(wsUrlProvider));
        ref.read(dineInInboxProvider.notifier).start();
      }
      // A venue with named boards: which this device shows, asked once.
      if (mounted && session.screenId == null && session.screens.isNotEmpty) await _pickBoard();
    } on TapApiError catch (e) {
      if (mounted) setState(() => _problem = e.message);
    } catch (e) {
      if (mounted) setState(() => _problem = 'The kitchen could not start: $e');
    } finally {
      _starting = false;
    }
  }

  void _chime() {
    final s = ref.read(kitchenSessionProvider).value;
    if (s?.sound ?? true) GoSounds.play(ref.read(tapProvider).config.go, GoSound.kitchenReady);
    HapticFeedback.mediumImpact();
  }

  void _announce(Ticket t) {
    _chime();
    unawaited(_autoPrint(t));
    if (!mounted) return;
    setState(() => _flash.add(t.id));
    Timer(const Duration(seconds: 6), () {
      if (mounted) setState(() => _flash.remove(t.id));
    });
  }

  /// Each new ticket on paper too, when a manager turned that on.
  Future<void> _autoPrint(Ticket t) async {
    if (!await kitchenAutoPrint()) return;
    final s = ref.read(kitchenSessionProvider).value ?? KitchenSession.empty;
    try {
      await printKitchenTicket(t, s, s.screen, allergens: ref.read(allergenLabelsProvider).value ?? const {});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<String?> _askText(String title, {String initial = '', String hint = ''}) async {
    final c = TextEditingController(text: initial);
    final v = await showAdaptiveDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog.adaptive(
        title: Text(title),
        content: Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Material(
            type: MaterialType.transparency,
            child: TextField(
              controller: c,
              autofocus: true,
              maxLength: 80,
              decoration: InputDecoration(hintText: hint),
              onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    c.dispose();
    return v == null || v.isEmpty ? null : v;
  }

  void _say(String words) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(words)));
  }

  /// Name this kitchen (2026-11-04). The built-in board has no name of its
  /// own, so naming it makes a kitchen for this device.
  Future<void> _rename() async {
    final s = ref.read(kitchenSessionProvider).value;
    if (s == null) return;
    final board = s.screen;
    final name = await _askText(board.isBuiltIn ? 'Name this kitchen' : 'Rename kitchen',
        initial: board.isBuiltIn ? '' : board.name, hint: 'Main kitchen, Lounge kitchen, Pizza oven');
    if (name == null) return;
    try {
      final n = ref.read(kitchenSessionProvider.notifier);
      if (board.isBuiltIn) {
        await n.addScreen(name);
      } else {
        await n.saveScreen(board.id, name: name);
      }
      _say('This kitchen is now called $name.');
    } on KitchenApiError catch (e) {
      _say(e.message);
    } catch (e) {
      _say('Could not save: $e');
    }
  }

  /// Which of the venue's sites this kitchen cooks for.
  Future<void> _chooseSites() async {
    final s = ref.read(kitchenSessionProvider).value;
    if (s == null) return;
    if (s.sites.isEmpty) {
      _say('This venue has no sites. Add them in the back office under Devices > Sites.');
      return;
    }
    if (s.screen.isBuiltIn) {
      _say('Name this kitchen first, then choose its sites.');
      return _rename();
    }
    final picked = await showModalBottomSheet<Set<int>>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      builder: (c) => _SitesSheet(sites: s.sites, chosen: s.screen.sites, kitchen: s.screen.name),
    );
    if (picked == null) return;
    try {
      await ref.read(kitchenSessionProvider.notifier).saveScreen(s.screen.id, sites: picked);
      _say(picked.isEmpty ? '${s.screen.name} now cooks for every site.' : 'Saved. ${s.screen.name} gets those sites\' orders.');
    } on KitchenApiError catch (e) {
      _say(e.message);
    }
  }

  Future<void> _addKitchen() async {
    final name = await _askText('New kitchen', hint: 'Lounge kitchen');
    if (name == null) return;
    try {
      await ref.read(kitchenSessionProvider.notifier).addScreen(name);
      _say('$name made, and this device shows it. Choose its sites next.');
    } on KitchenApiError catch (e) {
      _say(e.message);
    }
  }

  Future<void> _printerSetup() async {
    final now = await kitchenPrinter();
    if (!mounted) return;
    final v = await showAdaptiveDialog<String>(
      context: context,
      builder: (ctx) {
        final c = TextEditingController(text: now);
        return AlertDialog.adaptive(
          title: const Text('Kitchen printer'),
          content: Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Material(
              type: MaterialType.transparency,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                TextField(
                  controller: c,
                  autofocus: true,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(labelText: 'Address on the Wi-Fi', hintText: '192.168.1.60 or 192.168.1.60:9100'),
                ),
                const SizedBox(height: 8),
                const Text('A network kitchen printer (ESC/POS, port 9100), as the till uses. Empty: this device\'s own printing (AirPrint, Android printing).',
                    style: TextStyle(fontSize: 12)),
              ]),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            TextButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Save')),
          ],
        );
      },
    );
    if (v == null) return;
    await setKitchenPrinter(v);
    if (v.isEmpty) return _say('Tickets print with this device\'s own printing.');
    _say(await kitchenPrinterAnswers(v) ? 'The printer at $v answers.' : 'Saved, but the printer at $v did not answer.');
  }

  /// The kitchen's network and hardware: how tickets reach it, and its printer.
  void _openConnections() {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ConnectionPage(mode: ConnectionMode.kitchen, sections: _connections),
    ));
  }

  List<ConnSection> _connections(WidgetRef ref) {
    final board = ref.read(ticketBoardProvider);
    final s = ref.read(kitchenSessionProvider).value ?? KitchenSession.empty;
    final lan = LanService.instance;
    final updated = board.lastUpdated;
    return [
      ConnSection('How tickets arrive', [
        ConnRow(Icons.lan_rounded, 'From the tills, over the Wi-Fi',
            lan.node == null
                ? 'Not started'
                : lan.linked
                    ? 'Linked: tickets land in milliseconds, with or without the internet'
                    : 'Looking for the main till on this network',
            ok: lan.linked),
        ConnRow(Icons.cloud_sync_rounded, 'From the back office, live',
            board.online
                ? 'Live${updated == null ? '' : ', updated ${TimeOfDay.fromDateTime(updated).format(context)}'}'
                : 'Reconnecting: the tills still reach this kitchen over the Wi-Fi',
            ok: board.online),
        ConnRow(Icons.outbox_rounded, 'Waiting to send', board.queuedActions == 0 ? 'Nothing' : '${board.queuedActions} done or recalled, sent when back',
            ok: board.queuedActions == 0),
      ], warnings: [
        if (!board.online && !lan.linked) 'This kitchen can hear neither the back office nor the tills. Check the Wi-Fi.',
      ]),
      ConnSection('This kitchen', [
        ConnRow(Icons.soup_kitchen_rounded, 'Name', s.screen.isBuiltIn ? 'Not named (every station)' : s.screen.name, neutral: true, onTap: _rename),
        ConnRow(Icons.store_mall_directory_rounded, 'Sites it cooks for', s.sitesLabel, neutral: true, onTap: _chooseSites),
        ConnRow(Icons.view_column_rounded, 'Stations',
            s.screen.stations.isEmpty ? 'Every station' : s.screen.stations.map(s.labelFor).join(', '), neutral: true),
      ]),
    ];
  }

  Future<void> _pickBoard() async {
    final session = ref.read(kitchenSessionProvider).value;
    if (session == null) return;
    final picked = await showModalBottomSheet<ScreenProfile>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      builder: (c) => ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
        Text('Which board is this?', style: Theme.of(c).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text('Its tickets, from the stations the back office gave it.', style: Theme.of(c).textTheme.bodySmall),
        const SizedBox(height: 12),
        for (final p in session.choices)
          Card(
            child: ListTile(
              leading: Icon(p.isBuiltIn ? Icons.select_all_rounded : Icons.view_column_rounded),
              title: Text(p.name),
              subtitle: Text([
                p.stations.isEmpty ? 'Every station' : p.stations.map(session.labelFor).join(', '),
                if (p.sites.isNotEmpty)
                  [for (final x in session.sites) if (p.sites.contains(x.id)) x.name].join(', '),
              ].join(' · ')),
              trailing: p.id == session.screen.id ? const Icon(Icons.check_rounded) : null,
              onTap: () => Navigator.pop(c, p),
            ),
          ),
      ]),
    );
    if (picked != null) await ref.read(kitchenSessionProvider.notifier).chooseScreen(picked.id);
  }

  Future<void> _settings() => showModeSettings(context, ref, extra: [
        Consumer(builder: (c, ref, _) {
          final s = ref.watch(kitchenSessionProvider).value ?? KitchenSession.empty;
          void go(VoidCallback then) {
            Navigator.pop(c);
            then();
          }

          return Card(
            child: Column(children: [
              ListTile(
                leading: const Icon(Icons.soup_kitchen_rounded),
                title: Text(s.screen.isBuiltIn ? 'Name this kitchen' : s.screen.name),
                subtitle: Text(s.screen.isBuiltIn ? 'So the tills and the back office can send to it by name.' : 'Rename this kitchen'),
                trailing: const Icon(Icons.edit_rounded),
                onTap: () => go(_rename),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.store_mall_directory_rounded),
                title: const Text('Sites it cooks for'),
                subtitle: Text(s.sites.isEmpty ? 'Every site (the venue has no sites set up)' : s.sitesLabel),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => go(_chooseSites),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.view_column_rounded),
                title: const Text('Which kitchen this device shows'),
                subtitle: Text(s.screen.name),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => go(_pickBoard),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.add_rounded),
                title: const Text('Add a kitchen'),
                subtitle: const Text('Another kitchen, for other sites or stations'),
                onTap: () => go(_addKitchen),
              ),
            ]),
          );
        }),
        Card(
          child: Column(children: [
            ListTile(
              leading: const Icon(Icons.print_rounded),
              title: const Text('Kitchen printer'),
              subtitle: FutureBuilder<String>(
                future: kitchenPrinter(),
                builder: (_, v) => Text((v.data ?? '').isEmpty ? 'This device\'s own printing' : v.data!),
              ),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () {
                Navigator.pop(context);
                _printerSetup();
              },
            ),
            const Divider(height: 1),
            FutureBuilder<bool>(
              future: kitchenAutoPrint(),
              builder: (c, v) => StatefulBuilder(builder: (c, set) {
                var on = v.data ?? false;
                return SwitchListTile(
                  secondary: const Icon(Icons.receipt_long_rounded),
                  title: const Text('Print each new ticket'),
                  value: on,
                  onChanged: (x) async {
                    await setKitchenAutoPrint(x);
                    set(() => on = x);
                    if (c.mounted) (c as Element).markNeedsBuild();
                  },
                );
              }),
            ),
          ]),
        ),
        Card(
          child: ListTile(
            leading: const Icon(Icons.router_rounded),
            title: const Text('Network and hardware'),
            subtitle: const Text('How tickets reach this kitchen: the tills over Wi-Fi, the back office, the printer'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () {
              Navigator.pop(context);
              _openConnections();
            },
          ),
        ),
        Consumer(builder: (c, ref, _) {
          final s = ref.watch(kitchenSessionProvider).value;
          return Card(
            child: SwitchListTile(
              secondary: const Icon(Icons.notifications_active_rounded),
              title: const Text('Chime for new tickets'),
              value: s?.sound ?? true,
              onChanged: (v) => ref.read(kitchenSessionProvider.notifier).setSound(v),
            ),
          );
        }),
      ]);

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(kitchenSessionProvider).value;
    final board = ref.watch(ticketBoardProvider);
    final inbox = ref.watch(dineInInboxProvider);
    // The credential went bad (signed out at the server): ask for another.
    ref.listen(kitchenSessionProvider, (was, now) {
      if (was?.value?.signedIn == true && now.value?.signedIn == false) {
        _boardFor = null;
        _start();
      }
    });
    final profile = session?.screen ?? ScreenProfile.allStations;
    final open = board.open(profile);
    final done = board.completed(profile);
    final orders = inbox.orders;
    final t = Theme.of(context).textTheme;
    final phone = MediaQuery.sizeOf(context).shortestSide < 600;

    Widget body;
    if (_problem != null && board.tickets.isEmpty) {
      body = _Message(
        icon: Icons.cloud_off_rounded,
        title: 'The kitchen board could not start',
        words: _problem!,
        action: FilledButton.icon(onPressed: _start, icon: const Icon(Icons.refresh_rounded), label: const Text('Try again')),
      );
    } else if (board.loading && board.tickets.isEmpty) {
      body = const Center(child: CircularProgressIndicator());
    } else {
      body = switch (_tab) {
        _Tab.open => open.isEmpty
            ? const _Message(icon: Icons.check_circle_outline_rounded, title: 'All caught up', words: 'New tickets appear here the moment a till sends them.')
            : _OpenBoard(tickets: open, session: session ?? KitchenSession.empty, now: board.now, profile: profile, flash: _flash, phone: phone),
        _Tab.done => done.isEmpty
            ? _Message(icon: Icons.history_rounded, title: 'Nothing finished yet', words: 'Finished tickets stay here for ${profile.recallWindow.inMinutes} minutes, to recall.')
            : _DoneList(tickets: done, session: session ?? KitchenSession.empty, now: board.now),
        _Tab.orders => orders.isEmpty
            ? const _Message(icon: Icons.phone_iphone_rounded, title: 'No orders from phones', words: 'Orders from the venue\'s online menu appear here.')
            : _OrdersList(orders: orders),
      };
    }

    return Scaffold(
      backgroundColor: const Color(0xFF0B0E0A),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0B0E0A),
        foregroundColor: Colors.white,
        titleSpacing: 16,
        title: GestureDetector(
          onTap: _pickBoard,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(profile.name, style: t.titleMedium?.copyWith(color: Colors.white, fontWeight: FontWeight.w800)),
            Text(
                [
                  session?.officeName ?? ref.watch(tapProvider.select((s) => s.venue?.name)) ?? 'Kitchen',
                  if ((session?.sites ?? const []).isNotEmpty) session!.sitesLabel,
                ].join(' · '),
                style: t.bodySmall?.copyWith(color: Colors.white60)),
          ]),
        ),
        actions: [
          _LiveDot(online: board.online, queued: board.queuedActions),
          const SizedBox(width: 6),
          _Clock(now: board.now),
          IconButton(tooltip: 'Settings', icon: const Icon(Icons.settings_rounded), onPressed: _settings),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(52),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Theme(
              data: Tp.theme(Brightness.dark),
              child: SegmentedButton<_Tab>(
                showSelectedIcon: false,
                segments: [
                  ButtonSegment(value: _Tab.open, label: Text('Open ${open.length}')),
                  ButtonSegment(value: _Tab.done, label: Text(phone ? 'Done' : 'Done ${done.length}')),
                  ButtonSegment(value: _Tab.orders, label: Text(orders.any((o) => o.isWaiting) ? 'Orders •' : 'Orders')),
                ],
                selected: {_tab},
                onSelectionChanged: (s) {
                  HapticFeedback.selectionClick();
                  setState(() => _tab = s.first);
                },
              ),
            ),
          ),
        ),
      ),
      body: Theme(data: Tp.theme(Brightness.dark), child: SafeArea(top: false, child: body)),
    );
  }
}

/// How late a ticket is, by the board's own times.
Color _ageColour(Ticket t, ScreenProfile p, DateTime now) {
  final age = t.age(now);
  if (age >= p.late) return _red;
  if (age >= p.warn) return _amber;
  return Tp.lime;
}

String _elapsed(Duration d) {
  if (d.isNegative) return '0:00';
  final h = d.inHours;
  final m = d.inMinutes % 60;
  final s = d.inSeconds % 60;
  return h > 0 ? '$h:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}' : '$m:${s.toString().padLeft(2, '0')}';
}

/// How tall every ticket box is on the board (2026-11-04: "every box should
/// have same height and width; if items are not visible, tap and then show").
/// The same for every ticket, so the board reads as a grid; a ticket with more
/// than fits says so and opens whole when tapped.
double _boxHeight(bool phone) => phone ? 300 : 340;

class _OpenBoard extends ConsumerWidget {
  const _OpenBoard({required this.tickets, required this.session, required this.now, required this.profile, required this.flash, required this.phone});
  final List<Ticket> tickets;
  final KitchenSession session;
  final DateTime now;
  final ScreenProfile profile;
  final Set<String> flash;
  final bool phone;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.read(ticketBoardProvider.notifier);
    final height = _boxHeight(phone);
    void open(Ticket t) => showFullTicket(context, ticket: t, profile: profile);
    if (phone) {
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        itemCount: tickets.length,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          final ticket = tickets[i];
          return Dismissible(
            key: ValueKey('t-${ticket.id}'),
            // Left: done (the main action, as Mail's archive); right: rush.
            background: _SwipeBack(colour: _amber, icon: Icons.bolt_rounded, label: ticket.rushed ? 'Unrush' : 'Rush', left: true),
            secondaryBackground: const _SwipeBack(colour: Tp.lime, icon: Icons.check_rounded, label: 'Done', left: false),
            confirmDismiss: (dir) async {
              HapticFeedback.mediumImpact();
              if (dir == DismissDirection.startToEnd) {
                await board.rush(ticket, !ticket.rushed);
                return false;
              }
              await board.bump(ticket);
              return true;
            },
            child: SizedBox(
              height: height,
              child: _TicketCard(ticket: ticket, session: session, now: now, profile: profile, flash: flash.contains(ticket.id), onOpen: () => open(ticket)),
            ),
          );
        },
      );
    }
    return LayoutBuilder(builder: (context, box) {
      final columns = (profile.columns > 0 ? profile.columns : (box.maxWidth / 300).floor()).clamp(1, 8);
      // Oldest first along the row, then the next row, every box the same
      // size, as the wall screen lays them out.
      return GridView.builder(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: columns,
          mainAxisExtent: height,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
        ),
        itemCount: tickets.length,
        itemBuilder: (context, i) {
          final t = tickets[i];
          return _TicketCard(
            key: ValueKey('card-${t.id}'),
            ticket: t,
            session: session,
            now: now,
            profile: profile,
            flash: flash.contains(t.id),
            onOpen: () => open(t),
          );
        },
      );
    });
  }
}

/// The whole ticket, every item, with its actions: what a box on the board
/// opens to when it has more than fits.
Future<void> showFullTicket(BuildContext context, {required Ticket ticket, required ScreenProfile profile}) {
  HapticFeedback.selectionClick();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: const Color(0xFF0B0E0A),
    constraints: const BoxConstraints(maxWidth: 640),
    builder: (c) => Theme(
      data: Tp.theme(Brightness.dark),
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.8,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        builder: (c, scroll) => Consumer(builder: (c, ref, _) {
          final board = ref.watch(ticketBoardProvider);
          final session = ref.watch(kitchenSessionProvider).value ?? KitchenSession.empty;
          // The live copy, so a line crossed off here crosses off at once.
          final live = board.tickets.where((x) => x.id == ticket.id).firstOrNull ?? ticket;
          return SingleChildScrollView(
            controller: scroll,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              _TicketCard(ticket: live, session: session, now: board.now, profile: profile, onDone: () => Navigator.pop(c)),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    onPressed: () {
                      HapticFeedback.mediumImpact();
                      ref.read(ticketBoardProvider.notifier).rush(live, !live.rushed);
                    },
                    icon: const Icon(Icons.bolt_rounded, color: _amber),
                    label: Text(live.rushed ? 'Take off rush' : 'Rush'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    onPressed: () async {
                      final messenger = ScaffoldMessenger.of(context);
                      try {
                        await printKitchenTicket(live, session, profile, allergens: ref.read(allergenLabelsProvider).value ?? const {});
                      } catch (e) {
                        messenger.showSnackBar(SnackBar(content: Text('$e')));
                      }
                    },
                    icon: const Icon(Icons.print_rounded),
                    label: const Text('Print'),
                  ),
                ),
              ]),
              if (live.terminal != null || live.siteId != null) ...[
                const SizedBox(height: 12),
                Text(
                  [
                    if (live.terminal != null) 'From ${live.terminal}',
                    if (live.siteId != null)
                      session.sites.where((s) => s.id == live.siteId).map((s) => s.name).firstOrNull ?? 'site ${live.siteId}',
                  ].join(' · '),
                  textAlign: TextAlign.center,
                  style: Theme.of(c).textTheme.bodySmall?.copyWith(color: Colors.white54),
                ),
              ],
            ]),
          );
        }),
      ),
    ),
  );
}

class _SwipeBack extends StatelessWidget {
  const _SwipeBack({required this.colour, required this.icon, required this.label, required this.left});
  final Color colour;
  final IconData icon;
  final String label;
  final bool left;

  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(color: colour, borderRadius: BorderRadius.circular(18)),
        alignment: left ? Alignment.centerLeft : Alignment.centerRight,
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, color: Colors.black, size: 28),
          Text(label, style: const TextStyle(color: Colors.black, fontWeight: FontWeight.w800)),
        ]),
      );
}

/// A ticket. On the board ([onOpen] set) it fills the box it is given and its
/// items are clipped to it, with "More" and the whole ticket a tap away; in
/// the full view it is as long as it needs.
class _TicketCard extends ConsumerWidget {
  const _TicketCard({super.key, required this.ticket, required this.session, required this.now, required this.profile, this.flash = false, this.onOpen, this.onDone});
  final Ticket ticket;
  final KitchenSession session;
  final DateTime now;
  final ScreenProfile profile;
  final bool flash;

  /// Set on the board: the box is a fixed size and a tap opens the whole ticket.
  final VoidCallback? onOpen;

  /// After Done, in the full view (to close it).
  final VoidCallback? onDone;

  bool get _boxed => onOpen != null;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    final board = ref.read(ticketBoardProvider.notifier);
    final lines = ticket.linesFor(profile.stations);
    final colour = _ageColour(ticket, profile, now);
    final labels = ref.watch(allergenLabelsProvider).value ?? const {};

    final items = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      if ((ticket.note ?? '').isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
          child: Text(ticket.note!, style: t.bodyMedium?.copyWith(color: _amber, fontStyle: FontStyle.italic)),
        ),
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final l in lines)
            InkWell(
              // On the board a tap opens the whole ticket; items are crossed
              // off there, or here in the full view.
              onTap: _boxed
                  ? onOpen
                  : l.isModifier
                      ? null
                      : () {
                          HapticFeedback.selectionClick();
                          board.setLineMade(ticket, l.id, !l.made);
                        },
              child: Padding(
                padding: EdgeInsets.fromLTRB(l.isModifier ? 40 : 14, 5, 14, 5),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (!l.isModifier)
                    SizedBox(
                      width: 34,
                      child: Text('${l.quantityLabel}×',
                          style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: l.made ? Colors.white38 : Colors.white)),
                    ),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(
                        l.name,
                        style: (l.isModifier ? t.bodyMedium : t.titleMedium)?.copyWith(
                          fontWeight: l.isModifier ? FontWeight.w500 : FontWeight.w700,
                          color: l.made ? Colors.white38 : (l.isModifier ? Colors.white70 : Colors.white),
                          decoration: l.made ? TextDecoration.lineThrough : null,
                        ),
                      ),
                      if ((l.note ?? '').isNotEmpty)
                        Text(l.note!, style: t.bodySmall?.copyWith(color: _amber, fontStyle: FontStyle.italic)),
                      if (l.allergens.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 3),
                          child: Wrap(spacing: 4, runSpacing: 4, children: [
                            for (final a in l.allergens)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                                decoration: BoxDecoration(color: _red.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(6)),
                                child: Text(labels[a] ?? a, style: const TextStyle(color: _red, fontSize: 11, fontWeight: FontWeight.w700)),
                              ),
                          ]),
                        ),
                    ]),
                  ),
                  if (l.made) const Icon(Icons.check_rounded, color: Tp.lime, size: 20),
                ]),
              ),
            ),
        ]),
      ),
    ]);

    return AnimatedContainer(
      duration: const Duration(milliseconds: 400),
      curve: const Cubic(0.2, 0, 0, 1),
      decoration: BoxDecoration(
        color: const Color(0xFF171B15),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: flash ? Tp.lime : colour.withValues(alpha: 0.55), width: flash ? 3 : 1.5),
        boxShadow: flash ? [BoxShadow(color: Tp.lime.withValues(alpha: 0.35), blurRadius: 18)] : const [],
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // The header: where it goes, how long it has waited.
        InkWell(
          onTap: onOpen,
          onLongPress: () => _actions(context, ref),
          child: Container(
            color: colour.withValues(alpha: 0.16),
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            child: Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Flexible(child: Text(ticket.destination, overflow: TextOverflow.ellipsis, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w900))),
                    if (ticket.rushed) ...[
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(color: _amber, borderRadius: BorderRadius.circular(99)),
                        child: const Text('RUSH', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w900, fontSize: 12)),
                      ),
                    ],
                  ]),
                  Text(
                    [
                      if (ticket.ticketNo != null) '#${ticket.ticketNo}',
                      if (ticket.staffName != null) ticket.staffName!,
                      if ((ticket.covers ?? 0) > 0) '${ticket.covers} covers',
                    ].join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.bodySmall?.copyWith(color: Colors.white70),
                  ),
                ]),
              ),
              Text(_elapsed(ticket.age(now)),
                  style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: colour, fontFeatures: Tp.tabular)),
            ]),
          ),
        ),
        if (_boxed) Expanded(child: _Clipped(onOpen: onOpen!, child: items)) else items,
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: FilledButton.icon(
            key: ValueKey('bump-${ticket.id}${_boxed ? '' : '-full'}'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50), backgroundColor: Tp.lime, foregroundColor: Colors.black),
            onPressed: () {
              HapticFeedback.mediumImpact();
              board.bump(ticket);
              onDone?.call();
            },
            icon: const Icon(Icons.check_rounded),
            label: const Text('Done', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
          ),
        ),
      ]),
    );
  }

  Future<void> _actions(BuildContext context, WidgetRef ref) async {
    HapticFeedback.mediumImpact();
    final board = ref.read(ticketBoardProvider.notifier);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      useSafeArea: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(Icons.bolt_rounded, color: _amber),
            title: Text(ticket.rushed ? 'Take off rush' : 'Rush it to the front'),
            onTap: () {
              Navigator.pop(c);
              board.rush(ticket, !ticket.rushed);
            },
          ),
          if (onOpen != null)
            ListTile(
              leading: const Icon(Icons.open_in_full_rounded),
              title: const Text('See the whole ticket'),
              onTap: () {
                Navigator.pop(c);
                onOpen!();
              },
            ),
          ListTile(
            leading: const Icon(Icons.check_circle_rounded, color: Tp.lime),
            title: const Text('Mark it done'),
            onTap: () {
              Navigator.pop(c);
              board.bump(ticket);
            },
          ),
        ]),
      ),
    );
  }
}

/// A box's items, cut off at the box's bottom edge. When they run past it, a
/// fade and "More · tap to see all" say so, and a tap opens the whole ticket.
class _Clipped extends StatefulWidget {
  const _Clipped({required this.child, required this.onOpen});
  final Widget child;
  final VoidCallback onOpen;

  @override
  State<_Clipped> createState() => _ClippedState();
}

class _ClippedState extends State<_Clipped> {
  final _scroll = ScrollController();
  bool _more = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _measure() {
    if (!mounted || !_scroll.hasClients) return;
    final more = _scroll.position.maxScrollExtent > 1;
    if (more != _more) setState(() => _more = more);
  }

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
    return Stack(children: [
      Positioned.fill(
        child: NotificationListener<ScrollMetricsNotification>(
          onNotification: (_) {
            WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
            return false;
          },
          child: SingleChildScrollView(
            controller: _scroll,
            physics: const NeverScrollableScrollPhysics(),
            child: widget.child,
          ),
        ),
      ),
      if (_more)
        Positioned(
          left: 0,
          right: 0,
          bottom: 0,
          child: GestureDetector(
            key: const ValueKey('ticket-more'),
            onTap: widget.onOpen,
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 22, 14, 6),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Color(0x00171B15), Color(0xF2171B15), Color(0xFF171B15)],
                  stops: [0, 0.55, 1],
                ),
              ),
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                  decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(99)),
                  child: const Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(Icons.unfold_more_rounded, size: 16, color: Colors.white),
                    SizedBox(width: 4),
                    Flexible(
                      child: Text('More · tap to see all',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
                    ),
                  ]),
                ),
              ),
            ),
          ),
        ),
    ]);
  }
}

class _DoneList extends ConsumerWidget {
  const _DoneList({required this.tickets, required this.session, required this.now});
  final List<Ticket> tickets;
  final KitchenSession session;
  final DateTime now;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.read(ticketBoardProvider.notifier);
    final t = Theme.of(context).textTheme;
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
      itemCount: tickets.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, i) {
        final ticket = tickets[i];
        final done = ticket.completedAtFor(session.screen.stations);
        return Card(
          color: const Color(0xFF171B15),
          child: ListTile(
            title: Text('${ticket.destination}${ticket.ticketNo == null ? '' : ' · #${ticket.ticketNo}'}', style: t.titleMedium),
            subtitle: Text(
              '${ticket.linesFor(session.screen.stations).where((l) => !l.isModifier).map((l) => '${l.quantityLabel}× ${l.name}').join(', ')}'
              '${done == null ? '' : '\nDone ${_elapsed(now.difference(done))} ago'}',
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: OutlinedButton(
              onPressed: () {
                HapticFeedback.mediumImpact();
                board.recall(ticket);
              },
              child: const Text('Recall'),
            ),
          ),
        );
      },
    );
  }
}

class _OrdersList extends ConsumerWidget {
  const _OrdersList({required this.orders});
  final List<DineInOrder> orders;

  static String _next(DineInOrder o) => switch (o.status) {
        'accepted' => 'ready',
        'ready' => 'served',
        _ => 'accepted',
      };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
      itemCount: orders.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, i) {
        final o = orders[i];
        final next = _next(o);
        return Card(
          color: const Color(0xFF171B15),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('${o.tableLabel}${o.customerName == null ? '' : ' · ${o.customerName}'}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800))),
                Text(o.status[0].toUpperCase() + o.status.substring(1), style: t.labelLarge?.copyWith(color: o.isWaiting ? _amber : Colors.white70)),
              ]),
              const SizedBox(height: 6),
              for (final l in o.lines)
                Padding(
                  padding: EdgeInsets.only(left: l.isModifier ? 20 : 0, top: 2),
                  child: Text('${l.isModifier ? '' : '${l.qty}× '}${l.name}${(l.note ?? '').isEmpty ? '' : ' (${l.note})'}'),
                ),
              if ((o.note ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(o.note!, style: const TextStyle(color: _amber))),
              const SizedBox(height: 10),
              FilledButton(
                onPressed: () async {
                  HapticFeedback.mediumImpact();
                  final problem = await ref.read(dineInInboxProvider.notifier).move(o, next);
                  if (problem != null && context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(problem)));
                },
                child: Text(switch (next) { 'accepted' => 'Accept', 'ready' => 'Ready', _ => 'Served' }),
              ),
            ]),
          ),
        );
      },
    );
  }
}

class _LiveDot extends StatelessWidget {
  const _LiveDot({required this.online, required this.queued});
  final bool online;
  final int queued;

  @override
  Widget build(BuildContext context) => Tooltip(
        message: online ? 'Live' : (queued > 0 ? 'Offline: $queued waiting to send' : 'Offline: the tills still reach this screen'),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 300),
            width: 10,
            height: 10,
            decoration: BoxDecoration(shape: BoxShape.circle, color: online ? Tp.lime : _amber),
          ),
          if (queued > 0) Padding(padding: const EdgeInsets.only(left: 4), child: Text('$queued', style: const TextStyle(color: _amber))),
        ]),
      );
}

class _Clock extends StatelessWidget {
  const _Clock({required this.now});
  final DateTime now;

  @override
  Widget build(BuildContext context) => Text(
        '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}',
        style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white, fontFeatures: Tp.tabular, fontWeight: FontWeight.w700),
      );
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.title, required this.words, this.action});
  final IconData icon;
  final String title;
  final String words;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 56, color: Colors.white38),
          const SizedBox(height: 14),
          Text(title, textAlign: TextAlign.center, style: t.titleLarge?.copyWith(color: Colors.white, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Text(words, textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: Colors.white60)),
          if (action != null) ...[const SizedBox(height: 18), action!],
        ]),
      ),
    );
  }
}

/// Tick the sites a kitchen cooks for; none ticked is every site.
class _SitesSheet extends StatefulWidget {
  const _SitesSheet({required this.sites, required this.chosen, required this.kitchen});
  final List<KitchenSite> sites;
  final Set<int> chosen;
  final String kitchen;

  @override
  State<_SitesSheet> createState() => _SitesSheetState();
}

class _SitesSheetState extends State<_SitesSheet> {
  late final Set<int> _on = {...widget.chosen};

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), children: [
        Text('Sites for ${widget.kitchen}', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text('Orders from these sites\' tills come to this kitchen. None ticked: every site.', style: t.bodySmall),
        const SizedBox(height: 8),
        for (final s in widget.sites)
          CheckboxListTile(
            key: ValueKey('site-${s.id}'),
            value: _on.contains(s.id),
            title: Text(s.name),
            secondary: CircleAvatar(radius: 8, backgroundColor: _hex(s.colour) ?? Tp.lime),
            onChanged: (v) => setState(() => v == true ? _on.add(s.id) : _on.remove(s.id)),
          ),
        const SizedBox(height: 8),
        FilledButton(
          key: const ValueKey('sites-save'),
          onPressed: () => Navigator.pop(context, _on),
          child: Text(_on.isEmpty ? 'Every site' : 'Save ${_on.length} site${_on.length == 1 ? '' : 's'}'),
        ),
      ]),
    );
  }

  static Color? _hex(String? v) {
    final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch(v ?? '');
    return m == null ? null : Color(int.parse('FF${m.group(1)}', radix: 16));
  }
}
