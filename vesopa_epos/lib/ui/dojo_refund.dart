import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/till_permissions.dart';
import '../main.dart';
import '../payments/card_log.dart';
import '../payments/dojo_desktop.dart';
import '../payments/dojo_native.dart';
import '../payments/payment_provider.dart';
import 'permission_gate.dart';
import 'theme.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// The Dojo client this till takes cards with, or null when it has none.
///
/// Refunds and status checks need the REST client whichever way the till
/// presents cards (reader, drop-in or hosted checkout).
DojoProvider? tillDojo(WidgetRef ref) {
  DojoProvider? of(PaymentProvider? p) => switch (p) {
    DojoProvider d => d,
    DesktopDojoProvider d => d.intents,
    NativeDojoProvider d => d.intents,
    _ => null,
  };
  return of(ref.read(dojoProvider)) ?? of(ref.read(manualCardProvider));
}

/// How money goes back on a Dojo card payment.
enum DojoRefundRoute {
  /// `POST /payment-intents/{id}/refunds`: straight back to the card that
  /// paid, no card needed, full or part.
  toCard('Back to the card that paid', 'No card needed. Full or part.'),

  /// A MatchedRefund terminal session: on the card machine, linked to the
  /// sale, for whatever is left of it. The customer presents the card.
  machineMatched(
    'On the card machine, linked to the sale',
    'Customer presents the card. Refunds what is left of the sale.',
  ),

  /// An UnlinkedRefund terminal session: any amount, no link to a sale.
  machineUnlinked(
    'On the card machine, any amount',
    'Customer presents the card. Not linked to a sale: a manager approves.',
  );

  const DojoRefundRoute(this.label, this.detail);
  final String label;
  final String detail;
}

