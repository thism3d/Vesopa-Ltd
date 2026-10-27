/// Memberships, as the till's memberships page (memberships_page.dart), on
/// the till's own routes (/till/memberships/...): find a member and see where
/// they stand (plan, expiry, days left, frozen); join someone to a plan;
/// renew, freeze, unfreeze, cancel and reinstate. A fee goes onto the sale,
/// to be paid like anything else.
///
/// Who may: the venue's choice in the back office (Vesopa Go options >
/// Memberships): every member of staff, managers (or a manager's PIN), or not
/// on Go at all; cancelling has its own setting.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../counter/data/lite_state.dart';
import '../../counter/ui/receipt_view.dart' show askManager;
import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';

/// May the signed-on clerk do this, by the venue's [mode] (staff | managers)?
Future<bool> allowedBy(BuildContext context, WidgetRef ref, String mode, String why) async {
  if (mode == 'staff') return true;
  return await askManager(context, ref, why: why) != null;
}

String _day(Object? raw) {
  final t = '${raw ?? ''}';
  if (t.length < 10) return '';
  final d = DateTime.tryParse(t.substring(0, 10));
  return d == null ? '' : '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year}';
}

Color _stateColour(String s) => switch (s) {
      'active' => Tp.green,
      'frozen' => Tp.blue,
      'expiring' || 'pending' => Tp.amber,
      _ => Tp.danger,
    };

class MembershipsPage extends ConsumerStatefulWidget {
  const MembershipsPage({super.key});
  @override
  ConsumerState<MembershipsPage> createState() => _MembershipsPageState();
}

