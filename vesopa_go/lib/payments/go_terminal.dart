/// Sending a card payment to another device: a Vesopa Go card terminal.
///
/// The asking side of lib/modes/terminal_mode_page.dart. A Go till (an iPad on
/// the counter, say) chooses one of the venue's card terminals in Settings;
/// from then on its card payments go to that device instead of its own reader
/// or the venue's card machine.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/api.dart';
import '../data/session.dart';
import '../ui/theme.dart';
import 'payment_service.dart';

/// The card terminal this device sends its card payments to, if any.
class GoTerminalChoice {
  const GoTerminalChoice(this.deviceId, this.name);
  final String deviceId;
  final String name;

  static const _idKey = 'go_card_terminal_id';
  static const _nameKey = 'go_card_terminal_name';

  static GoTerminalChoice? _current;

  /// Read at start, so the pay page can decide without waiting.
  static GoTerminalChoice? get current => _current;

  static Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final id = p.getString(_idKey);
      _current = id == null || id.isEmpty ? null : GoTerminalChoice(id, p.getString(_nameKey) ?? 'Card terminal');
    } catch (_) {
      _current = null;
    }
  }

  static Future<void> set(GoTerminalChoice? choice) async {
    _current = choice;
    try {
      final p = await SharedPreferences.getInstance();
      if (choice == null) {
        await p.remove(_idKey);
        await p.remove(_nameKey);
      } else {
        await p.setString(_idKey, choice.deviceId);
        await p.setString(_nameKey, choice.name);
      }
    } catch (_) {}
  }
}

/// The terminal's step names, as this device's own.
PayStep? _stepOf(String? name) {
  for (final s in PayStep.values) {
    if (s.name == name) return s;
  }
  return null;
}

/// What the till is told once the terminal has answered.
PaymentOutcome terminalOutcome(Map<String, dynamic> r) {
  final message = r['message'] as String?;
  final id = r['payment_id'] as String?;
  return switch ('${r['status']}') {
    'paid' => PaymentOutcome(PayResult.paid, paymentId: id),
    'declined' => PaymentOutcome(PayResult.declined, paymentId: id, message: message ?? 'The card was declined.'),
    'cancelled' => PaymentOutcome(PayResult.cancelled, message: message ?? 'Cancelled.'),
    'expired' => PaymentOutcome(PayResult.unavailable, message: message ?? 'The card terminal did not answer. Nothing was taken.'),
    _ => r['uncertain'] == true
        ? PaymentOutcome(PayResult.uncertain, paymentId: id, message: message ?? 'No answer from the card terminal. Check it before taking the payment again.')
        : PaymentOutcome(PayResult.unavailable, message: message ?? 'The card terminal could not take the payment.'),
  };
}

/// Send [amountMinor] to [terminal] and follow it to its verdict.
Future<PaymentOutcome> takeOnGoTerminal(
  TapApi api, {
  required GoTerminalChoice terminal,
  required int amountMinor,
  required String from,
  String? billRef,
  String? clerk,
  void Function(PayStep step)? onStep,
  PayControl? control,
  Duration every = const Duration(seconds: 1),
}) async {
  onStep?.call(PayStep.preparing);
  final String id;
  try {
    final r = await api.terminalPay(deviceId: terminal.deviceId, amountMinor: amountMinor, reference: billRef, from: from, clerk: clerk);
    id = '${r['id']}';
  } on TapApiError catch (e) {
    // Refused before anything was sent to the terminal: nothing was taken.
    return PaymentOutcome(PayResult.unavailable, message: e.message);
  }
  onStep?.call(PayStep.onMachine);
  var cancelSent = false;
  var silent = 0;
  PayStep? last;
  while (true) {
    await Future<void>.delayed(every);
    if (control != null && control.cancelRequested && !cancelSent) {
      cancelSent = true;
      onStep?.call(PayStep.cancelling);
      try {
        await api.terminalCancel(id);
      } on TapApiError {
        cancelSent = false;
      }
    }
    Map<String, dynamic> r;
    try {
      r = await api.terminalRequest(id);
      silent = 0;
    } on TapApiError catch (e) {
      if (e.status == 404) {
        return PaymentOutcome(PayResult.uncertain, message: 'The card terminal lost this payment. Check it before taking it again.');
      }
      // No signal on this device. The terminal may still be taking the card.
      if (++silent > 90) {
        return PaymentOutcome(PayResult.uncertain, message: 'No answer from the card terminal. Check it before taking the payment again.');
      }
      continue;
    }
    final status = '${r['status']}';
    if (status == 'waiting' || status == 'started') {
      final step = _stepOf(r['step'] as String?);
      if (step != null && step != last && !cancelSent) {
        last = step;
        // "Hold the card to this device" is the terminal's own screen; here
        // it is "on the machine".
        onStep?.call(step == PayStep.waitingForCard ? PayStep.onMachine : step);
      }
      continue;
    }
    return terminalOutcome(r);
  }
}

