/// More: this phone, Tap to Pay, staff cards, signing out.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../../nfc/staff_card.dart';
import '../theme.dart';

class MorePage extends ConsumerStatefulWidget {
  const MorePage({super.key});
  @override
  ConsumerState<MorePage> createState() => _MorePageState();
}

class _MorePageState extends ConsumerState<MorePage> {
  String? _tapStatus;

  @override
  void initState() {
    super.initState();
    ref.read(paymentsProvider).whyUnavailable().then((why) {
      if (mounted) setState(() => _tapStatus = why ?? 'Ready: cards, Apple Pay and Google Pay');
    });
  }

  Future<void> _readCard() async {
    final id = await StaffCardReader.readOnce();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(id == null ? 'No card read' : 'Card $id: put this under the person\'s Staff card in the back office.'),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final t = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Card(
        child: ListTile(
          leading: const TapMark(size: 40),
          title: Text(s.venue?.name ?? ''),
          subtitle: Text(s.demo
              ? 'Demo: nothing is real'
              : s.venue?.mode == VenueMode.standalone
                  ? 'Vesopa Tap on its own'
                  : 'With Vesopa EPOS'),
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: ListTile(
          leading: const Icon(Icons.contactless_rounded, color: Tp.lime),
          title: const Text('Tap to Pay'),
          subtitle: Text(_tapStatus ?? 'Checking…'),
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: ListTile(
          leading: const Icon(Icons.badge_rounded),
          title: const Text('Read a staff card'),
          subtitle: const Text('Find a card or fob\'s id to give someone in the back office'),
          onTap: _readCard,
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: ListTile(
          leading: const Icon(Icons.sync_rounded),
          title: const Text('Refresh staff and menu'),
          subtitle: Text(s.online ? 'Up to date with the back office' : 'Offline: showing the last copy'),
          onTap: () => ref.read(tapProvider.notifier).refresh(),
        ),
      ),
      const SizedBox(height: 24),
      OutlinedButton.icon(
        onPressed: () => ref.read(tapProvider.notifier).lock(),
        icon: const Icon(Icons.lock_rounded),
        label: const Text('Sign off'),
      ),
      const SizedBox(height: 10),
      TextButton(
        onPressed: () async {
          final ok = await showDialog<bool>(
            context: context,
            builder: (c) => AlertDialog(
              title: const Text('Sign this phone out of the venue?'),
              content: const Text('It stops being one of the venue\'s tills. A manager signs it in again with Vesopa.'),
              actions: [
                TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Sign out')),
              ],
            ),
          );
          if (ok == true) await ref.read(tapProvider.notifier).forgetPhone();
        },
        child: Text('Sign this phone out of ${s.venue?.name ?? 'the venue'}', style: t.bodyMedium?.copyWith(color: Tp.danger)),
      ),
    ]);
  }
}
