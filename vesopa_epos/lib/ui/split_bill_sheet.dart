/// Deciding how a bill gets divided.
///
/// This replaced a 440px `AlertDialog` whose "By item" tab was a column of
/// `ListTile`s, each carrying a row of numbered chips. It worked, and nobody
/// used it, for three reasons that are worth writing down because they are the
/// whole brief for this file:
///
///   1. **It opened on "Equally".** Itemised is how people actually split a
///      bill; it was behind the second tab.
///   2. **It never showed what a share came to.** The clerk assigned twenty
///      items to shares and pressed Split to find out. The one number the
///      decision turns on was the one number missing.
///   3. **There was no way to split by round**, which is the case a table
///      generates on its own: two people served an hour apart, two customers,
///      one bill. See `data/bill_rounds.dart`.
///
/// So: rounds first when the bill has them, itemised otherwise, equal shares
/// last — and every share's total live at the foot of the screen, computed by
/// running the real `TenderState.splitByItems` rather than by adding the lines
/// up again here. What is previewed is what is charged, including the offer,
/// because it is the same code.
library;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/bill_rounds.dart';
import '../data/modifier_layout.dart';
import '../data/pricing_engine.dart';
import '../data/tender_engine.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);

/// How the clerk decided to split.
class SplitChoice {
  const SplitChoice({required this.mode, this.ways = 0, this.groups});

  final SplitMode mode;
  final int ways;
  final List<List<String>>? groups;
}

/// Which way of dividing the bill is on screen.
enum SplitMethod { round, item, equally }

/// Choose how to split a bill.
Future<SplitChoice?> showSplitDialog(
  BuildContext context, {
  required TenderState state,
}) =>
    showDialog<SplitChoice>(
      context: context,
      builder: (_) => SplitBillSheet(state: state),
    );

/// The screen itself. Public so a widget test can drive it directly.
class SplitBillSheet extends StatefulWidget {
  const SplitBillSheet({super.key, required this.state});

  final TenderState state;

  @override
  State<SplitBillSheet> createState() => SplitBillSheetState();
}

class SplitBillSheetState extends State<SplitBillSheet> {
  late final List<PricedLine> _lines;
  late final List<BillRound> _rounds;
  late SplitMethod _method;

  int _ways = 2;

  /// Which share each line has been put on. Anything unassigned is share 0.
  final Map<String, int> _assignment = {};

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
    _rounds = roundsOf(_lines);

    // Rounds when the bill has them, because a table two people served is
    // already divided and the till should say so rather than make the clerk
    // rebuild it item by item. Itemised otherwise — the venue's default, and
    // the reason "Equally" is no longer the tab this opens on.
    _method = hasRounds(_rounds) ? SplitMethod.round : SplitMethod.item;

