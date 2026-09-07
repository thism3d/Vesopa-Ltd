/// Giving money back.
///
/// Two ways in, and the order of them is the venue's decision rather than a
/// default that fell out of the code:
///
///   1. **Off a receipt.** Find the sale, tick what is coming back, and the
///      money goes out the way it came in. This is the way, and it is first
///      because it is the only one that ties the refund to a sale: the amount
///      cannot exceed what was paid, the tender is not a guess, and a query
///      three weeks later has a receipt number to start from.
///   2. **Without one.** Type an amount and a reason, under a manager's key.
///      Real venues need it — a customer with no receipt, a delivery gone
///      wrong, a card refund the machine took but the till did not — and
///      pretending otherwise means staff finding a way round it with a no-sale
///      and a note, which is worse in every direction.
///
/// A REFUND IS NOT A NEGATIVE SALE
///
/// It is recorded as a till event beside the voids and the no-sales, not as an
/// order with minus signs on it. A bill settled last Tuesday was taken last
/// Tuesday; rewriting today's gross to account for money handed back would make
/// both days wrong, and the Z already has a Refunds line waiting for exactly
/// this.
///
/// WHAT THIS DOES NOT DO
///
/// It does not send the money back to the card itself. That is the payment
/// terminal's own job — Functions › Card Machine — and a till that claimed to
/// have refunded a card it never spoke to would be worse than one that says
/// where to go. What is recorded here is that the money left the drawer, or
/// that a card refund was raised, and by whom.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/receipt_repository.dart';
import 'receipts_page.dart' show receiptListProvider, receiptRepoProvider;
import '../data/till_permissions.dart';
import '../main.dart';
import 'permission_gate.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/on_screen_keyboard.dart';
import 'widgets/pos_message.dart';

/// Start a refund. Opens on the receipt list.
Future<void> showRefund(BuildContext context, WidgetRef ref) async {
  if (!await allowed(context, ref, TillPermission.refund)) return;
  if (!context.mounted) return;

  await Navigator.of(context).push(
    MaterialPageRoute<void>(builder: (_) => const RefundPage()),
  );
}

class RefundPage extends ConsumerStatefulWidget {
  const RefundPage({super.key});

  @override
  ConsumerState<RefundPage> createState() => _RefundPageState();
}

class _RefundPageState extends ConsumerState<RefundPage> {
  ReceiptSummary? _chosen;
  ReceiptDetail? _detail;
  bool _loading = false;

  /// The lines being refunded, by their position on the receipt.
  ///
  /// By index and not by id, because a stored receipt line has no id: lines
  /// arrive in the order they were rung and that order *is* their identity —
  /// it is what makes a modifier the answer to the item above it. See
  /// ReceiptLine.isModifier.
  final Set<int> _picked = {};

