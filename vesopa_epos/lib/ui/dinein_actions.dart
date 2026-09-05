/// What a clerk can do with an order that came in from a phone, in one place.
///
/// Accepting is not a button, it is a small transaction across three systems —
/// the catalogue, this till's own bills, and the server — and it has three
/// different ways of going half-right. It was written once inside the orders
/// sheet, and then the toast needed the same thing. Two copies of this would be
/// two copies of the ordering that makes it safe, and the second one would be
/// the one that got it wrong.
///
/// So both call in here.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/dinein_orders.dart';
import '../data/local/database.dart';
import '../data/staff_session.dart';
import '../main.dart';
import 'sale_page.dart' show productsProvider;
import 'widgets/on_screen_keyboard.dart';
import 'widgets/pos_message.dart';
import 'theme.dart';

/// What happened, and what to say about it.
@immutable
class DineInOutcome {
  const DineInOutcome(this.message, {this.ok = true});

  final String message;
  final bool ok;
}

/// Ring an order onto its table's bill, then tell the server it was taken.
///
/// IN THAT ORDER, AND IT MATTERS
///
/// Claiming it on the server first and then failing to ring it up would tell
/// the customer their food was accepted while nothing existed on this till.
/// Doing the local work first means the worst case is an order that is on a
/// bill and still showing as waiting — visible, and fixable by pressing Accept
/// again, which the server refuses without making a second bill.
Future<DineInOutcome> acceptDineInOrder(WidgetRef ref, DineInOrder order) async {
  final tableNumber = order.tableNumber;
  if (tableNumber == null) {
    return const DineInOutcome(
      'That table has been deleted since the order was placed. Ring it up by '
      'hand and refuse this one so the customer is told.',
      ok: false,
    );
  }

  final products = ref.read(productsProvider).value ?? const <Product>[];
  final byPlu = {for (final p in products) p.pluId: p};

  // Everything the till cannot ring, named. A meal arriving without its side
  // because a PLU was deleted last week is worse than being told.
  final missing = [
    for (final line in order.lines)
      if (!byPlu.containsKey(line.pluId)) line.name,
  ];
  if (missing.length == order.lines.length) {
    return const DineInOutcome(
      "None of these items are in this till's catalogue. Ring the order up by "
      'hand.',
      ok: false,
    );
  }

  final tables = ref.read(tableRepositoryProvider);
  final orders = ref.read(orderRepositoryProvider);

  // Onto the bill already on that table when there is one. A second bill for a
  // table that is mid-meal is how a customer ends up paying twice.
  final existing = await tables.orderOn(tableNumber);
  final saleId = existing?.id ?? await orders.openOrder(tableNumber: tableNumber);
  if (existing == null) {
    await orders.setTable(saleId, tableNumber);
  }

  final staff = ref.read(staffSessionProvider).staff;
  for (final line in order.lines) {
    final product = byPlu[line.pluId];
    if (product == null) continue;
    await orders.addLine(
      saleId,
      product,
      qty: line.qty.toDouble(),
      addedBy: staff?.name,
    );
  }

  final moved = await ref
      .read(dineInOrdersProvider.notifier)
      .move(order.id, 'accepted', saleId: saleId);

  if (!moved) {
    return DineInOutcome(
      'Another till accepted this one first. The items are on '
      "${order.tableLabel}'s bill — check it before ringing them again.",
      ok: false,
    );
  }

  return DineInOutcome(
    missing.isEmpty
        ? 'Accepted onto ${order.tableLabel}.'
        : 'Accepted onto ${order.tableLabel}, but ${missing.join(', ')} could '
              'not be rung up — add it by hand.',
    ok: missing.isEmpty,
  );
}

/// Refuse an order, with a reason the customer will read.
Future<DineInOutcome> refuseDineInOrder(
  WidgetRef ref,
  DineInOrder order,
  String reason,
) async {
  final moved = await ref
      .read(dineInOrdersProvider.notifier)
      .move(order.id, 'rejected', note: reason);
  return moved
      ? const DineInOutcome("Refused. The customer's phone will say so.")
      : const DineInOutcome('That order has already moved on.', ok: false);
}

/// Say what happened, wherever it happened from.
void sayDineIn(BuildContext context, DineInOutcome outcome) {
  if (!context.mounted) return;
  if (outcome.ok) {
    PosMessenger.success(context, outcome.message);
  } else {
    PosMessenger.error(context, outcome.message);
  }
}

/// The reasons a kitchen turns an order down.
///
/// Fixed rather than fetched, unlike the void reasons: those are a venue's own
/// accounting categories and belong in the back office, while these are
/// sentences a customer reads on their phone thirty seconds later. A venue
/// writing its own is exactly what "Something else…" is for.
const dineInRefusalReasons = <String>[
  'Sorry, the kitchen has closed.',
  'Sorry, we have run out of one of those.',
  'Sorry, we are too busy to take this right now.',
  'Please come to the bar to order.',
  'Sorry, we cannot take orders to that table.',
];

