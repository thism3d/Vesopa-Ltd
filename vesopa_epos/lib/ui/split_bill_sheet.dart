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
import '../data/split_options.dart';
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
    this.payAndKeep,
    this.names = const [],
    this.amounts = const [],
  });

  final SplitMode mode;
  final int ways;
  final List<List<String>>? groups;

  /// Who each share is, in share order; blank where nobody was named.
  final List<String> names;

  /// For a split by amount: the amounts the clerk typed, the rest a last share.
  final List<int> amounts;

  /// The share the clerk pressed Pay Now on, if they did.
  ///
  /// The split is applied and that share made active, so the payment board is
  /// already asking for the right money when the sheet closes. Null means they
  /// finished with Done and will choose a share on the board.
  final int? payShare;

  /// "One person is leaving": the order's own line ids to move onto a bill of
  /// their own and pay now, while the rest stays on the table for the others
  /// to pay later (Pontardawe RFC, 2026-10-13).
  final List<String>? payAndKeep;
}

/// Which way of dividing the bill is on screen.
enum SplitMethod { items, equally, amount }

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
  /// Whether "pay these, keep the rest on the table" is offered: a bill on a
  /// table with nothing paid on it yet.
  bool canKeepRest = false,
  SplitOptions options = const SplitOptions(),
}) =>
    showDialog<SplitChoice>(
      context: context,
      builder: (_) => SplitBillSheet(state: state, onPrintShare: onPrintShare, canKeepRest: canKeepRest, options: options),
    );

/// The screen itself. Public so a widget test can drive it directly.
class SplitBillSheet extends StatefulWidget {
  const SplitBillSheet({
    super.key,
    required this.state,
    this.onPrintShare,
    this.canKeepRest = false,
    this.options = const SplitOptions(),
  });

  final TenderState state;
  final bool canKeepRest;

  /// The venue's choices from the back office (data/split_options.dart).
  final SplitOptions options;
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

  /// Names, by share, for each way of splitting (blank: "Share 2").
  final List<String> _names = [];
  final Map<int, String> _equalNames = {};
  final Map<int, String> _amountNames = {};

