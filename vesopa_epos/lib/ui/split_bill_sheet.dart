/// Splitting a bill: a pool of items that drains into shares.
///
/// Rebuilt against the video the venue sent of how Newbridge do it, and the
/// difference from the first attempt is the interaction rather than the maths.
///
/// WHAT CHANGED, AND WHY IT MATTERS
///
/// The first version asked, for every line on the bill, "which numbered share
/// does this belong to?" — a row of chips per item. It worked. It also made the
/// operator hold a number in their head for every tap, and gave no way to see a
/// share as a thing in itself.
///
/// Newbridge's model, which is the one in the video: the bill starts as a
/// **pool**, you pick some items and press one key, and they *leave* the pool
/// and become a share of their own. Then the next few. The pool visibly drains
/// to zero, which is the whole check that nothing has been forgotten, and each
/// share exists as a card with its own total, its own bill to print and its own
/// key to pay it.
///
/// Seven items into three shares is three presses that way and seven decisions
/// the other, and the seven were the ones that could be got wrong quietly.
///
/// WHAT WE KEEP THAT THEY DO NOT HAVE
///
/// **By round.** A table two people served is already divided — see
/// `data/bill_rounds.dart` — so one press fills the cards from the rounds
/// rather than making the operator rebuild by hand what the till already knows.
///
/// WHAT THIS SCREEN DOES NOT DECIDE
///
/// The money. Share totals come from `TenderState.splitByItems`, which
/// apportions a bill-wide offer pro-rata, so what is previewed on a card, what
/// prints on that card's bill and what gets charged are one number computed
/// once. See tender_engine.dart.
library;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/bill_rounds.dart';
import '../data/modifier_layout.dart';
import '../data/pricing_engine.dart';
import '../data/split_portions.dart';
import '../data/tender_engine.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);

/// How the clerk decided to split.
class SplitChoice {
  const SplitChoice({
    required this.mode,
    this.ways = 0,
    this.groups,
    this.payShare,
  });

  final SplitMode mode;
  final int ways;
  final List<List<String>>? groups;

  /// The share the clerk pressed Pay Now on, if they did.
  ///
  /// The split is applied and that share made active, so the payment board is
  /// already asking for the right money when the sheet closes. Null means they
  /// finished with Done and will choose a share on the board.
  final int? payShare;
}

/// Which way of dividing the bill is on screen.
enum SplitMethod { items, equally }

/// Choose how to split a bill.
Future<SplitChoice?> showSplitDialog(
  BuildContext context, {
  required TenderState state,
  /// Print one share's bill. Null where there is no printer path — a widget
  /// test, or a screen with no order behind it.
  ///
  /// `quantities` says how many of a line this share is paying for, and is
  /// only non-empty when a line has been divided: the order still holds one
  /// `3 × Prosecco` row, and a share paying for one of them must not be handed
  /// a bill that says three.
  Future<void> Function(
    Set<String> lineIds,
    String title,
    int totalMinor,
    Map<String, double> quantities,
  )? onPrintShare,
}) =>
    showDialog<SplitChoice>(
      context: context,
      builder: (_) => SplitBillSheet(state: state, onPrintShare: onPrintShare),
    );

/// The screen itself. Public so a widget test can drive it directly.
class SplitBillSheet extends StatefulWidget {
  const SplitBillSheet({super.key, required this.state, this.onPrintShare});

  final TenderState state;
  final Future<void> Function(
    Set<String> lineIds,
    String title,
    int totalMinor,
    Map<String, double> quantities,
  )? onPrintShare;

  @override
  State<SplitBillSheet> createState() => SplitBillSheetState();
}

class SplitBillSheetState extends State<SplitBillSheet> {
  /// The bill as this screen works with it.
  ///
  /// Not `final`, and not the sale's own lines: dividing a round of three
  /// replaces one line here with three of one each. The order itself is never
  /// touched — see `data/split_portions.dart` — so a clerk who takes a round
  /// apart and then closes this screen has changed nothing.
  late List<PricedLine> _lines;
  late final List<BillRound> _rounds;

  SplitMethod _method = SplitMethod.items;
  int _ways = 2;

  /// The shares, in the order they were made. Each is a set of line ids, and
  /// an id in one may name a whole line or one unit of a divided one.
  final List<Set<String>> _shares = [];