/// Refund all or part of a Dojo card payment. Returns what went back, or 0.
///
/// Used from Functions › Card machine (a payment in the till's card log) and
/// from Refund off a receipt (the card share of the sale). Always:
///   1. asks Dojo what the payment is now (paid? already refunded?),
///   2. lets the clerk choose full or part and the route,
///   3. runs it, shows Dojo's answer, and writes it to the card log.
Future<int> refundDojoPayment(
  BuildContext context,
  WidgetRef ref, {
  required String intentId,
  int? capMinor,
  String? orderId,
  String? reason,
}) async {
  final dojo = tillDojo(ref);
  if (dojo == null) {
    _say(context, 'Card payments are not set up on this till.');
    return 0;
  }
  if (!await allowed(context, ref, TillPermission.refund)) return 0;
  if (!context.mounted) return 0;

  // 1. What Dojo says now.
  DojoPaymentStatus status;
  try {
    status = await _busy(
      context,
      'Checking the payment with Dojo…',
      dojo.paymentStatus(intentId),
    );
  } catch (e) {
    if (context.mounted) {
      _say(
        context,
        e is DojoException ? e.clerkMessage : 'Could not reach Dojo: $e',
      );
    }
    return 0;
  }
  if (!context.mounted) return 0;

  var refundable = status.refundableMinor;
  if (capMinor != null && capMinor < refundable) refundable = capMinor;
  if (!status.paid || refundable <= 0) {
    _say(
      context,
      status.paid
          ? 'Nothing left to refund on this payment (${status.summary}).'
          : 'Dojo says this payment was not taken (${status.status}), so there '
                'is nothing to refund.',
    );
    return 0;
  }

  // 2. Full or part, and how.
  final choice = await showDialog<({int amount, DojoRefundRoute route})>(
    context: context,
    builder: (_) => _RefundDialog(
      status: status,
      refundableMinor: refundable,
      hasMachine: dojo.canUseTerminal,
    ),
  );
  if (choice == null || !context.mounted) return 0;
  if (choice.route == DojoRefundRoute.machineUnlinked &&
      !await allowed(context, ref, TillPermission.isManager)) {
    return 0;
  }
  if (!context.mounted) return 0;

  // 3. Do it.
  final staff = ref.read(servedByProvider);
  PaymentResult outcome;
  if (choice.route == DojoRefundRoute.toCard) {
    try {
      final id = await _busy(
        context,
        'Sending the refund to Dojo…',
        dojo.refundToCard(
          intentId,
          amountMinor: choice.amount,
          // One key per refund of this payment and amount, so a retry after a
          // dropped connection cannot refund twice.
          idempotencyKey:
              'vesopa-$intentId-${choice.amount}-${status.refundedMinor}',
          reason: reason,
        ),
      );
      outcome = PaymentResult(
        approved: true,
        amountMinor: choice.amount,
        reference: intentId,
        outcome: CardOutcome.approved,
        acquirerStatus: 'Refunded',
        message: 'Refunded ${_money(choice.amount)} to the card. Refund $id.',
      );
    } on DojoException catch (e) {
      outcome = PaymentResult(
        approved: false,
        amountMinor: choice.amount,
        reference: intentId,
        outcome: CardOutcome.failed,
        acquirerStatus: e.statusCode == null ? null : 'HTTP ${e.statusCode}',
        message:
            '${e.clerkMessage} Try the refund on the card machine instead.',
      );
    } catch (e) {
      outcome = PaymentResult(
        approved: false,
        amountMinor: choice.amount,
        reference: intentId,
        outcome: CardOutcome.failed,
        message: 'Could not reach Dojo: $e',
      );
    }
  } else {
    if (!context.mounted) return 0;
    outcome = await runRefundOnMachine(
      context,
      dojo,
      amountMinor: choice.amount,
      intentId: choice.route == DojoRefundRoute.machineMatched
          ? intentId
          : null,
    );
  }

  await CardLog.instance.add(
    CardLogEntry.fromResult(
      outcome,
      kind: switch (choice.route) {
        DojoRefundRoute.toCard => 'refund',
        DojoRefundRoute.machineMatched => 'matched_refund',
        DojoRefundRoute.machineUnlinked => 'unlinked_refund',
      },
      orderId: orderId,
      terminalId: dojo.terminalId,
      softwareHouseId: dojo.softwareHouseId,
      resellerId: dojo.resellerId,
      staff: staff,
    ),
  );
  if (outcome.approved)
    await CardLog.instance.noteRefund(intentId, choice.amount);
  if (context.mounted) await showRefundResult(context, outcome);
  return outcome.approved ? choice.amount : 0;
}

/// Run a refund on the card machine and follow it to its end, with the same
/// prompts and signature check as a sale. [intentId] makes it a matched
/// refund; without it, it is unlinked.
Future<PaymentResult> runRefundOnMachine(
  BuildContext context,
  DojoProvider dojo, {
  required int amountMinor,
  String? intentId,
}) async {
  final prompt = ValueNotifier<String>(
    'Starting the refund on the card machine…',
  );
  var stop = false;
  String? sessionId;

  final dialog = showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => AlertDialog(
      icon: const Icon(Icons.undo, size: 30),
      title: Text('Refunding ${_money(amountMinor)}'),
      content: ValueListenableBuilder<String>(
        valueListenable: prompt,
        builder: (_, text, _) => Row(
          children: [
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.5),
            ),
            const SizedBox(width: 14),
            Expanded(child: Text(text)),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () {
            stop = true;
            prompt.value = 'Cancelling…';
            final id = sessionId;
            if (id != null) dojo.cancelSessionWithReason(id);
          },
          child: const Text('Cancel refund'),
        ),
      ],
    ),
  );

  PaymentResult result;
  try {
    sessionId = await dojo.startRefundSession(
      amountMinor: amountMinor,
      intentId: intentId,
    );
    result = await _followRefund(
      context,
      dojo,
      sessionId,
      amountMinor,
      intentId,
      prompt,
      () => stop,
    );
  } on DojoException catch (e) {
    result = PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: intentId,
      outcome: e.statusCode == 409 ? CardOutcome.busy : CardOutcome.failed,
      message: e.clerkMessage,
    );
  } catch (e) {
    result = PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: intentId,
      outcome: CardOutcome.failed,
      message: 'Could not reach Dojo: $e',
    );
  }
  if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
  await dialog;
  prompt.dispose();
  return result;
}