  /// Split by amount: what each named share pays; the rest is a last share.
  final List<int> _amounts = [];

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
    _method = switch (widget.options.defaultMethod) {
      'equally' => SplitMethod.equally,
      'amount' when widget.options.byAmount => SplitMethod.amount,
      _ => SplitMethod.items,
    };
  }

  /// Keep a name per share as shares come and go.
  void _syncNames() {
    while (_names.length < _shares.length) {
      _names.add('');
    }
    if (_names.length > _shares.length) _names.removeRange(_shares.length, _names.length);
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
      _syncNames();
    });
  }

  /// Send a share's items back to the pool.
  void _returnShare(int index) {
    setState(() {
      _shares.removeAt(index);
      if (index < _names.length) _names.removeAt(index);
    });
  }

  /// Newbridge's minus: one item off a share and back into the pool, its
  /// modifiers with it. A share left with nothing goes too.
  void _removeFromShare(int index, String lineId) {
    setState(() {
      final share = _shares[index];
      share.remove(lineId);
      for (final l in _lines) {
        if (l.parentLineId == baseLineId(lineId) || l.parentLineId == lineId) share.remove(l.id);
      }
      if (share.isEmpty) {
        _shares.removeAt(index);
        if (index < _names.length) _names.removeAt(index);
      }
    });
  }

  /// Newbridge's plus: the items picked in the pool go onto this share.
  void _addPickedTo(int index) {
    if (_picked.isEmpty) return;
    setState(() {
      _shares[index].addAll(withModifiersOf(
        {..._picked},
        _lines,
        idOf: (l) => l.id,
        parentOf: (l) => l.parentLineId,
      ));
      _picked.clear();
    });
  }

  Future<void> _rename(int index, Map<int, String>? into) async {
    final current = into == null ? (index < _names.length ? _names[index] : '') : (into[index] ?? '');
    final field = TextEditingController(text: current);
    final name = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Who is share ${index + 1}?'),
        content: TextField(
          controller: field,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(hintText: 'A name, such as Carys'),
          onSubmitted: (v) => Navigator.pop(c, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, field.text), child: const Text('Save')),
        ],
      ),
    );
    if (name == null || !mounted) return;
    setState(() {
      if (into == null) {
        _syncNames();
        _names[index] = name.trim();
      } else {
        into[index] = name.trim();
      }
    });
  }

  String _labelOf(int index, Map<int, String>? names) {
    final n = names == null ? (index < _names.length ? _names[index] : '') : (names[index] ?? '');
    return n.trim().isEmpty ? 'Share ${index + 1}' : n.trim();
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
      _names.clear();
      _syncNames();
    });
  }

  void _undo() {
    setState(() {
      _shares.clear();
      _names.clear();
      _amounts.clear();
      _amountNames.clear();
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
    if (_method == SplitMethod.amount) {
      return widget.state.splitByAmounts(_amounts).shares;
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
        names: [for (var i = 0; i < _ways; i++) _equalNames[i] ?? ''],
      );
    }
    if (_method == SplitMethod.amount) {
      final shares = preview;
      if (shares.length < 2) return const SplitChoice(mode: SplitMode.none);
      return SplitChoice(
        mode: SplitMode.byAmount,
        amounts: [..._amounts],
        payShare: payShare,
        names: [for (var i = 0; i < shares.length; i++) _amountNames[i] ?? ''],
      );
    }
    final picked = groups;
    // Everything on one share is not a split — it is the bill, paid whole.
    // This is also how "select both to pay" is expressed.
    if (picked.length < 2) return const SplitChoice(mode: SplitMode.none);
    _syncNames();
    return SplitChoice(
      mode: SplitMode.byItem,
      groups: picked,
      payShare: payShare,
      names: [..._names, ''],
    );
  }

  void _done() => Navigator.pop(context, _asChoice());

  void _payShare(int index) => Navigator.pop(context, _asChoice(payShare: index));

  /// Once a payment has been taken on this bill the split is fixed: undoing
  /// it, or putting a share's items back, would move money that has already
  /// been paid (Pontardawe RFC, 2026-10-13: "after one payment is taken,
  /// please remove the undo feature").
  bool get _locked => widget.state.paidMinor > 0;

  /// The share's items as the order's own lines, or null when the share holds
  /// part of a divided line (a portion has no line of its own to move).
  List<String>? _wholeLines(int index) {
    final ids = _shares[index];
    if (ids.any(isPortion)) return null;
    return ids.toList();
  }

  void _payAndKeep(int index) {
    final ids = _wholeLines(index);
    if (ids == null) return;
    Navigator.pop(context, SplitChoice(mode: SplitMode.none, payAndKeep: ids));
  }

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
    // A share past the cards is the pool, settled together.
    final ids = index < _shares.length ? _shares[index] : {for (final l in _pool) l.id};
    await print(
      // The real line ids, because that is what the order holds. Two portions
      // of one line collapse to one id, and the quantity map below is what
      // says there were two.
      {for (final id in ids) baseLineId(id)},
      '${_labelOf(index, null)} · ${index + 1} of ${groups.length}',
      _shareTotal(index),
      index < _shares.length ? shareQuantities(index) : const {},
    );
  }

  /// An equal share's bill: every line, at 1/N of its quantity.
  Future<void> _printEqualShare(int index) async {
    final print = widget.onPrintShare;
    if (print == null) return;
    final whole = widget.state.totals.lines;
    await print(
      {for (final l in whole) l.id},
      '${_labelOf(index, _equalNames)} · ${index + 1} of $_ways',
      _shareTotal(index),
      {for (final l in whole) l.id: l.quantity / _ways},
    );
  }

  /// An amount share's bill: the whole bill, with what this person pays.
  Future<void> _printAmountShare(int index) async {
    final print = widget.onPrintShare;
    if (print == null) return;
    await print(
      {for (final l in widget.state.totals.lines) l.id},
      '${_labelOf(index, _amountNames)} · ${index + 1} of ${preview.length}',
      _shareTotal(index),
      const {},
    );
  }

  /// Every share's bill, one after another (Newbridge's Print All).
  Future<void> _printAll() async {
    final count = preview.length;
    for (var i = 0; i < count; i++) {
      if (!mounted) return;
      switch (_method) {
        case SplitMethod.equally:
          await _printEqualShare(i);
        case SplitMethod.amount:
          await _printAmountShare(i);
        case SplitMethod.items:
          await _printShare(i);
      }
    }
  }

  Future<void> _askAmount() async {
    final field = TextEditingController();
    final typed = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('How much does this person pay?'),
        content: TextField(
          controller: field,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(prefixText: '£ ', hintText: _money(widget.state.outstandingMinor).replaceAll('£', '')),
          onSubmitted: (v) => Navigator.pop(c, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, field.text), child: const Text('Add')),
        ],
      ),
    );
    if (typed == null || !mounted) return;
    // Pence exactly: 12.5 is £12.50, never a rounding of a double.
    final m = RegExp(r'^\s*(\d+)(?:\.(\d{1,2}))?\s*$').firstMatch(typed.replaceAll('£', ''));
    if (m == null) return;
    final minor = int.parse(m.group(1)!) * 100 + int.parse((m.group(2) ?? '0').padRight(2, '0'));
    if (minor <= 0) return;
    final committed = _amounts.fold<int>(0, (s, v) => s + v);
    if (committed + minor >= widget.state.outstandingMinor) return;
    setState(() => _amounts.add(minor));
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
              child: switch (_method) {
                SplitMethod.equally => _equally(scheme),
                SplitMethod.amount => _byAmount(scheme),
                SplitMethod.items => _workspace(scheme),
              },
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
              // Each share is its own items at their own prices, so money
              // already taken on the bill is said here rather than hidden in
              // the shares (2026-11-07).
              widget.state.paidMinor > 0
                  ? '${_money(widget.state.paidMinor)} paid · ${_money(widget.state.outstandingMinor)} left to pay'
                  : '${_money(widget.state.outstandingMinor)} left to pay',
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
              title: _labelOf(i, null),
              onRename: widget.options.names ? () => _rename(i, null) : null,
              lines: [
                for (final line in _lines)
                  if (_shares[i].contains(line.id)) line,
              ],
              totalMinor: _shareTotal(i),
              onRemoveLine: _locked ? null : (id) => _removeFromShare(i, id),
              onAddPicked: _locked || _picked.isEmpty ? null : () => _addPickedTo(i),
              pickedCount: _picked.length,
              onReturn: _locked ? null : () => _returnShare(i),
              // Something must be left for the table: other items still in the
              // pool or on other shares.
              onPayAndKeep: widget.canKeepRest &&
                      !_locked &&
                      _wholeLines(i) != null &&
                      (_pool.isNotEmpty || _shares.length > 1)
                  ? () => _payAndKeep(i)
                  : null,
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

  /// Equal shares as cards: each person's [1/N] of every item, to the penny,
  /// with their own bill and their own Pay now (Newbridge's equal split).
  Widget _equally(ColorScheme scheme) {
    final shares = preview;
    final items = widget.state.totals.lines;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Text('Ways', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(width: 10),
          Expanded(
            child: Wrap(spacing: 8, runSpacing: 8, children: [
              for (final ways in const [2, 3, 4, 5, 6, 8, 10])
                ChoiceChip(
                  label: Text('$ways'),
                  selected: _ways == ways,
                  onSelected: _locked ? null : (_) => setState(() => _ways = ways),
                ),
            ]),
          ),
          Text('${_money(widget.state.outstandingMinor)} between $_ways',
              style: TextStyle(color: scheme.onSurfaceVariant)),
        ]),
        const SizedBox(height: 12),
        Wrap(spacing: 12, runSpacing: 12, children: [
          for (var i = 0; i < shares.length; i++)
            _EqualCard(
              title: _labelOf(i, _equalNames),
              ways: _ways,
              index: i,
              items: items,
              totalMinor: shares[i].amountMinor,
              onRename: widget.options.names ? () => _rename(i, _equalNames) : null,
              onPrint: widget.onPrintShare == null ? null : () => _printEqualShare(i),
              onPay: () => _payShare(i),
            ),
        ]),
      ]),
    );
  }

  /// Split by amount: "this one pays £20", the rest left for the others.
  Widget _byAmount(ColorScheme scheme) {
    final shares = preview;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(
            child: Text('Add an amount for each person who pays a set sum. What is left is the last share.',
                style: TextStyle(color: scheme.onSurfaceVariant)),
          ),
          FilledButton.icon(
            onPressed: _locked ? null : _askAmount,
            icon: const Icon(Icons.add),
            label: const Text('Add an amount'),
          ),
        ]),
        const SizedBox(height: 12),
        if (shares.isEmpty)
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(border: Border.all(color: scheme.outlineVariant), borderRadius: BorderRadius.circular(10)),
            child: Text('${_money(widget.state.outstandingMinor)} to share out. Add the first amount.',
                textAlign: TextAlign.center, style: TextStyle(color: scheme.onSurfaceVariant)),
          )
        else
          Wrap(spacing: 12, runSpacing: 12, children: [
            for (var i = 0; i < shares.length; i++)
              _AmountCard(
                title: _labelOf(i, _amountNames),
                totalMinor: shares[i].amountMinor,
                rest: i == shares.length - 1 && i >= _amounts.length,
                onRename: widget.options.names ? () => _rename(i, _amountNames) : null,
                onRemove: _locked || i >= _amounts.length ? null : () => setState(() => _amounts.removeAt(i)),
                onPrint: widget.onPrintShare == null ? null : () => _printAmountShare(i),
                onPay: () => _payShare(i),
              ),
          ]),
      ]),
    );
  }

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
              segments: [
                const ButtonSegment(
                  value: SplitMethod.items,
                  icon: Icon(Icons.checklist),
                  label: Text('By item'),
                ),
                const ButtonSegment(
                  value: SplitMethod.equally,
                  icon: Icon(Icons.pie_chart_outline),
                  label: Text('Equally'),
                ),
                if (widget.options.byAmount)
                  const ButtonSegment(
                    value: SplitMethod.amount,
                    icon: Icon(Icons.payments_outlined),
                    label: Text('By amount'),
                  ),
              ],
              selected: {_method},
              onSelectionChanged: _locked ? null : (s) => setState(() => _method = s.first),
            ),
            if (_method != SplitMethod.equally && (_shares.isNotEmpty || _amounts.isNotEmpty) && !_locked)
              TextButton.icon(
                onPressed: _undo,
                icon: const Icon(Icons.undo),
                label: const Text('Undo split'),
              ),
            if (widget.options.printAll && widget.onPrintShare != null && preview.length >= 2)
              OutlinedButton.icon(
                onPressed: _printAll,
                icon: const Icon(Icons.print_outlined),
                label: Text('Print all ${preview.length}'),
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
    this.title,
    this.onRename,
    this.onRemoveLine,
    this.onAddPicked,
    this.pickedCount = 0,
    this.onPrint,
    this.onPay,
    this.onPayAndKeep,
  });

  final int index;
  final String? title;
  final VoidCallback? onRename;

  /// Newbridge's minus on an item: back to the pool. Null once anything is paid.
  final void Function(String lineId)? onRemoveLine;

  /// Newbridge's plus: the picked pool items onto this share.
  final VoidCallback? onAddPicked;
  final int pickedCount;
  final List<PricedLine> lines;
  final int totalMinor;
  final VoidCallback? onReturn;
  final VoidCallback? onPayAndKeep;
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
                    child: InkWell(
                      onTap: onRename,
                      borderRadius: BorderRadius.circular(6),
                      child: Row(children: [
                        Flexible(
                          child: Text(
                            title ?? 'Share ${index + 1}',
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                          ),
                        ),
                        if (onRename != null) ...[
                          const SizedBox(width: 6),
                          Icon(Icons.edit_outlined, size: 16, color: scheme.onSurfaceVariant),
                        ],
                      ]),
                    ),
                  ),
                  if (onAddPicked != null)
                    IconButton(
                      onPressed: onAddPicked,
                      visualDensity: VisualDensity.compact,
                      iconSize: 22,
                      tooltip: 'Add the $pickedCount picked here',
                      icon: Icon(Icons.add_circle, color: scheme.primary),
                    ),
                  if (onReturn != null)
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
                          if (line.parentLineId == null && onRemoveLine != null)
                            InkWell(
                              onTap: () => onRemoveLine!(line.id),
                              customBorder: const CircleBorder(),
                              child: Padding(
                                padding: const EdgeInsets.only(left: 6),
                                child: Icon(Icons.remove_circle_outline, size: 20, color: scheme.error),
                              ),
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
            if (onPayAndKeep != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                child: OutlinedButton.icon(
                  onPressed: onPayAndKeep,
                  icon: const Icon(Icons.table_restaurant_outlined, size: 18),
                  label: const Text('Pay these, rest stays on table'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// One person's equal share: [1/N] of every item, to the penny.
///
/// Each line's share is that line split N ways with the odd penny on the
/// first share (split_portions.dart portionValue), so the lines on a card add
/// up exactly; anything the bill carries beyond its lines (service, an offer)
/// shows as its own row, so the card always adds to what is charged.
class _EqualCard extends StatelessWidget {
  const _EqualCard({
    required this.title,
    required this.ways,
    required this.index,
    required this.items,
    required this.totalMinor,
    this.onRename,
    this.onPrint,
    this.onPay,
  });

  final String title;
  final int ways;
  final int index;
  final List<PricedLine> items;
  final int totalMinor;
  final VoidCallback? onRename;
  final VoidCallback? onPrint;
  final VoidCallback? onPay;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final rows = [
      for (final l in items)
        if (l.parentLineId == null) (l, portionValue(l.netMinor, ways, index + 1)),
    ];
    final modifiers = <String, int>{
      for (final l in items)
        if (l.parentLineId != null) l.id: portionValue(l.netMinor, ways, index + 1),
    };
    final linesSum = rows.fold<int>(0, (s, r) => s + r.$2) + modifiers.values.fold<int>(0, (s, v) => s + v);
    final other = totalMinor - linesSum;
    return SizedBox(
      width: 280,
      child: Card(
        margin: EdgeInsets.zero,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            dense: true,
            title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            trailing: onRename == null ? null : Icon(Icons.edit_outlined, size: 18, color: scheme.onSurfaceVariant),
            onTap: onRename,
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final (line, value) in rows)
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Row(children: [
                    Text('[1/$ways] ', style: TextStyle(color: scheme.primary, fontWeight: FontWeight.w700, fontSize: 12.5)),
                    Expanded(child: Text(line.name, style: const TextStyle(fontSize: 14))),
                    Text(_money(value + [
                      for (final m in items)
                        if (m.parentLineId == line.id) modifiers[m.id] ?? 0,
                    ].fold<int>(0, (s, v) => s + v)), style: const TextStyle(fontSize: 14)),
                  ]),
                ),
              if (other != 0)
                Row(children: [
                  Expanded(child: Text(other < 0 ? 'Offers' : 'Service and extras', style: TextStyle(color: scheme.onSurfaceVariant))),
                  Text(_money(other), style: TextStyle(color: scheme.onSurfaceVariant)),
                ]),
            ]),
          ),
          Container(
            color: scheme.surfaceContainerHighest,
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
            child: Row(children: [
              const Expanded(child: Text('Total')),
              Text(_money(totalMinor), style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
            child: Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: onPrint, icon: const Icon(Icons.print, size: 18), label: const Text('Bill'))),
              const SizedBox(width: 8),
              Expanded(child: FilledButton.icon(onPressed: onPay, icon: const Icon(Icons.payments_outlined, size: 18), label: const Text('Pay now'))),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// One person's set amount, or the rest of the bill.
class _AmountCard extends StatelessWidget {
  const _AmountCard({
    required this.title,
    required this.totalMinor,
    required this.rest,
    this.onRename,
    this.onRemove,
    this.onPrint,
    this.onPay,
  });

  final String title;
  final int totalMinor;
  final bool rest;
  final VoidCallback? onRename;
  final VoidCallback? onRemove;
  final VoidCallback? onPrint;
  final VoidCallback? onPay;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      width: 240,
      child: Card(
        margin: EdgeInsets.zero,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            dense: true,
            title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            subtitle: Text(rest ? 'The rest of the bill' : 'A set amount'),
            onTap: onRename,
            trailing: onRemove == null
                ? null
                : IconButton(icon: Icon(Icons.remove_circle_outline, color: scheme.error), tooltip: 'Take this off', onPressed: onRemove),
          ),
          Container(
            color: scheme.surfaceContainerHighest,
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            child: Row(children: [
              const Expanded(child: Text('Pays')),
              Text(_money(totalMinor), style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
            child: Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: onPrint, icon: const Icon(Icons.print, size: 18), label: const Text('Bill'))),
              const SizedBox(width: 8),
              Expanded(child: FilledButton.icon(onPressed: onPay, icon: const Icon(Icons.payments_outlined, size: 18), label: const Text('Pay now'))),
            ]),
          ),
        ]),
      ),
    );
  }
}
