/// Vesopa Go as a Vesopa Kitchen screen (owner, 2026-11-03).
///
/// The Windows kitchen screen's board (tickets from the back office and,
/// first, from the tills over the venue's network; bump, cross off, recall,
/// rush; queued while offline), drawn for a phone or an iPad:
///
///   iPad / wide   the open tickets in columns, oldest first, rushed at the
///                 front, each with its Done button, as the wall screen is
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
import '../../ui/sounds.dart';
import '../../ui/theme.dart';
import '../data/dinein_orders.dart';
import '../data/kitchen_session.dart';
import '../data/providers.dart';
import '../data/screen_profile.dart';
import '../data/ticket.dart';

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
    if (!mounted) return;
    setState(() => _flash.add(t.id));
    Timer(const Duration(seconds: 6), () {
      if (mounted) setState(() => _flash.remove(t.id));
    });
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
              subtitle: Text(p.stations.isEmpty ? 'Every station' : p.stations.map(session.labelFor).join(', ')),
              trailing: p.id == session.screen.id ? const Icon(Icons.check_rounded) : null,
              onTap: () => Navigator.pop(c, p),
            ),
          ),
      ]),
    );
    if (picked != null) await ref.read(kitchenSessionProvider.notifier).chooseScreen(picked.id);
  }

  Future<void> _settings() => showModeSettings(context, ref, extra: [
        Card(
          child: ListTile(
            leading: const Icon(Icons.view_column_rounded),
            title: const Text('Board'),
            subtitle: Text(ref.read(kitchenSessionProvider).value?.screen.name ?? 'All stations'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () {
              Navigator.pop(context);
              _pickBoard();
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
            Text(session?.officeName ?? ref.watch(tapProvider.select((s) => s.venue?.name)) ?? 'Kitchen',
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
            child: _TicketCard(ticket: ticket, session: session, now: now, profile: profile, flash: flash.contains(ticket.id)),
          );
        },
      );
    }
    return LayoutBuilder(builder: (context, box) {
      final columns = (profile.columns > 0 ? profile.columns : (box.maxWidth / 300).floor()).clamp(1, 8);
      // Oldest first along the row, then the next row: each card into the
      // shortest column so far, as the wall screen lays them out.
      final cols = List.generate(columns, (_) => <Ticket>[]);
      final heights = List.filled(columns, 0);
      for (final t in tickets) {
        var c = 0;
        for (var i = 1; i < columns; i++) {
          if (heights[i] < heights[c]) c = i;
        }
        cols[c].add(t);
        heights[c] += 3 + t.linesFor(profile.stations).length;
      }
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (var i = 0; i < columns; i++) ...[
            if (i > 0) const SizedBox(width: 12),
            Expanded(
              child: Column(children: [
                for (final t in cols[i]) ...[
                  _TicketCard(ticket: t, session: session, now: now, profile: profile, flash: flash.contains(t.id)),
                  const SizedBox(height: 12),
                ],
              ]),
            ),
          ],
        ]),
      );
    });
  }
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

class _TicketCard extends ConsumerWidget {
  const _TicketCard({required this.ticket, required this.session, required this.now, required this.profile, this.flash = false});
  final Ticket ticket;
  final KitchenSession session;
  final DateTime now;
  final ScreenProfile profile;
  final bool flash;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    final board = ref.read(ticketBoardProvider.notifier);
    final lines = ticket.linesFor(profile.stations);
    final colour = _ageColour(ticket, profile, now);
    final labels = ref.watch(allergenLabelsProvider).value ?? const {};
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
                    style: t.bodySmall?.copyWith(color: Colors.white70),
                  ),
                ]),
              ),
              Text(_elapsed(ticket.age(now)),
                  style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: colour, fontFeatures: Tp.tabular)),
            ]),
          ),
        ),
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
                onTap: l.isModifier
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
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: FilledButton.icon(
            key: ValueKey('bump-${ticket.id}'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50), backgroundColor: Tp.lime, foregroundColor: Colors.black),
            onPressed: () {
              HapticFeedback.mediumImpact();
              board.bump(ticket);
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
