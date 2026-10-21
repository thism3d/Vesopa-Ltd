import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/till_permissions.dart';
import '../main.dart';
import '../payments/barclaycard_provider.dart';
import '../payments/card_log.dart';
import '../payments/payment_provider.dart';
import '../payments/teya_provider.dart';
import 'dojo_refund.dart' show cardLogRefunded;
import 'permission_gate.dart';
import 'theme.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// Refund all or part of a Teya card payment, straight back to the card that
/// paid (no card needed), through the Vesopa server. Returns what went back.
///
/// The till's card log is the ledger of what has gone back already, as for
/// Dojo, and the server checks again against its own record of the payment,
/// so the same payment cannot be refunded twice over.
Future<int> refundTeyaPayment(
  BuildContext context,
  WidgetRef ref, {
  required String reference,
  int? capMinor,
  int? paidMinor,
  int alreadyRefundedMinor = 0,
  String? orderId,
}) async {
  // A Barclaycard payment always goes back through Barclaycard, even after
  // the venue has switched its tills to something else.
  final token = ref.read(sessionProvider).terminalToken;
  final TeyaCard? teya = isBarclaycardReference(reference)
      ? (token == null || token.isEmpty
            ? null
            : BarclaycardProvider(apiBase: ref.read(apiBaseProvider), token: token))
      : ref.read(teyaProvider);
  if (teya == null) {
    _say(context, isBarclaycardReference(reference)
        ? 'This till is not signed in, so a Barclaycard payment cannot be refunded here.'
        : 'This till is not set up for Teya, so a Teya payment cannot be refunded here.');
    return 0;
  }
  final brand = teya.brand;
  if (!await allowed(context, ref, TillPermission.refund)) return 0;
  if (!context.mounted) return 0;

  final local = await cardLogRefunded(reference);
  final gone = local > alreadyRefundedMinor ? local : alreadyRefundedMinor;
  final paid = paidMinor ?? capMinor ?? 0;
  var refundable = paid - gone;
  if (capMinor != null && capMinor < refundable) refundable = capMinor;
  if (!context.mounted) return 0;
  if (refundable <= 0) {
    _say(context, gone > 0
        ? 'This card payment has already been refunded in full (${_money(gone)} went back).'
        : 'Nothing left to refund on this payment.');
    return 0;
  }
  if (!context.mounted) return 0;

  final amount = await showDialog<int>(
    context: context,
    builder: (_) => _TeyaRefundDialog(refundableMinor: refundable, alreadyRefundedMinor: gone, brand: brand),
  );
  if (amount == null || amount <= 0 || !context.mounted) return 0;

  final staff = ref.read(servedByProvider);
  final navigator = Navigator.of(context, rootNavigator: true);
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    useRootNavigator: true,
    builder: (_) => AlertDialog(
      content: Row(children: [
        const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5)),
        const SizedBox(width: 16),
        Expanded(child: Text('Sending the refund to $brand…')),
      ]),
    ),
  );
  final r = await teya.refund(reference, amount);
  navigator.pop();

  final outcome = PaymentResult(
    approved: r.ok,
    amountMinor: amount,
    reference: reference,
    outcome: r.ok ? CardOutcome.approved : CardOutcome.failed,
    acquirerStatus: r.ok ? 'Refunded' : 'Refund failed',
    message: r.ok
        ? 'Refunded ${_money(amount)} to the card.${r.refundId == null ? '' : ' Refund ${r.refundId}.'}'
        : r.message,
  );
  await CardLog.instance.add(CardLogEntry.fromResult(
    outcome,
    kind: 'refund',
    intentId: reference,
    orderId: orderId,
    terminalId: teya.terminalId,
    staff: staff,
  ));
  if (r.ok) await CardLog.instance.noteRefund(reference, amount);
  if (!context.mounted) return r.ok ? amount : 0;
  await showDialog<void>(
    context: context,
    builder: (dialog) => AlertDialog(
      icon: Icon(r.ok ? Icons.check_circle : Icons.error_outline, color: r.ok ? Pos.green : Pos.red, size: 40),
      title: Text(r.ok ? 'Refund approved' : 'Refund not taken'),
      content: Text(outcome.message ?? ''),
      actions: [FilledButton(onPressed: () => Navigator.pop(dialog), child: const Text('Done'))],
    ),
  );
  return r.ok ? amount : 0;
}

void _say(BuildContext context, String text) {
  ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));
}

class _TeyaRefundDialog extends StatefulWidget {
  const _TeyaRefundDialog({required this.refundableMinor, this.alreadyRefundedMinor = 0, this.brand = 'Teya'});

  final String brand;
  final int refundableMinor;
  final int alreadyRefundedMinor;

  @override
  State<_TeyaRefundDialog> createState() => _TeyaRefundDialogState();
}

class _TeyaRefundDialogState extends State<_TeyaRefundDialog> {
  bool _full = true;
  late final _amount = TextEditingController(text: (widget.refundableMinor / 100).toStringAsFixed(2));

  int get _minor => _full ? widget.refundableMinor : ((double.tryParse(_amount.text.trim()) ?? 0) * 100).round();
  bool get _valid => _minor > 0 && _minor <= widget.refundableMinor;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Refund with ${widget.brand}'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Back to the card that paid. No card needed.\nUp to ${_money(widget.refundableMinor)}'
                '${widget.alreadyRefundedMinor > 0 ? ' (${_money(widget.alreadyRefundedMinor)} already refunded)' : ''}.'),
            const SizedBox(height: 12),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('Full')),
                ButtonSegment(value: false, label: Text('Part')),
              ],
              selected: {_full},
              onSelectionChanged: (s) => setState(() => _full = s.first),
            ),
            if (!_full) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _amount,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(prefixText: '£ ', labelText: 'Amount to refund'),
                onChanged: (_) => setState(() {}),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _valid ? () => Navigator.pop(context, _minor) : null,
          style: FilledButton.styleFrom(backgroundColor: Pos.red),
          child: Text('Refund ${_valid ? _money(_minor) : ''}'),
        ),
      ],
    );
  }
}