/// Ask why, and hand back the sentence the customer will see.
///
/// Presets first, because four taps out of five are one of them and a clerk
/// refusing an order is doing it under pressure with a queue. "Something else…"
/// opens the same on-screen keyboard the void dialog uses — the till often has
/// no keyboard behind it, and without one that option would be one a clerk can
/// choose and then not answer.
Future<String?> askWhyRefused(BuildContext context, DineInOrder order) =>
    showDialog<String>(
      context: context,
      builder: (_) => _RefusalDialog(order: order),
    );

class _RefusalDialog extends StatefulWidget {
  const _RefusalDialog({required this.order});

  final DineInOrder order;

  @override
  State<_RefusalDialog> createState() => _RefusalDialogState();
}

class _RefusalDialogState extends State<_RefusalDialog> {
  static const _custom = '__custom__';

  String? _selected = dineInRefusalReasons.first;
  final _typed = TextEditingController();

  @override
  void initState() {
    super.initState();
    _typed.addListener(_redraw);
  }

  @override
  void dispose() {
    _typed.removeListener(_redraw);
    _typed.dispose();
    super.dispose();
  }

  void _redraw() {
    if (mounted) setState(() {});
  }

  bool get _isCustom => _selected == _custom;

  /// A refusal with nothing written on it is a refusal the customer cannot act
  /// on, so the button stays off until there is something to send.
  bool get _canSend =>
      _isCustom ? _typed.text.trim().isNotEmpty : _selected != null;

  void _send() {
    if (!_canSend) return;
    Navigator.pop(context, _isCustom ? _typed.text.trim() : _selected);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Row(
      children: [
        const Icon(Icons.do_not_disturb_on_outlined, color: Pos.red),
        const SizedBox(width: 12),
        Expanded(
          child: Text('Cannot take ${widget.order.tableLabel}\'s order?'),
        ),
      ],
    ),
    content: SizedBox(
      // Widened once the keyboard is out. The keyboard divides its keys out of
      // whatever width it is given rather than overflowing, so a narrow dialog
      // does not break — it just makes the keys too small to hit.
      width: _isCustom ? 660 : 420,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'This goes straight to the phone that ordered it, so write it the '
              'way you would say it across the counter.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 14),
            for (final reason in dineInRefusalReasons)
              RadioListTile<String>(
                dense: true,
                contentPadding: EdgeInsets.zero,
                value: reason,
                // ignore: deprecated_member_use
                groupValue: _selected,
                // ignore: deprecated_member_use
                onChanged: (v) => setState(() => _selected = v),
                title: Text(reason),
              ),
            RadioListTile<String>(
              dense: true,
              contentPadding: EdgeInsets.zero,
              value: _custom,
              // ignore: deprecated_member_use
              groupValue: _selected,
              // ignore: deprecated_member_use
              onChanged: (v) => setState(() => _selected = v),
              title: const Text('Something else…'),
            ),
            if (_isCustom) ...[
              const SizedBox(height: 4),
              TextField(
                controller: _typed,
                autofocus: true,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _send(),
                // Ours is the input method. A hardware keyboard still types
                // into this; this only stops Windows sliding its own touch
                // keyboard over the top of ours.
                keyboardType: TextInputType.none,
                decoration: const InputDecoration(
                  hintText: 'Tell them why',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 10),
              OnScreenKeyboard(
                controller: _typed,
                submitLabel: 'Send',
                onSubmit: _canSend ? _send : null,
              ),
            ],
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Keep it waiting'),
      ),
      FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: Pos.red,
          foregroundColor: Colors.white,
        ),
        onPressed: _canSend ? _send : null,
        child: const Text('Tell them no'),
      ),
    ],
  );
}

/// Refuse an order, asking why first. Shared by the sheet and the toast.
Future<void> refuseWithReason(
  BuildContext context,
  WidgetRef ref,
  DineInOrder order,
) async {
  final reason = await askWhyRefused(context, order);
  if (reason == null || !context.mounted) return;
  final outcome = await refuseDineInOrder(ref, order, reason);
  if (context.mounted) sayDineIn(context, outcome);
}

/// Accept an order and say what happened. Shared by the sheet and the toast.
Future<void> acceptAndSay(
  BuildContext context,
  WidgetRef ref,
  DineInOrder order,
) async {
  final outcome = await acceptDineInOrder(ref, order);
  if (context.mounted) sayDineIn(context, outcome);
}

/// Kept so `unawaited` reads the same way here as everywhere else.
void ignore(Future<void> future) => unawaited(future);