  /// What the clerk has picked out of the pool but not yet split off.
  final Set<String> _picked = {};

  /// Lines that have been taken apart, and into how many.
  ///
  /// Kept so a divided line can be put back together, and so the printed bill
  /// can be told to say "1 × Prosecco" on a share that is paying for one.
  final Map<String, int> _divided = {};

  @override
  void initState() {
    super.initState();
    // Reading order, so a modifier sits under the item it belongs to here as
    // it does everywhere else.
    _lines = orderWithModifiers(
      widget.state.totals.lines,
      idOf: (l) => l.id,
      parentOf: (l) => l.parentLineId,
    );
    // Taken from the bill as rung, not from the working lines: a round is what
    // was ordered together, and dividing a line afterwards does not change what
    // was ordered together.
    _rounds = roundsOf(_lines);
  }

  // ---------------------------------------------------------------------
  // Taking a line apart
  // ---------------------------------------------------------------------

  /// Whether this line can be divided: more than one of it, a whole number of
  /// them, and not already in pieces.
  ///
  /// A fractional quantity is deliberately refused. A line rung up as 1.5 kg of
  /// something has no units to divide into, and offering "split into 1.5" would
  /// be offering nonsense; that bill is split by picking the line whole, which
  /// is what it always was.
  bool canDivide(PricedLine line) =>
      line.parentLineId == null &&
      !isPortion(line.id) &&
      line.quantity > 1 &&
      line.quantity == line.quantity.roundToDouble();

  /// Replace a line with one line per unit of it.
  ///
  /// Modifiers go with it. A round of three proseccos with three extra shots is
  /// three drinks that each had a shot, so each portion carries its own copy of
  /// each modifier, divided by the same rule. The alternative — refusing to
  /// divide anything that carries a modifier, which is what the venue's
  /// previous system does — would move this same complaint onto every dish with
  /// an option on it.
  void divide(String lineId) {
    final line = _lines.firstWhere((l) => l.id == lineId);
    if (!canDivide(line)) return;
    final count = line.quantity.round();

    final children = [for (final l in _lines) if (l.parentLineId == lineId) l];

    final replacement = <PricedLine>[];
    for (var i = 1; i <= count; i++) {
      replacement.add(_unit(line, count, i, parentId: null));
      for (final child in children) {
        replacement.add(
          _unit(child, count, i, parentId: portionId(lineId, i)),
        );
      }
    }

    setState(() {
      final at = _lines.indexWhere((l) => l.id == lineId);
      _lines = [
        ..._lines.sublist(0, at),
        ...replacement,
        // Everything after the line, minus the children that have just been
        // replaced by their own portions.
        for (final l in _lines.sublist(at + 1))
          if (l.parentLineId != lineId) l,
      ];
      _divided[lineId] = count;
      // A line that was picked is no longer a line. Its units start unpicked,
      // because "I meant these three" and "I meant one of these three" are
      // different instructions and the clerk has just said which.
      _picked.remove(lineId);
    });
  }

  /// One unit of [line], as a line in its own right.
  PricedLine _unit(
    PricedLine line,
    int count,
    int index, {
    required String? parentId,
  }) {
    final net = portionValue(line.netMinor, count, index);
    final gross = portionValue(line.grossMinor, count, index);
    return PricedLine(
      id: portionId(line.id, index),
      pluid: line.pluid,
      name: line.name,
      quantity: line.quantity / count,
      // Priced from the portion's own gross rather than from the line's unit
      // price, so `grossMinor` on the portion comes back to exactly what was
      // apportioned to it — including the odd penny.
      unitPriceMinor: gross,
      taxPercentage: line.taxPercentage,
      department: line.department,
      group: line.group,
      note: line.note,
      discountMinor: gross - net,
      promotionName: line.promotionName,
      promotionId: line.promotionId,
      addedBy: line.addedBy,
      addedAt: line.addedAt,
      parentLineId: parentId,
    );
  }

  /// Whether every unit of a divided line is still in the pool, which is the
  /// only state in which putting it back together means anything.
  bool canRejoin(String baseId) {
    if (!_divided.containsKey(baseId)) return false;
    final taken = <String>{for (final share in _shares) ...share};
    return !taken.any((id) => baseLineId(id) == baseId);
  }

