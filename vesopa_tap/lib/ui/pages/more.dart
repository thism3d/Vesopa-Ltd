/// More: this phone, Tap to Pay, staff cards, signing out.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
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

  /// A refund, all or part, back to the card: a manager's PIN, always.
  Future<void> _refund(RecentPayment r) async {
    final amount = TextEditingController(text: ((r.totalMinor - r.refundedMinor) / 100).toStringAsFixed(2));
    final pin = TextEditingController();
    final reason = TextEditingController(text: 'Refund');
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Refund ${r.billName}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (£)')),
          const SizedBox(height: 10),
          TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason')),
          const SizedBox(height: 10),
          TextField(controller: pin, obscureText: true, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Manager\'s PIN')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Refund to card')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final notifier = ref.read(tapProvider.notifier);
    final manager = notifier.managerByPin(pin.text.trim());
    if (manager == null) {
      messenger.showSnackBar(const SnackBar(content: Text('That is not a manager\'s PIN. Nothing was refunded.')));
      return;
    }
    final minor = ((double.tryParse(amount.text.trim()) ?? 0) * 100).round();
    if (ref.read(tapProvider).demo) {
      notifier.refunded(r.paymentId, r.refundedMinor + minor);
      messenger.showSnackBar(SnackBar(content: Text('Demo: refunded ${money(minor)}')));
      return;
    }
    try {
      final res = await ref.read(apiProvider).refund(r.paymentId, amountMinor: minor, approvedBy: manager.name, reason: reason.text.trim());
      notifier.refunded(r.paymentId, (res['refunded_minor'] as num?)?.toInt() ?? r.refundedMinor + minor);
      messenger.showSnackBar(SnackBar(content: Text('Refunded ${money(minor)} to the card')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
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
          subtitle: Text([
            s.online ? 'Up to date with the back office' : 'Offline: showing the last copy',
            if (s.pendingSync > 0) '${s.pendingSync} waiting to send',
          ].join(' · ')),
          onTap: () => ref.read(tapProvider.notifier).refresh(),
        ),
      ),
      if (s.recent.isNotEmpty) ...[
        const SizedBox(height: 20),
        Text('Card payments on this phone', style: t.titleMedium),
        const SizedBox(height: 8),
        for (final r in s.recent)
          Card(
            child: ListTile(
              title: Text('${r.billName} · ${money(r.totalMinor)}'),
              subtitle: Text('${TimeOfDay.fromDateTime(r.at).format(context)} · ${r.clerk}'
                  '${r.refundedMinor > 0 ? ' · refunded ${money(r.refundedMinor)}' : ''}'),
              trailing: r.refundedMinor >= r.totalMinor ? const Text('Refunded') : const Icon(Icons.undo_rounded),
              onTap: r.refundedMinor >= r.totalMinor ? null : () => _refund(r),
            ),
          ),
      ],
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
