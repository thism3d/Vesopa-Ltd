/// Memberships and Events & tickets behind the venue's choice of who may use
/// them (back office, Vesopa Go options): every clerk goes straight in; for
/// managers, a manager walks in and anyone else is asked for a manager's PIN
/// once, then the page opens.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../counter/ui/receipt_view.dart' show askManager;
import '../../data/models.dart';
import '../../data/session.dart';
import 'events_page.dart';
import 'memberships_page.dart';

class _Gate extends ConsumerStatefulWidget {
  const _Gate({required this.mode, required this.why, required this.child});
  final String mode;
  final String why;
  final Widget child;
  @override
  ConsumerState<_Gate> createState() => _GateState();
}

class _GateState extends ConsumerState<_Gate> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final clerk = ref.watch(tapProvider.select((s) => s.clerk));
    if (_open || widget.mode == 'staff' || (clerk?.can(TillPermission.isManager) ?? false)) return widget.child;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.lock_rounded, size: 48),
          const SizedBox(height: 12),
          Text('${widget.why} is for managers here', style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () async {
              if (await askManager(context, ref, why: widget.why) != null && mounted) setState(() => _open = true);
            },
            icon: const Icon(Icons.key_rounded),
            label: const Text('Manager PIN'),
          ),
        ]),
      ),
    );
  }
}

class MembershipsGate extends ConsumerWidget {
  const MembershipsGate({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      _Gate(mode: ref.watch(tapProvider.select((s) => s.config.go.membershipsAccess)), why: 'Memberships', child: const MembershipsPage());
}

class EventsGate extends ConsumerWidget {
  const EventsGate({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      _Gate(mode: ref.watch(tapProvider.select((s) => s.config.go.eventsAccess)), why: 'Events and tickets', child: const EventsPage());
}