  /// Put a divided line back together.
  void rejoin(String baseId) {
    if (!canRejoin(baseId)) return;
    final original = orderWithModifiers(
      widget.state.totals.lines,
      idOf: (l) => l.id,
      parentOf: (l) => l.parentLineId,
    );
    setState(() {
      final at = _lines.indexWhere((l) => baseLineId(l.id) == baseId);
      final restored = [
        for (final l in original)
          if (l.id == baseId || l.parentLineId == baseId) l,
      ];
      _lines = [
        for (final l in _lines.sublist(0, at)) l,
        ...restored,
        for (final l in _lines.sublist(at))
          if (baseLineId(l.id) != baseId) l,
      ];
      _divided.remove(baseId);
      _picked.removeWhere((id) => baseLineId(id) == baseId);
    });
  }

  // ---------------------------------------------------------------------
  // The pool
  // ---------------------------------------------------------------------

  /// Everything not yet on a share, in reading order.
  List<PricedLine> get _pool {
    final taken = <String>{for (final share in _shares) ...share};
    return [
      for (final line in _lines)
        if (!taken.contains(line.id)) line,
    ];
  }

  bool get _poolEmpty => _pool.isEmpty;

  int get _poolMinor =>
      _pool.fold<int>(0, (sum, line) => sum + line.netMinor);

  /// Take the picked items out of the pool and make them a share.
  void _splitOff() {
    if (_picked.isEmpty) return;
    setState(() {
      // Closed over the modifier relation, so an answer can never be separated
      // from its question — a priced modifier on somebody else's card is a bill
      // nobody at the table agreed to. See withModifiersOf.
      _shares.add(
        withModifiersOf(
          {..._picked},
          _lines,
          idOf: (l) => l.id,
          parentOf: (l) => l.parentLineId,
        ),
      );
      _picked.clear();
    });
  }

  /// Send a share's items back to the pool.
  void _returnShare(int index) {
    setState(() => _shares.removeAt(index));
  }

  /// Fill the shares from the rounds the bill was rung in, in one press.
  void _splitByRounds() {
    setState(() {
      // Rounds are groups of whole lines, so the divisions go first: filling
      // the cards from the rounds while three portions were loose would put
      // some of the bill on a card and leave the rest of the same drink in the
      // pool, which is not what "by round" means.
      _divided.clear();
      _lines = orderWithModifiers(
        widget.state.totals.lines,
        idOf: (l) => l.id,
        parentOf: (l) => l.parentLineId,
      );
      _shares
        ..clear()
        ..addAll([
          for (final round in _rounds)
            lineIdsOfRounds([round], _lines),
        ]);
      _picked.clear();
    });
  }

  void _undo() {
    setState(() {
      _shares.clear();
      _picked.clear();
      // The divisions go back as well. "Undo split" means the bill as it was,
      // and a screen that returned every share but left three separate glasses
      // in the pool would have undone half of what it says it undoes.
      _divided.clear();
      _lines = orderWithModifiers(
        widget.state.totals.lines,
        idOf: (l) => l.id,
        parentOf: (l) => l.parentLineId,
      );
    });
  }

  // ---------------------------------------------------------------------
  // The money
  // ---------------------------------------------------------------------

  /// The shares as the engine wants them, with anything left in the pool as a
  /// share of its own.
  ///
  /// The leftover matters. A table where two people pay and the rest is settled
  /// together is an ordinary way to split a bill, and dropping what is left
  /// would be a split that does not add up to what is owed.
  List<List<String>> get groups {
    final out = [for (final share in _shares) share.toList()];
    final left = _pool;
    if (left.isNotEmpty) out.add([for (final line in left) line.id]);
    return out;
  }

  /// What each share comes to, offer included.
  ///
  /// Run through the real engine rather than summed here, so the number on the
  /// card, the number on its printed bill and the number charged are one
  /// figure computed once.
  List<SplitShare> get preview {
    if (_method == SplitMethod.equally) {
      return widget.state.splitEqually(_ways).shares;
    }
    final picked = groups;
    if (picked.length < 2) return const [];
    return widget.state.splitByItems(picked).shares;
  }

