import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/receipt_repository.dart';
import '../theme.dart';
import 'basket_panel.dart' show money;

/// The right-hand side of a receipt row: how it was paid and where it stands.
///
/// "At all the receipts at the right side, dojo paid can be seen card icon or
/// refund icon, paid icon." One glance down the list answers "was this card or
/// cash?" and "has it been refunded?" without opening anything: an icon per
/// way it was paid (a card icon for Dojo), then a pill that reads Paid, Part
/// refunded or Refunded. Tapping the pill says the detail.
class ReceiptStatusBadge extends StatelessWidget {
  const ReceiptStatusBadge({super.key, required this.receipt, this.compact = false});

  final ReceiptSummary receipt;

  /// Icons and pill only, for a narrow list.
  final bool compact;

  static ({IconData icon, String label}) method(String m, {bool dojo = false}) =>
      switch (m.toLowerCase()) {
        'cash' => (icon: Icons.payments_outlined, label: 'Cash'),
        'card' => (
          icon: Icons.credit_card,
          label: dojo ? 'Card on Dojo' : 'Card',
        ),
        'giftcard' => (icon: Icons.card_giftcard, label: 'Gift card'),
        'voucher' => (icon: Icons.confirmation_number_outlined, label: 'Voucher'),
        'account' => (icon: Icons.account_balance_wallet_outlined, label: 'Account'),
        _ => (icon: Icons.receipt_outlined, label: m),
      };

  static ({Color fg, Color bg, IconData icon}) look(ReceiptStatus s) =>
      switch (s) {
        ReceiptStatus.paid => (
          fg: const Color(0xFF1B6E3E),
          bg: const Color(0xFFDDF3E6),
          icon: Icons.check_circle,
        ),
        ReceiptStatus.partRefunded => (
          fg: const Color(0xFF8A4B00),
          bg: const Color(0xFFFFEBC8),
          icon: Icons.undo,
        ),
        ReceiptStatus.refunded => (
          fg: const Color(0xFFA3221A),
          bg: const Color(0xFFFDE0DC),
          icon: Icons.undo,
        ),
      };

  /// One line for a tooltip or a snackbar.
  static String explain(ReceiptSummary r) {
    final how = r.methods.isEmpty
        ? ''
        : 'Paid by ${r.methods.map((m) => method(m, dojo: r.hasCard).label).join(' and ')}. ';
    return switch (r.status) {
      ReceiptStatus.paid => '${how}Nothing refunded.',
      ReceiptStatus.partRefunded =>
        '$how${money(r.refundedMinor)} of ${money(r.totalMinor)} refunded'
            '${_when(r)}. ${money(r.refundableMinor)} can still go back.',
      ReceiptStatus.refunded =>
        '${how}Refunded in full${_when(r)}. It cannot be refunded again.',
    };
  }

  static String _when(ReceiptSummary r) => r.lastRefundAt == null
      ? ''
      : ' (last on ${DateFormat('d MMM HH:mm').format(r.lastRefundAt!)})';

  @override
  Widget build(BuildContext context) {
    final r = receipt;
    final l = look(r.status);
    return Tooltip(
      message: explain(r),
      triggerMode: TooltipTriggerMode.tap,
      showDuration: const Duration(seconds: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final m in r.methods)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Icon(
                method(m, dojo: r.hasCard).icon,
                size: 20,
                color: m == 'card' && r.hasCard
                    ? Pos.blue
                    : Theme.of(context).hintColor,
                semanticLabel: method(m, dojo: r.hasCard).label,
              ),
            ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
            decoration: BoxDecoration(
              color: l.bg,
              borderRadius: BorderRadius.circular(999),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(l.icon, size: 15, color: l.fg),
                const SizedBox(width: 4),
                Text(
                  compact || r.status != ReceiptStatus.partRefunded
                      ? r.status.label
                      : '${money(r.refundedMinor)} refunded',
                  style: TextStyle(
                    color: l.fg,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