/// Settings: which card terminal this device sends its card payments to.
class GoTerminalPickPage extends ConsumerStatefulWidget {
  const GoTerminalPickPage({super.key});

  @override
  ConsumerState<GoTerminalPickPage> createState() => _GoTerminalPickPageState();
}

class _GoTerminalPickPageState extends ConsumerState<GoTerminalPickPage> {
  List<Map<String, dynamic>> _found = const [];
  String? _error;
  bool _busy = true;
  Timer? _again;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _again = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_load(quiet: true)));
  }

  @override
  void dispose() {
    _again?.cancel();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) setState(() => _busy = true);
    try {
      final r = await ref.read(apiProvider).terminalsAwake(ref.read(tapProvider.notifier).deviceId);
      if (!mounted) return;
      setState(() {
        _found = [for (final t in r['terminals'] as List? ?? const []) Map<String, dynamic>.from(t as Map)];
        _error = null;
      });
    } on TapApiError catch (e) {
      if (mounted && !quiet) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _choose(GoTerminalChoice? choice) async {
    await GoTerminalChoice.set(choice);
    if (!mounted) return;
    setState(() {});
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(choice == null ? 'Card payments are taken on this device again.' : 'Card payments now go to ${choice.name}.'),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final mine = GoTerminalChoice.current;
    final listed = _found.any((f) => f['device_id'] == mine?.deviceId);
    return Scaffold(
      appBar: AppBar(title: const Text('Card terminal')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          Text(
            'Send this device\'s card payments to another device running Vesopa Go as a Card terminal. '
            'The customer taps there; the sale stays here.',
            style: t.bodyLarge?.copyWith(color: context.goMuted, height: 1.4),
          ),
          const SizedBox(height: 16),
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
          if (mine != null && !listed)
            Card(
              child: ListTile(
                leading: const Icon(Icons.contactless_rounded, color: Tp.amber),
                title: Text(mine.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: const Text('In use here · asleep or switched off just now'),
                trailing: TextButton(onPressed: () => _choose(null), child: const Text('Stop using')),
              ),
            ),
          for (final f in _found)
            Card(
              child: ListTile(
                leading: Icon(Icons.contactless_rounded, color: f['ready'] == false ? Tp.amber : Tp.green),
                title: Text('${f['name']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text(f['ready'] == false
                    ? '${f['why'] ?? 'Cannot take cards yet'}'
                    : (f['busy'] == true ? 'Taking a payment' : 'Ready')),
                trailing: f['device_id'] == mine?.deviceId
                    ? TextButton(onPressed: () => _choose(null), child: const Text('Stop using'))
                    : FilledButton.tonal(
                        onPressed: () => _choose(GoTerminalChoice('${f['device_id']}', '${f['name']}')),
                        child: const Text('Use here'),
                      ),
              ),
            ),
          if (_found.isEmpty && !_busy)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Column(children: [
                Icon(Icons.contactless_outlined, size: 56, color: context.goMuted),
                const SizedBox(height: 12),
                Text('No card terminal is awake', style: t.titleMedium),
                const SizedBox(height: 6),
                Text(
                  'On the other device open Vesopa Go, then Settings, and switch it to Card terminal. It appears here within a few seconds.',
                  textAlign: TextAlign.center,
                  style: t.bodyMedium?.copyWith(color: context.goMuted),
                ),
              ]),
            ),
          if (_busy) const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())),
        ]),
      ),
    );
  }
}