class _MembershipsPageState extends ConsumerState<MembershipsPage> {
  final _q = TextEditingController();
  Timer? _debounce;
  List<Map<String, dynamic>> _members = const [];
  List<Map<String, dynamic>> _plans = const [];
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (ref.read(tapProvider).demo) {
      setState(() {
        _plans = const [{'id': 1, 'name': 'Season ticket', 'fee_minor': 12000, 'term_months': 12}];
        _members = const [{'id': 'demo', 'name': 'Rhys Morgan', 'member_number': 'VK1001', 'state': 'active', 'membership_expiry': '2027-08-31', 'days_left': 308, 'plan': {'id': 1, 'name': 'Season ticket', 'fee_minor': 12000}}];
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = ref.read(apiProvider);
      final r = await Future.wait([api.memberships(_q.text), if (_plans.isEmpty) api.membershipPlans()]);
      if (!mounted) return;
      setState(() {
        _members = [for (final m in r[0]) Map<String, dynamic>.from(m as Map)];
        if (r.length > 1) _plans = [for (final p in r[1]) if ((p as Map)['active'] != false && p['active'] != 0) Map<String, dynamic>.from(p)];
      });
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.status == 404 ? 'Memberships are not switched on for this venue.' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The fee onto the sale, to be paid like anything else.
  void _charge(String name, int minor) {
    if (minor <= 0) return;
    ref.read(currentSaleProvider.notifier).add(Product(id: 'membership', name: name, priceMinor: minor, category: 'quick'));
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$name ${money(minor)} is on the sale: take the payment')));
  }

  Future<void> _act(Map<String, dynamic> m, String action, {Map<String, Object?> body = const {}, int chargeMinor = 0}) async {
    final s = ref.read(tapProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (s.demo) {
      messenger.showSnackBar(SnackBar(content: Text('Demo: $action not saved')));
      return;
    }
    try {
      await ref.read(apiProvider).membershipAction('${m['id']}', action, {...body, 'staff': s.clerk?.name});
      if (chargeMinor > 0) _charge('Membership ${action == 'renew' ? 'renewal' : action}: ${m['name']}', chargeMinor);
      await _load();
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _open(Map<String, dynamic> m) async {
    final go = ref.read(tapProvider).config.go;
    final plan = m['plan'] is Map ? Map<String, dynamic>.from(m['plan'] as Map) : const <String, dynamic>{};
    final state = '${m['state'] ?? ''}';
    final fee = (plan['fee_minor'] as num?)?.toInt() ?? 0;
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${m['name']}', style: Theme.of(c).textTheme.titleLarge),
            Text([if (m['member_number'] != null) '${m['member_number']}', '${plan['name'] ?? 'No plan'}'].join(' · ')),
            const SizedBox(height: 8),
            Row(children: [
              Chip(label: Text(state.isEmpty ? 'Unknown' : state[0].toUpperCase() + state.substring(1)), backgroundColor: _stateColour(state).withValues(alpha: 0.25)),
              const SizedBox(width: 8),
              if (_day(m['membership_expiry']).isNotEmpty) Text('Until ${_day(m['membership_expiry'])}${m['days_left'] != null ? ' · ${m['days_left']} days' : ''}'),
            ]),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              FilledButton.icon(onPressed: () => Navigator.pop(c, 'renew'), icon: const Icon(Icons.autorenew_rounded), label: Text('Renew${fee > 0 ? ' · ${money(fee)}' : ''}')),
              if (state == 'frozen')
                OutlinedButton.icon(onPressed: () => Navigator.pop(c, 'unfreeze'), icon: const Icon(Icons.wb_sunny_rounded), label: const Text('Unfreeze'))
              else
                OutlinedButton.icon(onPressed: () => Navigator.pop(c, 'freeze'), icon: const Icon(Icons.ac_unit_rounded), label: const Text('Freeze')),
              if (state == 'cancelled' || state == 'pending')
                OutlinedButton.icon(onPressed: () => Navigator.pop(c, 'reinstate'), icon: const Icon(Icons.restore_rounded), label: Text(state == 'pending' ? 'Approve' : 'Reinstate'))
              else
                OutlinedButton.icon(onPressed: () => Navigator.pop(c, 'cancel'), icon: const Icon(Icons.cancel_outlined, color: Tp.danger), label: const Text('Cancel', style: TextStyle(color: Tp.danger))),
            ]),
          ]),
        ),
      ),
    );
    if (action == null || !mounted) return;
    if ((action == 'cancel' || action == 'reinstate') && !await allowedBy(context, ref, go.membershipsCancel, 'Cancel a membership')) return;
    if (!mounted) return;
    switch (action) {
      case 'renew':
        await _act(m, 'renew', body: {'amount_minor': fee}, chargeMinor: fee);
      case 'freeze':
        final range = await showDateRangePicker(context: context, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 365)));
        if (range == null) return;
        String iso(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
        await _act(m, 'freeze', body: {'from': iso(range.start), 'until': iso(range.end)});
      case 'cancel':
        final now = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: Text('Cancel ${m['name']}?'),
            content: const Text('Let it run to its end date, or stop it today.'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c), child: const Text('Keep it')),
              TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('At its end')),
              FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Today')),
            ],
          ),
        );
        if (now == null) return;
        await _act(m, 'cancel', body: {'now': now});
      default:
        await _act(m, action);
    }
  }

  Future<void> _join() async {
    if (_plans.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('The venue has no membership plans yet (back office, Memberships).')));
      return;
    }
    var plan = _plans.first;
    final name = TextEditingController(), email = TextEditingController(), phone = TextEditingController();
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(c).bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('New member', style: Theme.of(c).textTheme.titleLarge),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final p in _plans)
                ChoiceChip(
                  label: Text('${p['name']} · ${money((p['fee_minor'] as num?)?.toInt() ?? 0)}'),
                  selected: p['id'] == plan['id'],
                  onSelected: (_) => set(() => plan = p),
                ),
            ]),
            const SizedBox(height: 12),
            TextField(controller: name, autofocus: true, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Name')),
            const SizedBox(height: 10),
            TextField(controller: email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
            const SizedBox(height: 10),
            TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Mobile')),
            const SizedBox(height: 14),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Join')),
          ]),
        ),
      ),
    );
    if (ok != true || name.text.trim().isEmpty || !mounted) return;
    final fee = ((plan['fee_minor'] as num?)?.toInt() ?? 0) + ((plan['joining_fee_minor'] as num?)?.toInt() ?? 0);
    final messenger = ScaffoldMessenger.of(context);
    if (ref.read(tapProvider).demo) {
      messenger.showSnackBar(const SnackBar(content: Text('Demo: members are not saved')));
      return;
    }
    try {
      await ref.read(apiProvider).joinMembership(
            planId: (plan['id'] as num).toInt(),
            newCustomer: {'name': name.text.trim(), if (email.text.trim().isNotEmpty) 'email': email.text.trim(), if (phone.text.trim().isNotEmpty) 'phone': phone.text.trim()},
            amountMinor: fee,
            staff: ref.read(tapProvider).clerk?.name,
          );
      _charge('Membership: ${plan['name']} (${name.text.trim()})', fee);
      _q.text = name.text.trim();
      await _load();
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(onPressed: _join, icon: const Icon(Icons.card_membership_rounded), label: const Text('New member')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: TextField(
            controller: _q,
            onChanged: (_) {
              _debounce?.cancel();
              _debounce = Timer(const Duration(milliseconds: 300), _load);
            },
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              hintText: 'Name, member number, card, email or mobile',
              suffixIcon: _busy ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))) : null,
            ),
          ),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.only(bottom: 96),
            itemCount: _members.length,
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (_, i) {
              final m = _members[i];
              final state = '${m['state'] ?? ''}';
              final plan = m['plan'] is Map ? (m['plan'] as Map)['name'] : null;
              return ListTile(
                leading: Icon(Icons.card_membership_rounded, color: _stateColour(state)),
                title: Text('${m['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text([
                  if (m['member_number'] != null) '${m['member_number']}',
                  if (plan != null) '$plan',
                  if (_day(m['membership_expiry']).isNotEmpty) 'until ${_day(m['membership_expiry'])}',
                ].join(' · ')),
                trailing: Text(state, style: TextStyle(color: _stateColour(state), fontWeight: FontWeight.w700)),
                onTap: () => _open(m),
              );
            },
          ),
        ),
      ]),
    );
  }
}
