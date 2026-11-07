/// Stripe card readers, for a venue on Stripe: an iPad has no Tap to Pay
/// (Apple offers it on iPhone only), so it takes cards on one of the venue's
/// Stripe internet readers, as a Dojo venue does on its card machine (owner,
/// 2026-11-07). Which reader this device sends to, adding one by the code its
/// screen shows, and in the sandbox Stripe's simulated reader.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../counter/ui/receipt_view.dart' show askManager;
import '../../data/api.dart';
import '../../data/session.dart';
import '../theme.dart';

const _readerKey = 'go_stripe_reader';

/// This device's Stripe reader, or null for the first one online.
Future<String?> deviceStripeReader() async {
  try {
    final v = (await SharedPreferences.getInstance()).getString(_readerKey);
    return v == null || v.isEmpty ? null : v;
  } catch (_) {
    return null;
  }
}

Future<void> setDeviceStripeReader(String? id) async {
  try {
    final p = await SharedPreferences.getInstance();
    id == null ? await p.remove(_readerKey) : await p.setString(_readerKey, id);
  } catch (_) {}
}

class StripeReaderPage extends ConsumerStatefulWidget {
  const StripeReaderPage({super.key});
  @override
  ConsumerState<StripeReaderPage> createState() => _StripeReaderPageState();
}

class _StripeReaderPageState extends ConsumerState<StripeReaderPage> {
  List<Map<String, dynamic>> _readers = const [];
  String _environment = '';
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
    final mine = await deviceStripeReader();
    try {
      final r = await ref.read(apiProvider).stripeReaders();
      if (!mounted) return;
      setState(() {
        _readers = [for (final x in (r['readers'] as List? ?? const [])) Map<String, dynamic>.from(x as Map)];
        _environment = '${r['environment'] ?? ''}';
        _mine = mine;
        _error = null;
        _busy = false;
      });
    } on TapApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
        });
      }
    }
  }

  Future<void> _add({required bool simulated}) async {
    if (await askManager(context, ref, why: 'Add a card reader') == null || !mounted) return;
    var code = '';
    var label = '';
    if (!simulated) {
      final codeField = TextEditingController();
      final labelField = TextEditingController();
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('Add a Stripe reader'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            const Text('On the reader: Settings, Generate pairing code. Type the code it shows.'),
            const SizedBox(height: 12),
            TextField(controller: codeField, autofocus: true, decoration: const InputDecoration(labelText: 'Pairing code')),
            const SizedBox(height: 10),
            TextField(controller: labelField, decoration: const InputDecoration(labelText: 'Name, such as Bar')),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Add')),
          ],
        ),
      );
      if (ok != true) return;
      code = codeField.text.trim();
      label = labelField.text.trim();
    }
    try {
      final added = await ref.read(apiProvider).stripeAddReader(code: code, label: label, simulated: simulated);
      await setDeviceStripeReader('${added['id']}');
      await _load();
    } on TapApiError catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final sandbox = _environment.isNotEmpty && _environment != 'live';
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Stripe card readers', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        Text(sandbox ? 'Sandbox: test cards only, no real money.' : 'Card payments on this device go to the reader ticked here.',
            style: t.bodyMedium?.copyWith(color: context.goMuted)),
        const SizedBox(height: 12),
        if (_busy) const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator())),
        if (_error != null) Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)),
        if (!_busy && _error == null && _readers.isEmpty) const Text('No reader at this venue yet. Add one below.'),
        if (_readers.isNotEmpty)
          RadioGroup<String>(
            groupValue: _mine ?? '${_readers.first['id']}',
            onChanged: (v) async {
              await setDeviceStripeReader(v);
              setState(() => _mine = v);
            },
            child: Column(children: [
              for (final r in _readers)
                Card(
                  child: RadioListTile<String>(
                    key: ValueKey('reader-${r['id']}'),
                    value: '${r['id']}',
                    title: Text('${r['label']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text('${r['simulated'] == true ? 'Simulated reader' : r['device_type']} · ${r['status'] ?? 'unknown'}'),
                  ),
                ),
            ]),
          ),
        const SizedBox(height: 12),
        Wrap(spacing: 10, runSpacing: 10, children: [
          FilledButton.icon(onPressed: () => _add(simulated: false), icon: const Icon(Icons.add_rounded), label: const Text('Add a reader')),
          if (sandbox)
            OutlinedButton.icon(
              onPressed: () => _add(simulated: true),
              icon: const Icon(Icons.science_rounded),
              label: const Text('Add a simulated reader'),
            ),
        ]),
      ]),
    );
  }
}