    if (hasRounds(_rounds)) {
      // Each round on its own share, which is the answer in the case this was
      // built for: two rounds, two customers, and the clerk presses Split.
      _ways = _rounds.length.clamp(2, 6);
      for (var i = 0; i < _rounds.length; i++) {
        final share = i.clamp(0, _ways - 1);
        for (final id in _rounds[i].lineIds) {
          _assignment[id] = share;
        }
      }
    }
  }

  /// The line ids on each share, with empty shares dropped.
  ///
  /// Empty shares are dropped rather than passed through as £0, which the old
  /// dialog did: choosing four ways and assigning items to two left the clerk
  /// pressing past two shares worth nothing. It also gives "put everything on
  /// one share" a sensible meaning — one group is not a split, so the bill is
  /// simply paid whole, which is how "select both to pay" is expressed.
  List<List<String>> get groups {
    final byShare = List.generate(_ways, (_) => <String>[]);
    for (final line in _lines) {
      final share = (_assignment[line.id] ?? 0).clamp(0, _ways - 1);
      byShare[share].add(line.id);
    }
    return [
      for (final group in byShare)
        if (group.isNotEmpty) group,
    ];
  }

  /// What each share comes to, offer included.
  ///
  /// Run through the engine rather than summed here, so the preview cannot
  /// drift from the charge. This is also what makes the pro-rata visible: a
  /// share is quoted net of its portion of a bill-wide discount, which is the
  /// number the customer is about to be asked for.
  List<SplitShare> get preview {
    if (_method == SplitMethod.equally) {
      return widget.state.splitEqually(_ways).shares;
    }
    final picked = groups;
    if (picked.length < 2) return const [];
    return widget.state.splitByItems(picked).shares;
  }

  /// Move a whole round onto a share.
  void assignRound(BillRound round, int share) {
    setState(() {
      for (final id in lineIdsOfRounds([round], _lines)) {
        _assignment[id] = share;
      }
    });
  }

  /// Move one line onto a share, taking its modifiers with it.
  void assignLine(PricedLine line, int share) {
    setState(() {
      final ids = withModifiersOf(
        {line.id},
        _lines,
        idOf: (l) => l.id,
        parentOf: (l) => l.parentLineId,
      );
      for (final id in ids) {
        _assignment[id] = share;
      }
    });
  }

  void _confirm() {
    if (_method == SplitMethod.equally) {
      Navigator.pop(context, SplitChoice(mode: SplitMode.equally, ways: _ways));
      return;
    }
    final picked = groups;
    // Everything on one share is not a split — it is the bill, paid whole.
    if (picked.length < 2) {
      Navigator.pop(context, const SplitChoice(mode: SplitMode.none));
      return;
    }
    Navigator.pop(
      context,
      SplitChoice(mode: SplitMode.byItem, groups: picked),
    );
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    final scheme = Theme.of(context).colorScheme;
    final wide = screen.width * 0.94;

    return Dialog(
      insetPadding: const EdgeInsets.all(20),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: wide < 940 ? wide : 940,
          maxHeight: screen.height * 0.92,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _title(scheme),
            _methods(),
            Flexible(
              child: switch (_method) {
                SplitMethod.round => _roundList(),
                SplitMethod.item => _itemList(),
                SplitMethod.equally => _equally(),
              },
            ),
            _shareTotals(scheme),
            _actions(),
          ],
        ),
      ),
    );
  }

  Widget _title(ColorScheme scheme) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
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
          ],
        ),
      );

  Widget _methods() => Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
        child: SegmentedButton<SplitMethod>(
          segments: [
            // Only offered when the bill actually has rounds — on a counter
            // sale it would be a tab showing one card.
            if (hasRounds(_rounds))
              const ButtonSegment(
                value: SplitMethod.round,
                icon: Icon(Icons.groups_outlined),
                label: Text('By round'),
              ),
            const ButtonSegment(
              value: SplitMethod.item,
              icon: Icon(Icons.checklist),
              label: Text('By item'),
            ),
            const ButtonSegment(
              value: SplitMethod.equally,
              icon: Icon(Icons.pie_chart_outline),
              label: Text('Equally'),
            ),
          ],
          selected: {_method},
          onSelectionChanged: (s) => setState(() => _method = s.first),
        ),
      );

  // ---------------------------------------------------------------------
  // By round
  // ---------------------------------------------------------------------

  Widget _roundList() => ListView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
        shrinkWrap: true,
        children: [
          for (final round in _rounds)
            _RoundCard(
              round: round,
              ways: _ways,
              share: _shareOf(round),
              onAssign: (share) => assignRound(round, share),
            ),
          const SizedBox(height: 8),
          _waysRow('Shares'),
        ],
      );

  /// Which share a round is on, or null when its lines have been split up
  /// between shares by hand on the By item tab.
  int? _shareOf(BillRound round) {
    int? found;
    for (final id in round.lineIds) {
      final share = _assignment[id] ?? 0;
      if (found == null) {
        found = share;
      } else if (found != share) {
        return null;
      }
    }
    return found;
  }

  // ---------------------------------------------------------------------
  // By item
  // ---------------------------------------------------------------------

  Widget _itemList() => ListView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
        shrinkWrap: true,
        children: [
          for (final line in _lines)
            // A modifier moves with the item above it, so it is shown as
            // belonging to that item rather than offered as its own choice.
            if (line.parentLineId == null)
              _ItemRow(
                line: line,
                modifiers: [
                  for (final m in _lines)
                    if (m.parentLineId == line.id) m,
                ],
                ways: _ways,
                share: (_assignment[line.id] ?? 0).clamp(0, _ways - 1),
                onAssign: (share) => assignLine(line, share),
              ),
          const SizedBox(height: 8),
          _waysRow('Shares'),
        ],
      );

  // ---------------------------------------------------------------------
  // Equally
  // ---------------------------------------------------------------------

  Widget _equally() => ListView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
        shrinkWrap: true,
        children: [
          Text(
            '${_money(widget.state.outstandingMinor)} between $_ways',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 10),
          _waysRow('Ways'),
        ],
      );

  Widget _waysRow(String label) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Text(label),
            const SizedBox(width: 10),
            Expanded(
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final ways in const [2, 3, 4, 5, 6])
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
      );

  // ---------------------------------------------------------------------
  // What each share comes to
  // ---------------------------------------------------------------------

  Widget _shareTotals(ColorScheme scheme) {
    final shares = preview;

    if (shares.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
        color: scheme.surfaceContainerHighest,
        child: Text(
          'Everything is on one share — the bill will be paid in full.',
          style: TextStyle(color: scheme.onSurfaceVariant),
        ),
      );
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
      color: scheme.surfaceContainerHighest,
      child: Wrap(
        spacing: 18,
        runSpacing: 8,
        children: [
          for (final share in shares)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Share ${share.index + 1}',
                  style: TextStyle(
                    fontSize: 12,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
                Text(
                  _money(share.amountMinor),
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _actions() => Padding(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 14),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            const SizedBox(width: 10),
            FilledButton(onPressed: _confirm, child: const Text('Split')),
          ],
        ),
      );
}

/// One round, and which share it is on.
class _RoundCard extends StatelessWidget {
  const _RoundCard({
    required this.round,
    required this.ways,
    required this.share,
    required this.onAssign,
  });

  final BillRound round;
  final int ways;

  /// Null when the round's lines have been split between shares by hand.
  final int? share;
  final void Function(int share) onAssign;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    round.label ?? 'Unattributed',
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 16,
                    ),
                  ),
                ),
                Text(
                  _money(round.subtotalMinor),
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 16,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              [
                for (final line in round.lines)
                  if (line.parentLineId == null)
                    line.quantity == 1
                        ? line.name
                        : '${_qty(line.quantity)} × ${line.name}',
              ].join(',  '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Text('Share', style: TextStyle(color: scheme.onSurfaceVariant)),
                const SizedBox(width: 10),
                Expanded(
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (var i = 0; i < ways; i++)
                        ChoiceChip(
                          label: Text('${i + 1}'),
                          selected: share == i,
                          onSelected: (_) => onAssign(i),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// One item, its modifiers, and which share it is on.
class _ItemRow extends StatelessWidget {
  const _ItemRow({
    required this.line,
    required this.modifiers,
    required this.ways,
    required this.share,
    required this.onAssign,
  });

  final PricedLine line;
  final List<PricedLine> modifiers;
  final int ways;
  final int share;
  final void Function(int share) onAssign;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    // A modifier is paid for by whoever pays for the item, so its money is
    // shown against the item rather than on a row that cannot be moved.
    final total = modifiers.fold<int>(line.netMinor, (s, m) => s + m.netMinor);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  line.quantity == 1
                      ? line.name
                      : '${_qty(line.quantity)} × ${line.name}',
                  style: const TextStyle(fontSize: 15),
                ),
                if (modifiers.isNotEmpty)
                  Text(
                    modifiers.map((m) => m.name).join(',  '),
                    style: TextStyle(
                      fontSize: 12,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(_money(total), style: const TextStyle(fontSize: 15)),
          const SizedBox(width: 14),
          Wrap(
            spacing: 5,
            children: [
              for (var i = 0; i < ways; i++)
                ChoiceChip(
                  label: Text('${i + 1}'),
                  selected: share == i,
                  onSelected: (_) => onAssign(i),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