  int _shareTotal(int index) {
    final shares = preview;
    return index < shares.length ? shares[index].amountMinor : 0;
  }

  // ---------------------------------------------------------------------
  // Leaving
  // ---------------------------------------------------------------------

  SplitChoice _asChoice({int? payShare}) {
    if (_method == SplitMethod.equally) {
      return SplitChoice(
        mode: SplitMode.equally,
        ways: _ways,
        payShare: payShare,
      );
    }
    final picked = groups;
    // Everything on one share is not a split — it is the bill, paid whole.
    // This is also how "select both to pay" is expressed.
    if (picked.length < 2) return const SplitChoice(mode: SplitMode.none);
    return SplitChoice(
      mode: SplitMode.byItem,
      groups: picked,
      payShare: payShare,
    );
  }

  void _done() => Navigator.pop(context, _asChoice());

  void _payShare(int index) => Navigator.pop(context, _asChoice(payShare: index));

  /// How many of each real line a share holds.
  ///
  /// A share paying for one of three proseccos must not be handed a bill that
  /// says `3 × Prosecco`. The printer works from the order's own lines — the
  /// undivided ones — so it is told the quantity to print instead: one per
  /// portion held.
  Map<String, double> shareQuantities(int index) {
    final counts = <String, double>{};
    for (final id in _shares[index]) {
      if (!isPortion(id)) continue;
      counts[baseLineId(id)] = (counts[baseLineId(id)] ?? 0) + 1;
    }
    return counts;
  }

  Future<void> _printShare(int index) async {
    final print = widget.onPrintShare;
    if (print == null) return;
    await print(
      // The real line ids, because that is what the order holds. Two portions
      // of one line collapse to one id, and the quantity map below is what
      // says there were two.
      {for (final id in _shares[index]) baseLineId(id)},
      'Share ${index + 1} of ${groups.length}',
      _shareTotal(index),
      shareQuantities(index),
    );
  }

  // ---------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    final scheme = Theme.of(context).colorScheme;

