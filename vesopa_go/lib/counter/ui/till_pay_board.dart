/// The till's payment page (vesopa_epos lib/ui/payment_page.dart), as the owner
/// asked on 2026-10-28: what is left to pay and what has been taken at the
/// top; Cash and Card as the two big tender keys; Manual card and Split bill;
/// the venue's own banknote pictures (tap a note to take it); the other
/// tenders and tools as a grid; and the number pad with Exact and the next
/// note up on the right. A "Check" tab shows the bill as it will print.
///
/// On a phone the same keys stack in one column, the pad last.
library;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../config/constants.dart' show apiBase;
import '../../data/models.dart';
import '../../ui/fit_text.dart';
import '../../ui/theme.dart';

/// A banknote key from the back office (Settings, Cash denominations).
class CashNote {
  const CashNote({required this.valueMinor, required this.label, this.imageUrl});
  final int valueMinor;
  final String label;
  final String? imageUrl;

  static List<CashNote> listFrom(Object? j) => [
        for (final n in (j is List ? j : const []))
          if (n is Map && (n['value_minor'] as num?) != null)
            CashNote(valueMinor: (n['value_minor'] as num).toInt(), label: '${n['label'] ?? ''}', imageUrl: n['image_url'] as String?),
      ];
}

/// What the board does; the page owns the money (pay_page.dart).
class PayActions {
  const PayActions({
    required this.cash,
    required this.card,
    required this.manualCard,
    required this.split,
    required this.voucher,
    required this.discount,
    required this.customer,
    required this.gratuity,
    required this.printBill,
    this.points,
    this.cardLabel = 'Card',
    this.otherCard,
    this.otherCardLabel,
  });

  final void Function(int tenderedMinor) cash;
  final void Function(int amountMinor) card;
  final void Function(int amountMinor) manualCard;
  /// Asks how many ways; answers each share, which the pad then holds.
  final Future<int?> Function() split;
  final VoidCallback voucher;
  final VoidCallback discount;
  final VoidCallback customer;
  final VoidCallback gratuity;
  final VoidCallback printBill;
  final VoidCallback? points;
  final String cardLabel;

  /// The other way to take a card (the machine, or Tap to Pay), if any.
  final void Function(int amountMinor)? otherCard;
  final String? otherCardLabel;
}

class TillPayBoard extends StatefulWidget {
  const TillPayBoard({
    super.key,
    required this.bill,
    required this.notes,
    required this.actions,
    required this.allowCash,
    this.problem,
    this.tipMinor = 0,
  });

  final Bill bill;
  final List<CashNote> notes;
  final PayActions actions;
  final bool allowCash;
  final String? problem;

  /// A gratuity chosen with the Gratuity key, added to the next card.
  final int tipMinor;

  @override
  State<TillPayBoard> createState() => _TillPayBoardState();
}

class _TillPayBoardState extends State<TillPayBoard> {
  /// What has been typed on the pad, in pence; 0 is nothing (then the keys
  /// take what is left to pay).
  int _entered = 0;

  int get _due => widget.bill.dueMinor;
  int get _amount => _entered > 0 ? _entered : _due;

  void _digit(String d) => setState(() {
        if (d == '.') return;
        final next = _entered * 10 + int.parse(d);
        if (next <= 9999999) _entered = next;
      });

  void _clear() => setState(() => _entered = 0);

  /// The smallest note that covers what is left, for the quick key beside Exact.
  int? get _nextNote {
    final values = [for (final n in widget.notes) n.valueMinor]..sort();
    for (final v in values) {
      if (v >= _due) return v;
    }
    return null;
  }

