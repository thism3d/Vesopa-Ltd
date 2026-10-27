/// Events and tickets, as the till's gate (tickets_page.dart) and more: the
/// events from yesterday to a week ahead with how many are sold and through
/// the door; sell tickets at the counter (issued as the back office issues
/// them, the money onto the sale); and the gate, a ticket's QR scanned or its
/// code typed, admitted or refused by the back office, in a colour you can see
/// from across the door.
///
/// Who may: the venue's choice (back office, Vesopa Go options > Events and
/// tickets).
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../counter/data/lite_state.dart';
import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../sounds.dart';
import '../theme.dart';
import 'scan_sheet.dart';

class EventsPage extends ConsumerStatefulWidget {
  const EventsPage({super.key});
  @override
  ConsumerState<EventsPage> createState() => _EventsPageState();
}

class _EventsPageState extends ConsumerState<EventsPage> {
  List<Map<String, dynamic>> _events = const [];
  bool _busy = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (ref.read(tapProvider).demo) {
      setState(() {
        _busy = false;
        _events = const [{'id': 1, 'title': 'Pontardawe v Neath', 'starts_at': '2026-10-31 15:00:00', 'sold': 212, 'checked_in': 0, 'ticket_types': [{'id': 1, 'name': 'Adult', 'price_minor': 1000}, {'id': 2, 'name': 'Child', 'price_minor': 500}]}];
      });
      return;
    }
    setState(() => _busy = true);
    try {
      final list = await ref.read(apiProvider).events();
      if (mounted) {
        setState(() {
          _events = [for (final e in list) Map<String, dynamic>.from(e as Map)];
          _error = null;
        });
      }
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.status == 404 ? 'Events & tickets is not switched on for this venue.' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _gate() async {
    final code = await scanCode(context, title: 'Scan a ticket', hint: 'The QR on the ticket, or its code');
    if (code == null || !mounted) return;
    final s = ref.read(tapProvider);
    Map<String, dynamic> r;
    if (s.demo) {
      r = {'ok': true, 'ticket': {'type': 'Adult', 'holder': 'Demo', 'event_title': 'Pontardawe v Neath'}};
    } else {
      try {
        r = await ref.read(apiProvider).checkInTicket(code, staff: s.clerk?.name);
      } on TapApiError catch (e) {
        r = {'ok': false, 'message': e.status == 404 ? 'Not a valid ticket' : e.message};
      }
    }
    if (!mounted) return;
    final ok = r['ok'] == true;
    final ticket = r['ticket'] is Map ? Map<String, dynamic>.from(r['ticket'] as Map) : const <String, dynamic>{};
    GoSounds.play(s.config.go, ok ? GoSound.approved : GoSound.declined);
    HapticFeedback.heavyImpact();
    await showDialog<void>(
      context: context,
      builder: (c) => Dialog.fullscreen(
        backgroundColor: ok ? Tp.green : Tp.danger,
        child: InkWell(
          onTap: () => Navigator.pop(c),
          child: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Icon(ok ? Icons.check_circle_rounded : Icons.block_rounded, size: 140, color: Colors.white),
              const SizedBox(height: 12),
              Text(ok ? 'Come in' : '${r['message'] ?? 'Not let in'}', textAlign: TextAlign.center, style: const TextStyle(fontSize: 40, fontWeight: FontWeight.w900, color: Colors.white)),
              const SizedBox(height: 8),
              Text([ticket['type'], ticket['holder'], ticket['event_title']].where((x) => x != null && '$x'.isNotEmpty).join(' · '),
                  style: const TextStyle(fontSize: 20, color: Colors.white)),
              const SizedBox(height: 28),
              const Text('Tap for the next one', style: TextStyle(color: Colors.white70)),
            ]),
          ),
        ),
      ),
    );
    await _load();
  }

  Future<void> _sell(Map<String, dynamic> e) async {
    final types = [for (final t in e['ticket_types'] as List? ?? const []) Map<String, dynamic>.from(t as Map)];
    if (types.isEmpty) return;
    final qty = {for (final t in types) (t['id'] as num).toInt(): 0};
    final name = TextEditingController(), email = TextEditingController();
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => StatefulBuilder(builder: (c, set) {
        final total = types.fold<int>(0, (s, t) => s + qty[(t['id'] as num).toInt()]! * ((t['price_minor'] as num?)?.toInt() ?? 0));
        return Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(c).bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${e['title']}', style: Theme.of(c).textTheme.titleLarge),
            const SizedBox(height: 8),
            for (final t in types)
              Row(children: [
                Expanded(child: Text('${t['name']} · ${money((t['price_minor'] as num?)?.toInt() ?? 0)}', style: const TextStyle(fontWeight: FontWeight.w600))),
                IconButton(onPressed: qty[(t['id'] as num).toInt()]! > 0 ? () => set(() => qty[(t['id'] as num).toInt()] = qty[(t['id'] as num).toInt()]! - 1) : null, icon: const Icon(Icons.remove_circle_outline)),
                Text('${qty[(t['id'] as num).toInt()]}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                IconButton(onPressed: () => set(() => qty[(t['id'] as num).toInt()] = qty[(t['id'] as num).toInt()]! + 1), icon: const Icon(Icons.add_circle_outline)),
              ]),
            const SizedBox(height: 8),
            TextField(controller: name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Name on the tickets')),
            const SizedBox(height: 10),
            TextField(controller: email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email (the tickets are sent here)')),
            const SizedBox(height: 14),
            FilledButton(onPressed: total > 0 || qty.values.any((n) => n > 0) ? () => Navigator.pop(c, true) : null, child: Text('Sell · ${money(total)}')),
          ]),
        );
      }),
    );
    if (ok != true || name.text.trim().isEmpty || !mounted) return;
    final total = types.fold<int>(0, (s, t) => s + qty[(t['id'] as num).toInt()]! * ((t['price_minor'] as num?)?.toInt() ?? 0));
    final count = qty.values.fold<int>(0, (a, b) => a + b);
    final messenger = ScaffoldMessenger.of(context);
    final s = ref.read(tapProvider);
    try {
      if (!s.demo) {
        await ref.read(apiProvider).sellTickets(
              (e['id'] as num).toInt(),
              items: [for (final q in qty.entries) if (q.value > 0) {'ticket_type_id': q.key, 'qty': q.value}],
              name: name.text.trim(),
              email: email.text.trim(),
              amountMinor: total,
              staff: s.clerk?.name,
            );
      }
      if (total > 0) {
        ref.read(currentSaleProvider.notifier).add(Product(id: 'tickets', name: '$count × ${e['title']} tickets', priceMinor: total, category: 'quick'));
      }
      messenger.showSnackBar(SnackBar(content: Text('$count ticket${count == 1 ? '' : 's'} issued${email.text.trim().isEmpty ? '' : ' and emailed'}${total > 0 ? '. ${money(total)} is on the sale: take the payment' : ''}')));
      await _load();
    } on TapApiError catch (err) {
      messenger.showSnackBar(SnackBar(content: Text(err.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(onPressed: _gate, icon: const Icon(Icons.qr_code_scanner_rounded), label: const Text('Scan a ticket')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 96), children: [
          if (_busy) const LinearProgressIndicator(),
          if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
          if (!_busy && _events.isEmpty && _error == null) Padding(padding: const EdgeInsets.all(24), child: Text('No events from yesterday to a week ahead.', style: t.bodyLarge)),
          for (final e in _events)
            Card(
              child: ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                leading: const Icon(Icons.confirmation_number_rounded, color: Tp.lime, size: 32),
                title: Text('${e['title']}', style: const TextStyle(fontWeight: FontWeight.w800)),
                subtitle: Text('${'${e['starts_at'] ?? ''}'.replaceFirst('T', ' ').substring(0, '${e['starts_at'] ?? ''}'.length.clamp(0, 16))} · ${e['sold'] ?? 0} sold · ${e['checked_in'] ?? 0} in'),
                trailing: FilledButton.tonal(onPressed: () => _sell(e), child: const Text('Sell')),
              ),
            ),
        ]),
      ),
    );
  }
}
