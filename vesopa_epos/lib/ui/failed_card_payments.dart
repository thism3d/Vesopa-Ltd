import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../payments/card_log.dart';
import '../payments/payment_provider.dart';
import 'dojo_refund.dart' show tillDojo;
import 'widgets/basket_panel.dart' show money;

/// Card payments and refunds that did not go through, with Dojo's reference
/// and the reason, kept apart from the paid receipts.
///
/// "Failed transactions with a reference should be recorded in the till and
/// the back office, not with the paid receipts but in their own tab, with the
/// reason." Every attempt was already in the card log; this is the view of
/// the ones that failed: declined, cancelled, signature rejected, expired or
/// not confirmed. A not-confirmed sale can be checked with Dojo from here,
/// and a later answer shows beside it.
class FailedCardPayments extends ConsumerStatefulWidget {
  const FailedCardPayments({super.key});

  /// The rows this tab lists: an attempt that failed and that Dojo know
  /// about (it carries an intent or a session id).
  static bool lists(CardLogEntry e) =>
      e.kind != 'check' &&
      e.kind != 'cancel' &&
      !e.approved &&
      ((e.intentId?.isNotEmpty ?? false) || (e.sessionId?.isNotEmpty ?? false));

  /// What a failure is called on screen.
  static String outcomeLabel(String outcome) => switch (outcome) {
    'declined' => 'Declined',
    'cancelled' => 'Cancelled',
    'signature_rejected' => 'Signature rejected',
    'busy' => 'Machine busy',
    'expired' => 'Expired',
    'unknown' => 'Not confirmed',
    'failed' => 'Failed',
    'not_paid' => 'Not paid',
    _ => outcome,
  };

  static String kindLabel(String kind) => switch (kind) {
    'sale' => 'Card payment',
    'refund' => 'Refund to card',
    'matched_refund' => 'Refund on machine',
    'unlinked_refund' => 'Unlinked refund',
    _ => kind,
  };

  @override
  ConsumerState<FailedCardPayments> createState() => _FailedCardPaymentsState();
}

class _FailedCardPaymentsState extends ConsumerState<FailedCardPayments> {
  List<CardLogEntry>? _all;
  StreamSubscription<void>? _sub;
  final Set<String> _checking = {};

  @override
  void initState() {
    super.initState();
    _load();
    _sub = CardLog.instance.changes.listen((_) => _load());
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final all = await CardLog.instance.recent();
    if (mounted) setState(() => _all = all);
  }

  /// The latest check or approval for the same payment, newer than [e].
  CardLogEntry? _later(CardLogEntry e) {
    for (final x in _all ?? const <CardLogEntry>[]) {
      if (!x.at.isAfter(e.at)) continue;
      final same = (e.intentId != null && x.intentId == e.intentId) ||
          (e.sessionId != null && x.sessionId == e.sessionId);
      if (same && (x.kind == 'check' || x.approved)) return x;
    }
    return null;
  }

  Future<void> _check(CardLogEntry e) async {
    final dojo = tillDojo(ref);
    final id = e.intentId;
    if (dojo == null || id == null) return;
    setState(() => _checking.add(id));
    try {
      final st = await dojo.paymentStatus(id);
      await CardLog.instance.add(CardLogEntry(
        at: DateTime.now(),
        kind: 'check',
        outcome: st.paid ? 'approved' : 'not_paid',
        amountMinor: st.amountMinor,
        intentId: st.id,
        sessionId: e.sessionId,
        status: st.status,
        message: st.summary,
        orderId: e.orderId,
        terminalId: dojo.terminalId,
        softwareHouseId: dojo.softwareHouseId,
        resellerId: dojo.resellerId,
        authCode: st.authCode,
        cardLast4: st.cardLast4,
        cardType: st.cardType,
      ));
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(st.paid
              ? 'Dojo say this payment WAS taken (${st.summary}). Record it '
                    'on its bill, or refund it.'
              : 'Dojo say this payment was not taken (${st.status}).'),
        ));
      }
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(err is DojoException
              ? 'Could not check: ${err.clerkMessage}'
              : 'Could not reach Dojo to check.'),
        ));
      }
    } finally {
      if (mounted) setState(() => _checking.remove(id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final all = _all;
    if (all == null) return const Center(child: CircularProgressIndicator());
    final rows = all.where(FailedCardPayments.lists).toList();
    if (rows.isEmpty) {
      return const Center(
        child: Text('No failed card payments on this till.'),
      );
    }
    final fmt = DateFormat('dd/MM/yyyy HH:mm');
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: ListView.separated(
        itemCount: rows.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final e = rows[i];
          final later = _later(e);
          final uncertain = e.outcome == 'expired' || e.outcome == 'unknown';
          final tone = uncertain || e.outcome == 'cancelled' || e.outcome == 'busy'
              ? Colors.orange.shade800
              : scheme.error;
          final ref0 = e.intentId ?? e.sessionId!;
          return ListTile(
            leading: Icon(
              uncertain ? Icons.help_outline : Icons.credit_card_off,
              color: tone,
            ),
            title: Row(
              children: [
                Text(
                  money(e.amountMinor),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(width: 10),
                _Pill(text: FailedCardPayments.outcomeLabel(e.outcome), colour: tone),
                if (later != null) ...[
                  const SizedBox(width: 6),
                  _Pill(
                    text: later.approved
                        ? 'Dojo later: taken'
                        : 'Dojo later: ${later.status ?? 'not taken'}',
                    colour: later.approved ? Colors.green.shade700 : scheme.outline,
                  ),
                ],
              ],
            ),
            subtitle: Text(
              [
                '${fmt.format(e.at)} · ${FailedCardPayments.kindLabel(e.kind)}'
                    '${e.staff != null ? ' · ${e.staff}' : ''}',
                if (e.message != null && e.message!.isNotEmpty) 'Reason: ${e.message}',
                'Reference: $ref0'
                    '${e.status != null ? ' · Dojo status ${e.status}' : ''}',
              ].join('\n'),
            ),
            isThreeLine: true,
            trailing: e.kind == 'sale' && e.intentId != null
                ? OutlinedButton.icon(
                    onPressed: _checking.contains(e.intentId)
                        ? null
                        : () => _check(e),
                    icon: const Icon(Icons.manage_search, size: 18),
                    label: const Text('Check with Dojo'),
                  )
                : null,
          );
        },
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.colour});

  final String text;
  final Color colour;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      color: colour.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      text,
      style: TextStyle(color: colour, fontSize: 12, fontWeight: FontWeight.w600),
    ),
  );
}