  Future<void> _open(ReceiptSummary summary) async {
    setState(() {
      _chosen = summary;
      _detail = null;
      _picked.clear();
      _loading = true;
    });
    try {
      final detail =
          await ref.read(receiptRepoProvider).detail(summary.id);
      if (mounted) setState(() => _detail = detail);
    } catch (e) {
      if (mounted) {
        PosMessenger.error(context, 'Could not open that receipt: $e');
        setState(() => _chosen = null);
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// What the picked lines come to.
  ///
  /// Summed off the receipt's own stored line values, not recalculated from
  /// today's prices: a product that has gone up since Tuesday must not change
  /// what Tuesday's customer gets back.
  int get _refundMinor {
    final detail = _detail;
    if (detail == null) return 0;
    var total = 0;
    for (var i = 0; i < detail.lines.length; i++) {
      if (_picked.contains(i)) total += detail.lines[i].lineTotalMinor;
    }
    return total;
  }

  /// How the sale was paid for, in words, so the clerk hands it back that way.
  String get _tenderSummary {
    final tenders = _detail?.tenders ?? const <ReceiptTender>[];
    if (tenders.isEmpty) return 'unknown';
    return tenders
        .map((t) => '${t.method} ${money(t.amountMinor)}')
        .join(', ');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Refund'),
        actions: [
          TextButton.icon(
            onPressed: _refundWithoutReceipt,
            icon: const Icon(Icons.receipt_long_outlined),
            label: const Text('No receipt'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: _chosen == null ? _pickReceipt() : _pickLines(),
    );
  }

  // ---------------------------------------------------------------------
  // 1. Which sale
  // ---------------------------------------------------------------------

  Widget _pickReceipt() {
    final receipts = ref.watch(receiptListProvider);

    return receipts.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Text(
            'Could not read the receipts: $e\n\n'
            'A refund can still be given without one.',
            textAlign: TextAlign.center,
          ),
        ),
      ),
      data: (list) => list.isEmpty
          ? const Center(child: Text('No sales to refund yet.'))
          : ListView.separated(
              itemCount: list.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final r = list[i];
                return ListTile(
                  title: Text(money(r.totalMinor),
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(
                    [
                      DateFormat('d MMM HH:mm').format(r.closedAt),
                      if (r.tableNumber != null) 'Table ${r.tableNumber}',
                      if (r.clerkName?.isNotEmpty ?? false) r.clerkName!,
                      if (r.customerName?.isNotEmpty ?? false) r.customerName!,
                    ].join('  ·  '),
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _open(r),
                );
              },
            ),
    );
  }

  // ---------------------------------------------------------------------
  // 2. Which items
  // ---------------------------------------------------------------------

  Widget _pickLines() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final detail = _detail;
    if (detail == null) return const SizedBox.shrink();

    final scheme = Theme.of(context).colorScheme;

    return Column(
      children: [
        Material(
          color: scheme.surfaceContainerHighest,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
            child: Row(
              children: [
                IconButton(
                  onPressed: () => setState(() {
                    _chosen = null;
                    _detail = null;
                    _picked.clear();
                  }),
                  icon: const Icon(Icons.arrow_back),
                  tooltip: 'Another receipt',
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${money(detail.summary.totalMinor)} — '
                        '${DateFormat('d MMM HH:mm').format(detail.summary.closedAt)}',
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      Text(
                        'Paid by $_tenderSummary',
                        style: TextStyle(
                          fontSize: 12,
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                TextButton(
                  onPressed: () => setState(() {
                    // Everything, or nothing. Refunding a whole bill is the
                    // common case and eighteen taps is not the way to say so.
                    if (_picked.length == detail.lines.length) {
                      _picked.clear();
                    } else {
                      _picked
                        ..clear()
                        ..addAll(
                          List.generate(detail.lines.length, (i) => i),
                        );
                    }
                  }),
                  child: Text(
                    _picked.length == detail.lines.length
                        ? 'Clear'
                        : 'Everything',
                  ),
                ),
              ],
            ),
          ),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: detail.lines.length,
            itemBuilder: (context, i) {
              final line = detail.lines[i];
              return CheckboxListTile(
                value: _picked.contains(i),
                onChanged: (on) => setState(() {
                  if (on ?? false) {
                    _picked.add(i);
                    // A modifier goes back with the item above it, always.
                    // Refunding a gin and keeping the customer's money for the
                    // dash of coke is not a refund anybody meant.
                    for (var j = i + 1;
                        j < detail.lines.length && detail.lines[j].isModifier;
                        j++) {
                      _picked.add(j);
                    }
                  } else {
                    _picked.remove(i);
                    for (var j = i + 1;
                        j < detail.lines.length && detail.lines[j].isModifier;
                        j++) {
                      _picked.remove(j);
                    }
                  }
                }),
                title: Text(
                  line.quantity == 1
                      ? line.name
                      : '${_qty(line.quantity)} × ${line.name}',
                ),
                subtitle: Text(money(line.lineTotalMinor)),
                // A modifier is ticked and unticked with its item, never on its
                // own — the same rule that governs splitting a bill.
                enabled: !line.isModifier,
                // A modifier goes back with the item it belongs to, so it is
                // indented and not offered as a choice of its own — the same
                // rule that governs splitting a bill.
                controlAffinity: ListTileControlAffinity.leading,
                contentPadding: EdgeInsets.only(
                  left: line.isModifier ? 40 : 12,
                  right: 12,
                ),
              );
            },
          ),
        ),
        _footer(scheme),
      ],
    );
  }

  Widget _footer(ColorScheme scheme) => Material(
        color: scheme.surfaceContainerHighest,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Refunding',
                      style: TextStyle(color: scheme.onSurfaceVariant),
                    ),
                    Text(
                      money(_refundMinor),
                      style: const TextStyle(
                        fontSize: 26,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
              FilledButton.icon(
                onPressed: _refundMinor > 0 ? _confirmFromReceipt : null,
                icon: const Icon(Icons.undo),
                label: const Text('Give it back'),
              ),
            ],
          ),
        ),
      );

  // ---------------------------------------------------------------------
  // Doing it
  // ---------------------------------------------------------------------

  Future<void> _confirmFromReceipt() async {
    final detail = _detail;
    if (detail == null || _refundMinor <= 0) return;

    final names = [
      for (var i = 0; i < detail.lines.length; i++)
        if (_picked.contains(i)) detail.lines[i].name,
    ];

    final ok = await _confirm(
      title: 'Give back ${money(_refundMinor)}?',
      body: 'It was paid by $_tenderSummary, so hand it back the same way.\n\n'
          '${names.join(', ')}\n\n'
          'A card refund is raised on the card machine itself — this records '
          'that it happened.',
    );
    if (ok != true) return;

    await _record(
      amountMinor: _refundMinor,
      note: 'Receipt ${detail.summary.id} · ${names.join(', ')}',
    );
  }

  /// The override. Under a manager's key, and it asks for a reason.
  Future<void> _refundWithoutReceipt() async {
    // A second key on top of the refund key that opened this screen. Refunding
    // against a receipt is bounded by what the customer actually paid; this is
    // not bounded by anything, which is precisely why it is the one that needs
    // a manager standing there.
    if (!await allowed(context, ref, TillPermission.isManager)) return;
    if (!mounted) return;

    final result = await showDialog<({int minor, String reason})>(
      context: context,
      builder: (_) => const _NoReceiptDialog(),
    );
    if (result == null || !mounted) return;

    final ok = await _confirm(
      title: 'Give back ${money(result.minor)}?',
      body: 'No receipt. ${result.reason}\n\n'
          'This is recorded on the Z report against your name.',
    );
    if (ok != true) return;

    await _record(
      amountMinor: result.minor,
      note: 'No receipt · ${result.reason}',
    );
  }

  Future<bool?> _confirm({required String title, required String body}) =>
      showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Give it back'),
            ),
          ],
        ),
      );

  Future<void> _record({required int amountMinor, required String note}) async {
    final session = await ref.read(sessionRepositoryProvider).current();
    await ref.read(orderRepositoryProvider).logRefund(
          sessionId: session.id,
          amountMinor: amountMinor,
          note: note,
          staffName: ref.read(servedByProvider),
        );
    if (!mounted) return;
    PosMessenger.success(
      context,
      '${money(amountMinor)} refunded. It is on the Z report.',
    );
    Navigator.of(context).pop();
  }
}

