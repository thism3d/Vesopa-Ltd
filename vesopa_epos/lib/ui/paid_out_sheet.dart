/// Paying somebody out of the drawer.
///
/// The window cleaner, a taxi for a customer, milk from the shop up the road.
/// Money leaves the drawer with no sale and no refund behind it, and until
/// 1.8.0.0 the only way to do that on this till was a no-sale and a note --
/// which is a drawer that is short with nothing on the Z to say why.
///
/// This is the key for it. An amount, who it went to, and why from the
/// venue's own list; then the drawer opens. It is recorded as a till event
/// (kind `expense`) so the Z's cash-expected line comes down by it, and sent
/// up so the back office's Expenses report and Financial Summary 7 Days carry
/// it. Behind `can_expense`, because a key that opens the drawer and takes
/// money out is a key a venue decides who holds.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/till_permissions.dart';
import '../main.dart';
import 'permission_gate.dart';
import 'till_actions.dart';
import 'void_dialog.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/on_screen_keyboard.dart';
import 'widgets/pos_message.dart';

Future<void> showPaidOut(BuildContext context, WidgetRef ref) async {
  if (!await allowed(context, ref, TillPermission.expense)) return;
  if (!context.mounted) return;

  final entry = await showDialog<({int minor, String paidTo})>(
    context: context,
    builder: (_) => const _PaidOutDialog(),
  );
  if (entry == null || !context.mounted) return;

  // Why, from the venue's list. Null is allowed -- see askReason -- because a
  // clerk with the window cleaner standing there is not held up by a list
  // that would not load.
  final reason = await askReason(
    context,
    ref,
    ReasonFor.expense,
    title: 'What is ${money(entry.minor)} to ${entry.paidTo} for?',
  );
  if (!context.mounted) return;

  final session = await ref.read(sessionRepositoryProvider).current();
  await ref.read(orderRepositoryProvider).logExpense(
        sessionId: session.id,
        amountMinor: entry.minor,
        paidTo: entry.paidTo,
        reason: reason,
        staffName: ref.read(servedByProvider),
      );
  // The drawer, so the money can come out. Quietly: the no-sale key logs a
  // no-sale, and this is not one.
  await TillActions.openCashDrawerQuietly(ref);
  if (!context.mounted) return;
  PosMessenger.success(
    context,
    '${money(entry.minor)} paid out to ${entry.paidTo}. It is on the Z report '
    'and the drawer expects that much less.',
  );
}

class _PaidOutDialog extends StatefulWidget {
  const _PaidOutDialog();

  @override
  State<_PaidOutDialog> createState() => _PaidOutDialogState();
}

class _PaidOutDialogState extends State<_PaidOutDialog> {
  final _amount = TextEditingController();
  final _paidTo = TextEditingController();
  late TextEditingController _focused;

  @override
  void initState() {
    super.initState();
    _focused = _amount;
    _amount.addListener(() => setState(() {}));
    _paidTo.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _amount.dispose();
    _paidTo.dispose();
    super.dispose();
  }

  int? get _minor {
    final text = _amount.text.trim();
    if (text.isEmpty) return null;
    final pounds = double.tryParse(text);
    if (pounds == null || pounds <= 0) return null;
    return (pounds * 100).round();
  }

  /// Who it went to is required. "£30, paid out" tells the Z nothing.
  bool get _canPay => _minor != null && _paidTo.text.trim().length >= 2;

  void _submit() => Navigator.pop(
        context,
        (minor: _minor!, paidTo: _paidTo.text.trim()),
      );

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Paid out of the drawer'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _amount,
                autofocus: true,
                keyboardType: TextInputType.none,
                onTap: () => setState(() => _focused = _amount),
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                ),
                decoration: const InputDecoration(
                  prefixText: '£ ',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _paidTo,
                keyboardType: TextInputType.none,
                onTap: () => setState(() => _focused = _paidTo),
                decoration: const InputDecoration(
                  labelText: 'Paid to',
                  hintText: 'Who the money went to',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              OnScreenKeyboard(
                controller: _focused,
                mode: _focused == _amount
                    ? PosKeyboardMode.decimal
                    : PosKeyboardMode.text,
                submitLabel: 'Continue',
                onSubmit: _canPay ? _submit : null,
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
          onPressed: _canPay ? _submit : null,
          child: const Text('Continue'),
        ),
      ],
    );
  }
}