Future<PaymentResult> _followRefund(
  BuildContext context,
  DojoProvider dojo,
  String sessionId,
  int amountMinor,
  String? intentId,
  ValueNotifier<String> prompt,
  bool Function() stopped,
) async {
  final deadline = DateTime.now().add(const Duration(minutes: 6));
  var answeredSignature = false;
  var lastHeard = DateTime.now();
  while (DateTime.now().isBefore(deadline)) {
    DojoSession s;
    try {
      s = await dojo.fetchSession(sessionId);
      lastHeard = DateTime.now();
    } catch (_) {
      if (DateTime.now().difference(lastHeard) > const Duration(seconds: 45)) {
        break;
      }
      await Future<void>.delayed(const Duration(seconds: 1));
      continue;
    }
    if (!stopped()) prompt.value = s.prompt;

    if (s.needsSignature && !answeredSignature) {
      answeredSignature = true;
      final ok = context.mounted ? await _askSignature(context) : false;
      try {
        await dojo.answerSignature(sessionId, accepted: ok);
      } catch (_) {}
      continue;
    }
    if (s.captured) {
      return PaymentResult(
        approved: true,
        amountMinor: amountMinor,
        reference: intentId,
        sessionId: sessionId,
        acquirerStatus: s.status,
        outcome: CardOutcome.approved,
        receiptLines: s.receiptLines,
        authCode: s.authCode,
        cardLast4: s.cardLast4,
        cardType: s.cardType,
        message: 'Refunded ${_money(amountMinor)} to the card.',
      );
    }
    if (s.failed) {
      final st = s.status.toLowerCase();
      final outcome = st == 'expired'
          ? CardOutcome.expired
          : (st == 'canceled' || st == 'cancelled')
          ? CardOutcome.cancelled
          : CardOutcome.declined;
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: intentId,
        sessionId: sessionId,
        acquirerStatus: s.status,
        outcome: outcome,
        receiptLines: s.receiptLines,
        message: switch (outcome) {
          CardOutcome.expired =>
            'The card machine did not confirm the refund. Check its screen '
                'before refunding again.',
          CardOutcome.cancelled =>
            'The refund was cancelled. Nothing went back.',
          _ => 'The refund was declined. Nothing went back.',
        },
      );
    }
    await Future<void>.delayed(const Duration(seconds: 1));
  }
  return PaymentResult(
    approved: false,
    amountMinor: amountMinor,
    reference: intentId,
    sessionId: sessionId,
    outcome: CardOutcome.unknown,
    message:
        'The refund result could not be confirmed. Check the card '
        'machine before refunding again.',
  );
}

Future<bool> _askSignature(BuildContext context) async {
  final accepted = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (context) => AlertDialog(
      icon: const Icon(Icons.draw_outlined, size: 30),
      title: const Text('Check the signature'),
      content: const Text(
        'Compare the signature on the slip with the one on the card.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          style: TextButton.styleFrom(foregroundColor: Pos.red),
          child: const Text('Reject'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Signature OK'),
        ),
      ],
    ),
  );
  return accepted ?? false;
}

/// Dojo's answer for a refund, held until the clerk closes it.
Future<void> showRefundResult(BuildContext context, PaymentResult r) =>
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        icon: Icon(
          r.approved ? Icons.check_circle : Icons.error_outline,
          size: 34,
          color: r.approved ? Pos.green : Pos.red,
        ),
        title: Text(
          r.approved
              ? 'Refund approved'
              : r.kind.title.replaceFirst('Payment', 'Refund'),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(r.message ?? ''),
            if (r.acquirerStatus != null) ...[
              const SizedBox(height: 8),
              Text(
                'Dojo status: ${r.acquirerStatus}',
                style: const TextStyle(fontSize: 12),
              ),
            ],
          ],
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      ),
    );