  void _then(void Function() f) {
    f();
    setState(() => _entered = 0);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final bill = widget.bill;
    final a = widget.actions;
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final taken = [for (final x in bill.tenders) '${x.kind == 'cash' ? 'Cash' : 'Card'} ${money(x.amountMinor)}'];

    final amountCard = Container(
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 14),
      decoration: BoxDecoration(color: context.goCard, borderRadius: BorderRadius.circular(16), border: Border.all(color: context.goLine)),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(bill.paidMinor > 0 ? 'LEFT TO PAY' : 'TO PAY', style: t.labelSmall?.copyWith(letterSpacing: 0.8, color: context.goMuted)),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(money(_due), style: TextStyle(fontSize: wide ? 64 : 48, fontWeight: FontWeight.w900, color: context.goDark ? Tp.lime : Tp.limeDeep, fontFeatures: Tp.tabular)),
            ),
          ]),
        ),
        Container(width: 1, height: 64, color: context.goLine, margin: const EdgeInsets.symmetric(horizontal: 16)),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('TAKEN', style: t.labelSmall?.copyWith(letterSpacing: 0.8, color: context.goMuted)),
            const SizedBox(height: 4),
            if (taken.isEmpty) Text('Nothing taken yet', style: t.bodyMedium?.copyWith(color: context.goMuted)) else for (final x in taken) Text(x, style: t.bodyMedium),
            if (widget.tipMinor > 0) Text('Gratuity ${money(widget.tipMinor)} on the card', style: t.bodySmall?.copyWith(color: Tp.lime)),
          ]),
        ),
      ]),
    );

    final tenders = Row(children: [
      if (widget.allowCash) ...[
        Expanded(child: _TenderKey(key: const ValueKey('pay-cash'), label: 'Cash', colour: const Color(0xFF0E4A4F), ink: Colors.white, onTap: () => _then(() => a.cash(_amount)))),
        const SizedBox(width: 12),
      ],
      Expanded(child: _TenderKey(key: const ValueKey('pay-card'), label: a.cardLabel, colour: Tp.lime, ink: Tp.onLime, onTap: () => _then(() => a.card(_amount.clamp(1, _due))))),
    ]);

    final row2 = Row(children: [
      Expanded(child: _ToolKey(label: 'Manual card', onTap: () => _then(() => a.manualCard(_amount.clamp(1, _due))))),
      const SizedBox(width: 10),
      if (a.otherCard != null) ...[
        Expanded(child: _ToolKey(label: a.otherCardLabel ?? 'Other card', onTap: () => _then(() => a.otherCard!(_amount.clamp(1, _due))))),
        const SizedBox(width: 10),
      ],
      Expanded(
        child: _ToolKey(
          label: 'Split bill',
          onTap: () async {
            final share = await a.split();
            if (share != null && mounted) setState(() => _entered = share);
          },
        ),
      ),
    ]);

    final notes = widget.allowCash && widget.notes.isNotEmpty
        ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('CASH — TAP A NOTE TO TAKE IT', style: t.labelMedium?.copyWith(letterSpacing: 1.2, color: context.goMuted, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Row(children: [
              for (final n in widget.notes)
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    child: _NoteKey(note: n, onTap: () => _then(() => a.cash(n.valueMinor))),
                  ),
                ),
            ]),
          ])
        : const SizedBox.shrink();

    final grid = [
      ('Voucher', a.voucher),
      if (a.points != null) ('Points', a.points!),
      ('Discount', a.discount),
      ('Customer', a.customer),
      ('Gratuity', a.gratuity),
      ('Print bill', a.printBill),
    ];
    final tools = LayoutBuilder(builder: (context, box) {
      // One row on an iPad when they fit, three to a row on a phone.
      final cols = wide ? (grid.length <= 5 ? grid.length : 4) : 3;
      final w = (box.maxWidth - 10 * (cols - 1)) / cols;
      return Wrap(spacing: 10, runSpacing: 10, children: [
        for (final (label, onTap) in grid) SizedBox(width: w, height: 64, child: _ToolKey(label: label, onTap: onTap)),
      ]);
    });

    final pad = _Pad(
      entered: _entered,
      due: _due,
      nextNote: _nextNote,
      onDigit: _digit,
      onClear: _clear,
      onExact: () => setState(() => _entered = _due),
      onNote: (v) => setState(() => _entered = v),
    );

    final problem = widget.problem == null
        ? const SizedBox.shrink()
        : Padding(padding: const EdgeInsets.only(top: 8), child: Text(widget.problem!, style: t.bodyMedium?.copyWith(color: Tp.danger)));

    if (!wide) {
      return ListView(padding: const EdgeInsets.all(14), children: [
        amountCard,
        problem,
        const SizedBox(height: 12),
        SizedBox(height: 110, child: tenders),
        const SizedBox(height: 10),
        SizedBox(height: 56, child: row2),
        const SizedBox(height: 14),
        notes,
        const SizedBox(height: 14),
        tools,
        const SizedBox(height: 14),
        SizedBox(height: 420, child: pad),
      ]);
    }
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          flex: 2,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            amountCard,
            problem,
            const SizedBox(height: 14),
            Expanded(flex: 5, child: tenders),
            const SizedBox(height: 12),
            SizedBox(height: 60, child: row2),
            const SizedBox(height: 16),
            notes,
            const Spacer(),
            tools,
          ]),
        ),
        const SizedBox(width: 18),
        Expanded(child: pad),
      ]),
    );
  }
}