/// An amount and a reason, for a refund with nothing to attach it to.
class _NoReceiptDialog extends StatefulWidget {
  const _NoReceiptDialog();

  @override
  State<_NoReceiptDialog> createState() => _NoReceiptDialogState();
}

class _NoReceiptDialogState extends State<_NoReceiptDialog> {
  final _amount = TextEditingController();
  final _reason = TextEditingController();
  late TextEditingController _focused;

  @override
  void initState() {
    super.initState();
    _focused = _amount;
    _amount.addListener(() => setState(() {}));
    _reason.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _amount.dispose();
    _reason.dispose();
    super.dispose();
  }

  int? get _minor {
    final text = _amount.text.trim();
    if (text.isEmpty) return null;
    final pounds = double.tryParse(text);
    if (pounds == null || pounds <= 0) return null;
    return (pounds * 100).round();
  }

  /// A reason is required, and that is the point of the whole dialog.
  ///
  /// This is the one operation on the till that takes money out of the drawer
  /// with no customer-facing document behind it. "£20, no receipt, no reason"
  /// is not an audit trail, and a manager reading the Z three weeks later has
  /// nothing to go on.
  bool get _canGive => _minor != null && _reason.text.trim().length >= 3;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Refund without a receipt'),
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
                controller: _reason,
                keyboardType: TextInputType.none,
                onTap: () => setState(() => _focused = _reason),
                decoration: const InputDecoration(
                  labelText: 'Reason',
                  hintText: 'What is being refunded, and why',
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
                onSubmit: _canGive ? _submit : null,
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
          onPressed: _canGive ? _submit : null,
          child: const Text('Continue'),
        ),
      ],
    );
  }

  void _submit() {
    final minor = _minor;
    if (minor == null || !_canGive) return;
    Navigator.pop(context, (minor: minor, reason: _reason.text.trim()));
  }
}

String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);