class _RefundDialog extends StatefulWidget {
  const _RefundDialog({
    required this.status,
    required this.refundableMinor,
    required this.hasMachine,
  });

  final DojoPaymentStatus status;
  final int refundableMinor;
  final bool hasMachine;

  @override
  State<_RefundDialog> createState() => _RefundDialogState();
}

class _RefundDialogState extends State<_RefundDialog> {
  bool _full = true;
  late final _amount = TextEditingController(
    text: (widget.refundableMinor / 100).toStringAsFixed(2),
  );
  late DojoRefundRoute _route = widget.hasMachine
      ? DojoRefundRoute.machineMatched
      : DojoRefundRoute.toCard;

  int get _minor => _full
      ? widget.refundableMinor
      : ((double.tryParse(_amount.text.trim()) ?? 0) * 100).round();

  bool get _valid => _minor > 0 && _minor <= widget.refundableMinor;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hint = Theme.of(context).hintColor;
    final routes = [
      DojoRefundRoute.toCard,
      if (widget.hasMachine) ...[
        // Linked to the sale is the whole of what is left, never a part:
        // Dojo cap it at the sale, and a part goes back to the card instead.
        if (_full) DojoRefundRoute.machineMatched,
        DojoRefundRoute.machineUnlinked,
      ],
    ];
    if (!routes.contains(_route)) _route = routes.first;

    return AlertDialog(
      icon: const Icon(Icons.undo, size: 30),
      title: const Text('Refund a card payment'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(widget.status.summary),
              const SizedBox(height: 4),
              Text(
                'Up to ${_money(widget.refundableMinor)} can go back.',
                style: TextStyle(fontSize: 12, color: hint),
              ),
              const SizedBox(height: 14),
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: true, label: Text('Full refund')),
                  ButtonSegment(value: false, label: Text('Part refund')),
                ],
                selected: {_full},
                onSelectionChanged: (v) => setState(() => _full = v.first),
              ),
              if (!_full) ...[
                const SizedBox(height: 12),
                TextField(
                  controller: _amount,
                  autofocus: true,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: InputDecoration(
                    labelText: 'Amount to refund',
                    prefixText: '£ ',
                    errorText: _amount.text.isNotEmpty && !_valid
                        ? 'Between £0.01 and ${_money(widget.refundableMinor)}'
                        : null,
                    border: const OutlineInputBorder(),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ],
              const SizedBox(height: 14),
              RadioGroup<DojoRefundRoute>(
                groupValue: _route,
                onChanged: (v) => setState(() => _route = v ?? _route),
                child: Column(
                  children: [
                    for (final r in routes)
                      RadioListTile<DojoRefundRoute>(
                        contentPadding: EdgeInsets.zero,
                        value: r,
                        title: Text(r.label),
                        subtitle: Text(
                          r.detail,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _valid
              ? () => Navigator.pop(context, (amount: _minor, route: _route))
              : null,
          child: Text('Refund ${_valid ? _money(_minor) : ''}'),
        ),
      ],
    );
  }
}

Future<T> _busy<T>(BuildContext context, String text, Future<T> work) async {
  final dialog = showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => AlertDialog(
      content: Row(
        children: [
          const SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2.5),
          ),
          const SizedBox(width: 14),
          Expanded(child: Text(text)),
        ],
      ),
    ),
  );
  try {
    return await work;
  } finally {
    if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
    await dialog;
  }
}

void _say(BuildContext context, String text) {
  showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(text),
      actions: [
        FilledButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('OK'),
        ),
      ],
    ),
  );
}