    return Dialog(
      insetPadding: const EdgeInsets.all(16),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: screen.width * 0.96,
          maxHeight: screen.height * 0.94,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _title(scheme),
            Flexible(
              child: _method == SplitMethod.equally
                  ? _equally(scheme)
                  : _workspace(scheme),
            ),
            _actions(scheme),
          ],
        ),
      ),
    );
  }

  Widget _title(ColorScheme scheme) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 12, 8),
        child: Row(
          children: [
            Expanded(
              child: Text(
                'Split the bill',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            Text(
              '${_money(widget.state.outstandingMinor)} left to pay',
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
            IconButton(
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.close),
              tooltip: 'Leave the bill as it is',
            ),
          ],
        ),
      );

  /// The pool on the left, the shares on the right.
  Widget _workspace(ColorScheme scheme) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(width: 300, child: _poolPanel(scheme)),
            const SizedBox(width: 14),
            Expanded(child: _sharesPanel(scheme)),
          ],
        ),
      );

  Widget _poolPanel(ColorScheme scheme) {
    final pool = _pool;

    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: scheme.outlineVariant),
        borderRadius: BorderRadius.circular(10),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: scheme.surfaceContainerHighest,
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            child: Text(
              _poolEmpty ? 'All split' : 'Not split yet',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          Expanded(
            child: pool.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Text(
                        'Every item is on a share.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: scheme.onSurfaceVariant),
                      ),
                    ),
                  )
                : ListView(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    children: [
                      for (final line in pool)
                        // A modifier is drawn under its item and cannot be
                        // picked on its own — it goes where its item goes.
                        if (line.parentLineId == null)
                          _PoolRow(
                            line: line,
                            modifiers: [
                              for (final m in pool)
                                if (m.parentLineId == line.id) m,
                            ],
                            picked: _picked.contains(line.id),
                            onTap: () => setState(() {
                              if (!_picked.remove(line.id)) {
                                _picked.add(line.id);
                              }
                            }),
                            // Offered on a round of more than one, and on
                            // nothing else: a single glass has nothing to
                            // divide, and the key would only be a question
                            // with no answer.
                            onDivide: canDivide(line)
                                ? () => divide(line.id)
                                : null,
                            onRejoin: canRejoin(baseLineId(line.id))
                                ? () => rejoin(baseLineId(line.id))
                                : null,
                            // "2 of 3", so the clerk can see which glass is
                            // going where. Without it three identical rows
                            // appear out of one and nothing says why.
                            ofLabel: isPortion(line.id)
                                ? '${portionIndex(line.id)} of '
                                    '${_divided[baseLineId(line.id)] ?? 0}'
                                : null,
                          ),
                    ],
                  ),
          ),
          Container(
            color: scheme.surfaceContainerHighest,
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            child: Row(
              children: [
                const Expanded(child: Text('Left to split')),
                Text(
                  _money(_poolMinor),
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
            child: FilledButton.icon(
              onPressed: _picked.isEmpty ? null : _splitOff,
              icon: const Icon(Icons.call_split),
              label: Text(
                _picked.isEmpty
                    ? 'Pick items to split off'
                    : 'Split off ${_picked.length} item'
                        '${_picked.length == 1 ? '' : 's'}',
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sharesPanel(ColorScheme scheme) {
    if (_shares.isEmpty) {
      return Container(
        decoration: BoxDecoration(
          border: Border.all(color: scheme.outlineVariant),
          borderRadius: BorderRadius.circular(10),
        ),
        alignment: Alignment.center,
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Text(
            _rounds.length > 1
                ? 'Pick items on the left and split them off, or press '
                    '“By round” to split the way it was rung.'
                : 'Pick items on the left and split them off.',
            textAlign: TextAlign.center,
            style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 15),
          ),
        ),
      );
    }

    return SingleChildScrollView(
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          for (var i = 0; i < _shares.length; i++)
            _ShareCard(
              index: i,
              lines: [
                for (final line in _lines)
                  if (_shares[i].contains(line.id)) line,
              ],
              totalMinor: _shareTotal(i),
              onReturn: () => _returnShare(i),
              onPrint: widget.onPrintShare == null
                  ? null
                  : () => _printShare(i),
              // A share cannot be paid until the split is a split. One share
              // and a full pool is the whole bill wearing a different hat.
              onPay: groups.length < 2 ? null : () => _payShare(i),
            ),
        ],
      ),
    );
  }

  Widget _equally(ColorScheme scheme) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '${_money(widget.state.outstandingMinor)} between $_ways',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                const Text('Ways'),
                const SizedBox(width: 10),
                Expanded(
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final ways in const [2, 3, 4, 5, 6, 8])
                        ChoiceChip(
                          label: Text('$ways'),
                          selected: _ways == ways,
                          onSelected: (_) => setState(() => _ways = ways),
                        ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Row(
                children: [
                  const Expanded(child: Text('Each pays')),
                  Text(
                    _money(
                      preview.isEmpty ? 0 : preview.first.amountMinor,
                    ),
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _actions(ColorScheme scheme) => Container(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: scheme.outlineVariant)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
        child: Wrap(
          spacing: 10,
          runSpacing: 10,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            // Only offered when the bill has rounds — on a counter sale it
            // would be a key that makes one share of everything.
            if (hasRounds(_rounds) && _method == SplitMethod.items)
              OutlinedButton.icon(
                onPressed: _splitByRounds,
                icon: const Icon(Icons.groups_outlined),
                label: const Text('By round'),
              ),
            SegmentedButton<SplitMethod>(
              segments: const [
                ButtonSegment(
                  value: SplitMethod.items,
                  icon: Icon(Icons.checklist),
                  label: Text('By item'),
                ),
                ButtonSegment(
                  value: SplitMethod.equally,
                  icon: Icon(Icons.pie_chart_outline),
                  label: Text('Equally'),
                ),
              ],
              selected: {_method},
              onSelectionChanged: (s) => setState(() => _method = s.first),
            ),
            if (_method == SplitMethod.items && _shares.isNotEmpty)
              TextButton.icon(
                onPressed: _undo,
                icon: const Icon(Icons.undo),
                label: const Text('Undo split'),
              ),
            FilledButton(onPressed: _done, child: const Text('Done')),
          ],
        ),
      );
}

/// One item waiting to be put on a share.
class _PoolRow extends StatelessWidget {
  const _PoolRow({
    required this.line,
    required this.modifiers,
    required this.picked,
    required this.onTap,
    this.onDivide,
    this.onRejoin,
    this.ofLabel,
  });

  final PricedLine line;
  final List<PricedLine> modifiers;
  final bool picked;
  final VoidCallback onTap;

  /// Take this line apart, one row per unit. Null when there is nothing to
  /// take apart.
  final VoidCallback? onDivide;

  /// Put the units back together. Null unless every one of them is still here.
  final VoidCallback? onRejoin;

  /// "2 of 3" on a unit of a divided line; null on a whole one.
  final String? ofLabel;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // A modifier is paid for by whoever pays for the item, so its money shows
    // against the item rather than on a row that cannot be moved.
    final total = modifiers.fold<int>(line.netMinor, (s, m) => s + m.netMinor);

    return Material(
      color: picked ? scheme.primaryContainer : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 12, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                picked ? Icons.check_circle : Icons.circle_outlined,
                size: 20,
                color: picked ? scheme.primary : scheme.outline,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            line.quantity == 1
                                ? line.name
                                : '${_qty(line.quantity)} × ${line.name}',
                            style: const TextStyle(fontSize: 14.5),
                          ),
                        ),
                        if (ofLabel != null) ...[
                          const SizedBox(width: 6),
                          Text(
                            ofLabel!,
                            style: TextStyle(
                              fontSize: 11.5,
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                    if (modifiers.isNotEmpty)
                      Text(
                        modifiers.map((m) => m.name).join(',  '),
                        style: TextStyle(
                          fontSize: 11.5,
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(_money(total), style: const TextStyle(fontSize: 14.5)),
              // The key that answers "3 x Prosecco and you can't split them
              // off". Small, and only present on the rows it means anything
              // for, so the pool still reads as a list rather than a toolbar.
              if (onDivide != null)
                IconButton(
                  onPressed: onDivide,
                  visualDensity: VisualDensity.compact,
                  iconSize: 19,
                  tooltip: 'Split these ${_qty(line.quantity)} up',
                  icon: const Icon(Icons.call_split),
                )
              else if (onRejoin != null)
                IconButton(
                  onPressed: onRejoin,
                  visualDensity: VisualDensity.compact,
                  iconSize: 19,
                  tooltip: 'Put these back together',
                  icon: const Icon(Icons.merge),
                )
              else
                const SizedBox(width: 40),
            ],
          ),
        ),
      ),
    );
  }
}

/// One share: what is on it, what it comes to, and the two things to do with it.
class _ShareCard extends StatelessWidget {
  const _ShareCard({
    required this.index,
    required this.lines,
    required this.totalMinor,
    required this.onReturn,
    this.onPrint,
    this.onPay,
  });

  final int index;
  final List<PricedLine> lines;
  final int totalMinor;
  final VoidCallback onReturn;
  final VoidCallback? onPrint;
  final VoidCallback? onPay;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return SizedBox(
      width: 300,
      child: Card(
        margin: EdgeInsets.zero,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 6, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Share ${index + 1}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 15,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: onReturn,
                    visualDensity: VisualDensity.compact,
                    iconSize: 20,
                    tooltip: 'Put these back',
                    icon: const Icon(Icons.undo),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final line in lines)
                    Padding(
                      padding: EdgeInsets.only(
                        left: line.parentLineId == null ? 0 : 14,
                        bottom: 2,
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              line.quantity == 1
                                  ? line.name
                                  : '${_qty(line.quantity)} × ${line.name}',
                              style: TextStyle(
                                fontSize: line.parentLineId == null ? 14 : 12,
                                color: line.parentLineId == null
                                    ? null
                                    : scheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                          if (line.parentLineId == null)
                            Text(
                              _money(line.netMinor),
                              style: const TextStyle(fontSize: 14),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            Container(
              color: scheme.surfaceContainerHighest,
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
              child: Row(
                children: [
                  const Expanded(child: Text('Total')),
                  Text(
                    _money(totalMinor),
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 17,
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: onPrint,
                      icon: const Icon(Icons.print, size: 18),
                      label: const Text('Bill'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: onPay,
                      icon: const Icon(Icons.payments_outlined, size: 18),
                      label: const Text('Pay now'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
