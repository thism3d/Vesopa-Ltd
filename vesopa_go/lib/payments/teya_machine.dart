/// Teya's card machines, as the till takes them (vesopa_epos
/// lib/payments/teya_provider.dart, the owner's 2026-10-20 rule: the back
/// office drives it). The venue's Teya store is connected in the back office
/// (Card Payments, Teya); the server sends the payment to the Teya machine
/// (POSLink), the customer taps or inserts the card on it, and Go follows the
/// payment until Teya has a verdict. No Teya sign-in on the device.
///
/// Teya's Tap to Pay on the phone itself lives only in Teya's own app: Teya
/// has no SDK that lets another app use it (docs.teya.com/epos-sdk lists
/// POSLink and All-in-One only), so a Teya venue's Go devices pay on a Teya
/// machine.
library;

import 'package:shared_preferences/shared_preferences.dart';

import '../data/api.dart';
import 'payment_service.dart';

const _teyaMachineKey = 'go_teya_machine';

/// Teya references on a bill start with this, as on the till; a refund of
/// one goes back through Teya.
const teyaRefPrefix = 'teya:';

/// This device's Teya machine, or null for the one the back office gave it.
Future<String?> deviceTeyaMachine() async {
  try {
    final v = (await SharedPreferences.getInstance()).getString(_teyaMachineKey);
    return v == null || v.isEmpty ? null : v;
  } catch (_) {
    return null;
  }
}

Future<void> setDeviceTeyaMachine(String? id) async {
  try {
    final p = await SharedPreferences.getInstance();
    id == null ? await p.remove(_teyaMachineKey) : await p.setString(_teyaMachineKey, id);
  } catch (_) {}
}

/// The venue's Teya settings, from /api/till/teya/config.
class TeyaSettings {
  const TeyaSettings({this.enabled = false, this.environment = 'sandbox', this.storeName, this.machineId, this.terminals = const []});

  factory TeyaSettings.fromJson(Object? j) {
    if (j is! Map) return const TeyaSettings();
    return TeyaSettings(
      enabled: j['enabled'] == true,
      environment: '${j['environment'] ?? 'sandbox'}',
      storeName: j['store_name'] as String?,
      machineId: (j['assigned_terminal_id'] ?? j['default_terminal_id']) as String?,
      terminals: [for (final t in (j['terminals'] as List? ?? const [])) if (t is Map) Map<String, dynamic>.from(t)],
    );
  }

  final bool enabled;
  final String environment;
  final String? storeName;

  /// The machine the back office gave this device, else the venue's default.
  final String? machineId;
  final List<Map<String, dynamic>> terminals;
}

class TeyaCardMachine implements PaymentService {
  TeyaCardMachine(this.api, this.settings, {required this.tillName});

  final TapApi api;
  final TeyaSettings settings;
  final String tillName;

  Future<String?> _machine() async => await deviceTeyaMachine() ?? settings.machineId;

  @override
  Future<String?> whyUnavailable() async =>
      await _machine() == null ? 'No Teya card machine is chosen. Pick one on the Card machine page or in the back office.' : null;

  @override
  Future<PaymentOutcome> take({
    required int amountMinor,
    int tipMinor = 0,
    String? billRef,
    String? clerk,
    String via = 'machine',
    void Function(PayStep step)? onStep,
  }) async {
    onStep?.call(PayStep.preparing);
    final machine = await _machine();
    if (machine == null) {
      return const PaymentOutcome(PayResult.unavailable, message: 'No Teya card machine is chosen. Pick one on the Card machine page.');
    }
    final reference = 'vesopa-${billRef ?? 'go'}-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}'
        .replaceAll(RegExp(r'[^A-Za-z0-9_.:-]'), '');
    String id;
    try {
      id = await api.teyaPay(
        terminalId: machine,
        amountMinor: amountMinor + tipMinor,
        reference: reference.length > 64 ? reference.substring(0, 64) : reference,
        orderId: billRef,
        tillName: tillName,
      );
    } on TapApiError catch (e) {
      // Nothing reached the machine: safe to try again.
      return PaymentOutcome(PayResult.unavailable, message: e.message);
    }
    onStep?.call(PayStep.onMachine);

    // A failed read is not a failed payment: keep asking for six minutes,
    // and only then say it is not confirmed.
    var failures = 0;
    final deadline = DateTime.now().add(const Duration(minutes: 6));
    while (DateTime.now().isBefore(deadline)) {
      try {
        final st = await api.teyaStatus(id, wait: 15);
        failures = 0;
        if (st['final'] == true) {
          onStep?.call(PayStep.done);
          return teyaOutcome(st);
        }
      } on TapApiError catch (e) {
        failures += 1;
        if (e.status == 404 || failures > 12) break;
        await Future<void>.delayed(const Duration(seconds: 3));
      }
    }
    return PaymentOutcome(PayResult.uncertain,
        paymentId: '$teyaRefPrefix$id',
        message: 'No answer from the Teya card machine. Check its screen before trying again: the payment may still have gone through.');
  }

  /// Stop a payment still waiting on the machine (too late once the card is read).
  Future<void> cancel(String id) => api.teyaCancel(id.startsWith(teyaRefPrefix) ? id.substring(teyaRefPrefix.length) : id);
}

/// What Teya's final answer means for the bill. A paid one is known by its
/// gateway payment id, which is what a refund needs.
PaymentOutcome teyaOutcome(Map<String, dynamic> st) {
  final gw = '${st['gateway_payment_id'] ?? ''}';
  final ref = '$teyaRefPrefix${gw.isNotEmpty ? gw : st['id']}';
  final message = '${st['message'] ?? ''}';
  return switch ('${st['outcome'] ?? ''}') {
    'approved' => PaymentOutcome(PayResult.paid, paymentId: ref),
    'declined' => PaymentOutcome(PayResult.declined, paymentId: ref, message: message.isEmpty ? 'Declined' : message),
    'cancelled' => PaymentOutcome(PayResult.cancelled, paymentId: ref),
    _ => PaymentOutcome(PayResult.declined, paymentId: ref, message: message.isEmpty ? 'The card machine could not take it.' : message),
  };
}
