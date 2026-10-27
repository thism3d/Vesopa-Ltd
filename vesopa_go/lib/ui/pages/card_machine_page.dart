/// The card machine, as the till's card machine page: the venue's Dojo
/// machines with their status, which one this device sends payments to
/// (switch at any time, mid-service included), and Dojo's details as the till
/// shows them (environment, software house id, reseller id).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../theme.dart';

const _machineKey = 'go_card_machine';

/// This device's card machine (a Dojo terminal id), or null for the venue's.
Future<String?> deviceMachine() async {
  try {
    final v = (await SharedPreferences.getInstance()).getString(_machineKey);
    return v == null || v.isEmpty ? null : v;
  } catch (_) {
    return null;
  }
}

Future<void> setDeviceMachine(String? id) async {
  try {
    final p = await SharedPreferences.getInstance();
    id == null ? await p.remove(_machineKey) : await p.setString(_machineKey, id);
  } catch (_) {}
}

class CardMachinePage extends ConsumerStatefulWidget {
  const CardMachinePage({super.key});
  @override
  ConsumerState<CardMachinePage> createState() => _CardMachinePageState();
}

class _CardMachinePageState extends ConsumerState<CardMachinePage> {
  Map<String, dynamic>? _list;
  String? _mine;
  String? _error;
  bool _busy = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _busy = true);
    final mine = await deviceMachine();
    try {
      final list = ref.read(tapProvider).demo
          ? {'environment': 'sandbox', 'default_terminal_id': 'tm_demo1', 'terminals': [
              {'id': 'tm_demo1', 'tid': '1234 5678', 'status': 'Available'},
              {'id': 'tm_demo2', 'tid': '8765 4321', 'status': 'Available'},
            ]}
          : await ref.read(apiProvider).terminals();
      if (mounted) {
        setState(() {
          _list = list;
          _mine = mine;
          _error = list['error'] as String?;
        });
      }
    } on TapApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _mine = mine;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final config = ref.watch(tapProvider.select((s) => s.config));
    final terms = [for (final x in (_list?['terminals'] as List? ?? const [])) Map<String, dynamic>.from(x as Map)];
    final venueDefault = _list?['default_terminal_id'] as String?;
    final current = _mine ?? venueDefault;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                const Icon(Icons.verified_user_rounded, color: Tp.lime),
                const SizedBox(width: 10),
                Text('Dojo', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                const Spacer(),
                Chip(label: Text(config.environment == 'live' ? 'Live' : 'Sandbox'), backgroundColor: config.environment == 'live' ? Tp.green.withValues(alpha: 0.25) : Tp.amber.withValues(alpha: 0.25)),
              ]),
              const SizedBox(height: 8),
              _Fact('Software house ID', config.softwareHouseId),
              _Fact('Reseller ID', config.resellerId),
              _Fact('This device', current == null ? 'The venue\'s machine (none set)' : (_mine == null ? 'The venue\'s machine' : 'Its own choice')),
            ]),
          ),
        ),
        const SizedBox(height: 16),
        Row(children: [
          Text('Card machines', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const Spacer(),
          if (_busy) const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) else IconButton(onPressed: _load, icon: const Icon(Icons.refresh_rounded)),
        ]),
        if (_error != null) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
        for (final m in terms)
          Card(
            child: ListTile(
              leading: Icon(Icons.point_of_sale_rounded, color: m['status'] == 'Available' ? Tp.green : Tp.amber),
              title: Text(m['tid'] == null ? '${m['id']}' : 'Machine ${m['tid']}', style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text([
                '${m['status'] ?? 'Unknown'}',
                if (m['id'] == venueDefault) 'the venue\'s default',
              ].join(' · ')),
              trailing: m['id'] == current
                  ? const Chip(avatar: Icon(Icons.check_rounded, size: 18), label: Text('In use here'))
                  : FilledButton.tonal(
                      onPressed: () async {
                        await setDeviceMachine('${m['id']}');
                        await _load();
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Card payments on this device now go to ${m['tid'] ?? m['id']}')));
                        }
                      },
                      child: const Text('Use this one'),
                    ),
            ),
          ),
        if (_mine != null)
          TextButton.icon(
            onPressed: () async {
              await setDeviceMachine(null);
              await _load();
            },
            icon: const Icon(Icons.undo_rounded),
            label: const Text('Use the venue\'s default machine'),
          ),
        if (!_busy && terms.isEmpty && _error == null)
          Padding(padding: const EdgeInsets.all(16), child: Text('No card machine is free at the moment. Check it is switched on and online.', style: t.bodyMedium)),
      ]),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          SizedBox(width: 160, child: Text(label, style: Theme.of(context).textTheme.bodySmall)),
          Expanded(child: SelectableText(value.isEmpty ? '–' : value, style: const TextStyle(fontWeight: FontWeight.w600, fontFeatures: Tp.tabular))),
        ]),
      );
}
