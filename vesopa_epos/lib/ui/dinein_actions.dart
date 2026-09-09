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

  final saleId = await _ringUp(ref, order, byPlu, tableNumber);

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

/// Put an order's lines onto the right table's bill, and answer which bill.
///
/// Shared by the two ways an order is accepted -- a clerk pressing Accept, and
/// the venue's auto-accept setting -- which run the two halves in opposite
/// orders. See `autoAcceptWaiting` for why.
Future<String> _ringUp(
  WidgetRef ref,
  DineInOrder order,
  Map<int, Product> byPlu,
  int tableNumber,
) async {
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

  return saleId;
}

/// Ring up an order this till has ALREADY claimed, and tell the server which
/// bill it landed on.
///
/// Only auto-accept uses this: it claims first, so the sale id cannot travel
/// with the acceptance and follows separately. Answers false when there was
/// nothing it could ring — a table deleted since the order was placed, or a
/// catalogue with none of the items in it — so the caller can say so.
Future<bool> ringUpAcceptedOrder(WidgetRef ref, DineInOrder order) async {
  final tableNumber = order.tableNumber;
  if (tableNumber == null) return false;

  final products = ref.read(productsProvider).value ?? const <Product>[];
  final byPlu = {for (final p in products) p.pluId: p};
  if (!order.lines.any((l) => byPlu.containsKey(l.pluId))) return false;

  final saleId = await _ringUp(ref, order, byPlu, tableNumber);
  await ref.read(dineInServiceProvider).linkSale(order.id, saleId);
  return true;
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

// ---------------------------------------------------------------------------
// Accepting without anybody pressing Accept
// ---------------------------------------------------------------------------

/// Whether this venue has asked for orders to be taken automatically.
///
/// Asked once and held for the life of the till session, like the membership
/// settings: it is one boolean that changes when a manager opens a settings
/// page, and re-reading it on every poll would be a request every thirty
/// seconds per terminal for a value that changes twice a year.
final dineInAutoAcceptProvider = FutureProvider<bool>(
  (ref) => ref.watch(dineInServiceProvider).autoAccept(),
);

/// Guards against two passes overlapping on one terminal.
///
/// The list refreshes on a socket push AND on a thirty-second timer, so two
/// refreshes can land together — and without this the same order would be rung
/// up twice onto the same bill before either claim came back.
bool _autoAccepting = false;

/// Take everything that is waiting, if the venue has asked us to.
///
/// WHY THIS CLAIMS THE ORDER BEFORE IT RINGS IT UP, WHICH IS BACKWARDS
///
/// `acceptDineInOrder` deliberately does the opposite: it rings the lines onto
/// a bill first and only then tells the server, so that the worst case is an
/// order sitting on a bill and still showing as waiting — visible, and fixable
/// by pressing Accept again. That is the right order for a clerk pressing a
/// key, and it is the wrong one here.
///
/// The difference is how many terminals are doing it. One clerk presses Accept
/// on one till. Auto-accept runs on EVERY till in the venue at once, and bills
/// are local to each terminal — so if three tills all ring the order up and
/// only one wins the server's transition, the other two are left holding local
/// bills with the same food on them. That is a table charged twice, quietly,
/// with nobody having touched anything.
///
/// So the claim goes first. The server's transition is atomic — it updates
/// `WHERE status IN ('placed')` — so exactly one terminal wins and the other
/// two do nothing at all. The cost is the failure this inversion creates: a
/// claim that succeeds and a ring-up that then fails leaves an order marked
/// accepted with nothing on a bill. It is the smaller of the two, it is loud
/// (the clerk is told), and it is recoverable by ringing the order up by hand
/// — which charging a table twice is not.
Future<void> autoAcceptWaiting(WidgetRef ref) async {
  if (_autoAccepting) return;

  final on = ref.read(dineInAutoAcceptProvider).value ?? false;
  if (!on) return;

  final waiting = [
    for (final order in ref.read(dineInOrdersProvider).value ?? const [])
      if (order.isWaiting) order,
  ];
  if (waiting.isEmpty) return;

  _autoAccepting = true;
  try {
    for (final order in waiting) {
      // Claimed first, and `by: auto` so the back office can answer "why did
      // this go straight to the kitchen?" months later.
      final claimed = await ref
          .read(dineInServiceProvider)
          .move(order.id, 'accepted', by: 'auto');
      // Another terminal got there first, or the order was withdrawn. Either
      // way this till has nothing to do and must not ring anything up.
      if (!claimed) continue;

      await ringUpAcceptedOrder(ref, order);
    }
  } finally {
    _autoAccepting = false;
    await ref.read(dineInOrdersProvider.notifier).refresh();
  }
}