class _TenderKey extends StatelessWidget {
  const _TenderKey({super.key, required this.label, required this.colour, required this.ink, required this.onTap});
  final String label;
  final Color colour;
  final Color ink;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: colour,
        borderRadius: BorderRadius.circular(18),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('TENDER', style: TextStyle(fontSize: 12, letterSpacing: 1.6, color: ink.withValues(alpha: 0.7), fontWeight: FontWeight.w600)),
              Expanded(
                child: Align(
                  alignment: Alignment.bottomLeft,
                  child: FitText(label, maxLines: 1, style: TextStyle(fontSize: 40, height: 1.1, fontWeight: FontWeight.w900, color: ink)),
                ),
              ),
            ]),
          ),
        ),
      );
}

class _ToolKey extends StatelessWidget {
  const _ToolKey({required this.label, required this.onTap});
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: context.goCard,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: DecoratedBox(
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: context.goLine)),
            child: Center(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: FitText(label, maxLines: 2, minSize: 12, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16, height: 1.1, fontWeight: FontWeight.w600)),
              ),
            ),
          ),
        ),
      );
}

class _NoteKey extends StatelessWidget {
  const _NoteKey({required this.note, required this.onTap});
  final CashNote note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final url = note.imageUrl;
    final full = url == null || url.isEmpty ? null : (url.startsWith('http') ? url : '$apiBase${url.startsWith('/') ? '' : '/'}$url');
    return AspectRatio(
      aspectRatio: 1.9,
      child: Material(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey('cash-${note.valueMinor}'),
          onTap: onTap,
          child: full == null
              ? Center(child: Text(note.label, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w900, color: Tp.ink)))
              : CachedNetworkImage(
                  imageUrl: full,
                  fit: BoxFit.cover,
                  errorWidget: (_, _, _) => Center(child: Text(note.label, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w900, color: Tp.ink))),
                ),
        ),
      ),
    );
  }
}

/// The till's number pad: the typed amount, Exact and the next note up, the
/// digits, and CL.
class _Pad extends StatelessWidget {
  const _Pad({
    required this.entered,
    required this.due,
    required this.nextNote,
    required this.onDigit,
    required this.onClear,
    required this.onExact,
    required this.onNote,
  });

  final int entered;
  final int due;
  final int? nextNote;
  final ValueChanged<String> onDigit;
  final VoidCallback onClear;
  final VoidCallback onExact;
  final ValueChanged<int> onNote;

  @override
  Widget build(BuildContext context) {
    Widget key(String label, {VoidCallback? onTap, Color? colour, Color? ink}) => Expanded(
          child: Padding(
            padding: const EdgeInsets.all(5),
            child: Material(
              color: colour ?? context.goCard,
              borderRadius: BorderRadius.circular(14),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: onTap ?? () => onDigit(label),
                child: Center(child: Text(label, style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800, color: ink))),
              ),
            ),
          ),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        height: 84,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        alignment: Alignment.centerRight,
        decoration: BoxDecoration(color: context.goCard, borderRadius: BorderRadius.circular(16), border: Border.all(color: context.goLine)),
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(money(entered > 0 ? entered : due),
              style: TextStyle(fontSize: 48, fontWeight: FontWeight.w900, fontFeatures: Tp.tabular, color: entered > 0 ? context.goText : context.goMuted)),
        ),
      ),
      const SizedBox(height: 10),
      SizedBox(
        height: 56,
        child: Row(children: [
          key('Exact', onTap: onExact, colour: Tp.lime.withValues(alpha: 0.16), ink: context.goDark ? Tp.lime : Tp.limeDeep),
          if (nextNote != null) key(money(nextNote!), onTap: () => onNote(nextNote!), colour: Tp.lime.withValues(alpha: 0.16), ink: context.goDark ? Tp.lime : Tp.limeDeep),
        ]),
      ),
      const SizedBox(height: 6),
      for (final row in const [
        ['7', '8', '9'],
        ['4', '5', '6'],
        ['1', '2', '3'],
      ])
        Expanded(child: Row(children: [for (final d in row) key(d)])),
      Expanded(
        child: Row(children: [
          key('00', onTap: () {
            onDigit('0');
            onDigit('0');
          }),
          key('0'),
          key('CL', onTap: onClear, colour: Tp.danger.withValues(alpha: 0.18), ink: Tp.danger),
        ]),
      ),
    ]);
  }
}
