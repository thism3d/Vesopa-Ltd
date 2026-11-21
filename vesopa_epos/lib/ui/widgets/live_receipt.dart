import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/bill_rounds.dart';
import '../../data/branding.dart';
import '../../data/modifier_layout.dart';
import '../../data/pricing_engine.dart';
import '../../data/tender_engine.dart';
import '../theme.dart';
import 'customer_card.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);

/// The bill, drawn as the receipt it will become.
///
/// Shown on both the sale screen and the payment screen, deliberately
/// identical: what the clerk approves is what prints, and a customer leaning
/// over the counter can read their own bill as it is rung up. Press £10 four
/// times and four lines appear here, with the running total underneath.
///
/// This is a *live* view of an unsettled bill, so it shows things a printed
/// receipt cannot — what is still to pay, which share of a split is being
/// taken, and which offers have been applied.
class LiveReceipt extends StatelessWidget {
  const LiveReceipt({
    super.key,
    required this.totals,
    this.branding = const Branding(),
    this.tender,
    this.customer,
    this.onChangeCustomer,
    this.onRemoveCustomer,
    this.tableNumber,
    this.covers,
    this.clerkName,
    this.onTapLine,
    this.selectedLineIds = const {},
    // Off by default now. The venue name and address are the top of a printed
    // receipt, not of the check a clerk is ringing into: the person holding the
    // till knows which venue they are standing in, and those two lines were
    // costing the item list about an eighth of its height. The printed receipt
    // and the PDF still carry them, which is where a customer needs them.
    this.showHeader = false,
    this.emptyMessage = 'No items yet',
    this.aboveTotals,
    this.onSelectLines,
  });

  final BasketTotals totals;
  final Branding branding;

  /// Payment progress, when the bill is being settled. Null on the sale
  /// screen, where nothing has been tendered yet.
  final TenderState? tender;

  /// Who the bill is for, drawn as a card above the items. Null on the
  /// ordinary walk-in sale, and then nothing is drawn at all.
  final BillCustomer? customer;

  /// Attach a different customer, and take the current one off.
  final VoidCallback? onChangeCustomer;
  final VoidCallback? onRemoveCustomer;

  final int? tableNumber;
  final int? covers;
  final String? clerkName;

  /// Picks a line out, or puts it back — tapping is symmetric.
  final void Function(PricedLine line)? onTapLine;

  /// Lines the clerk has picked out, by line id. A selected line is what Void
  /// acts on, so it has to be unmistakable at a glance on a busy counter —
  /// hence a filled band with a lime edge, not a faint tint. Nothing else
  /// changes on the row: no tick, no "1 × selected", no pencil (Nicky,
  /// 2026-11-18: "just highlight the item instead").
  final Set<String> selectedLineIds;

  final bool showHeader;
  final String emptyMessage;

  /// Slotted in directly above Subtotal. The sale screen puts the quantity
  /// stepper for a single picked line here, so the control sits with the money
  /// it is about to change rather than in a dialog somewhere else.
  final Widget? aboveTotals;

  /// Replaces the picked lines. Given, the bill draws ↓ ↑ and select all at
  /// the right of the totals, where the old till had them (Nicky,
  /// 2026-11-18): ↓ picks the next item, ↑ the one before, and select all
  /// picks every item, or puts them all back when they already are.
  final void Function(Set<String> ids)? onSelectLines;

  /// How many items should be readable at once without scrolling.
  ///
  /// The venue's number, from a 15-inch EPOS panel: fifteen items covers all but
  /// the largest table, and a clerk who has to scroll to see the bill they are
  /// reading out cannot check it against the table.
  static const _targetVisibleLines = 15;

  /// The type scale, sized from the room available rather than hardcoded.
  ///
  /// A fixed font size cannot satisfy "bigger text" and "fifteen items" at the
  /// same time on every panel — on 768px those two demands pull in opposite
  /// directions, and on a 1080p till a size chosen for 768px is needlessly small.
  /// So the row height is derived: divide the space by fifteen, and take the
  /// largest legible type that fits it.
  ///
  /// The clamp floor is the old 14pt, so this can only ever make the check
  /// *bigger* than it was, never smaller on a cramped screen — it would rather
  /// scroll at 14pt than shrink to 11pt to avoid scrolling.
  ///
  /// Width matters as much as height, and used not to be asked.
  ///
  /// Height alone answers "how many items fit". It says nothing about whether
  /// the item's *name* fits, and on a 768px-tall panel the height rule pins the
  /// type at the 22pt ceiling — which was survivable only because the box was a
  /// fixed 420px. Now that the check narrows on a square till
  /// (PosLayoutX.checkWidth), 22pt in a 287px box would truncate half the
  /// product names, which is exactly the regression the note on the sale
  /// screen's SizedBox warns about.
  ///
  /// So both demands are computed and the smaller wins. Nothing changes on a
  /// wide till: at 420px the width rule returns about 28pt, well over the
  /// ceiling, so height goes on deciding as it always did.
  static double _bodySizeFor(double listHeight, double listWidth) {
    // Vertical padding (3 top + 3 bottom) plus the line-height multiplier.
    const chromePerRow = 6.0;
    const lineHeight = 1.35;
    final fromHeight = (listHeight / _targetVisibleLines - chromePerRow) /
        lineHeight;

    // The row is a quantity, a name and a price. The quantity and the price are
    // near enough fixed — "12" and "£1,234.56" at the sizes in play — so they
    // are reserved as one number and the name gets the rest.
    const reservedForQtyAndPrice = 120.0;
    // Monospace advance is close enough to 0.6em across Menlo, Consolas and
    // Courier New for sizing a column of type.
    const advance = 0.6;
    // Sixteen characters of product name before it wraps. "Sticky Toffee
    // Pudding" wraps at any size worth reading, and that is fine — what is not
    // fine is "Chicken Wings" wrapping.
    const targetNameChars = 16;
    final fromWidth =
        (listWidth - reservedForQtyAndPrice) / (targetNameChars * advance);

    final size = fromHeight < fromWidth ? fromHeight : fromWidth;
    return size.clamp(14.0, 22.0);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    // The Ledger board's panel, so the bill reads as one of the three panels
    // resting on the sale screen's ground rather than as a lighter slab that
    // happened to land there. See PayPalette.
    final pal = PayPalette.of(context);

    return Container(
      decoration: BoxDecoration(
        color: pal.panel,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: pal.panelLine),
      ),
      clipBehavior: Clip.antiAlias,
      // The type scale needs to know how much room the list actually got, which
      // is only known after the header and the totals have taken their share —
      // hence measuring here rather than guessing from the screen size.
      child: LayoutBuilder(
        builder: (context, box) {
          // Monospace, because a receipt's columns have to line up and
          // proportional digits make a column of prices look ragged.
          //
          // The list gets what is left after the header and the totals block.
          // Those are measured as fractions rather than pixels because both grow
          // with the type inside them.
          final listHeight = box.maxHeight * (showHeader ? 0.62 : 0.74);
          final size = _bodySizeFor(listHeight, box.maxWidth);

          final rounds = _roundsOfBill();
          // Every round is headed with who rang it and when -- also when one
          // person rang the whole bill in several goes (Nicki: "--- NICKY
          // 12.07pm --- each time stuff were added"). The payment screen keeps
          // its own rule (hasRounds) for when headings are worth tapping.
          final showHeadings = rounds.any((r) => r.label != null);

          final body = theme.textTheme.bodyMedium?.copyWith(
            fontFamily: 'monospace',
            fontFamilyFallback: const ['Menlo', 'Consolas', 'Courier New'],
            height: 1.35,
            fontSize: size,
          );
          final small = body?.copyWith(
            // Kept proportional rather than a flat -2, so the secondary type
            // grows with the body instead of collapsing towards it.
            fontSize: size * 0.82,
            color: scheme.onSurfaceVariant,
          );

          return Column(
            children: [
              if (showHeader) _Header(branding: branding, small: small),

              Expanded(
                child: totals.lines.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // The basket that gently bobs, as on Vesopa Go
                            // (the owner, 2026-10-30: "like this in Windows").
                            _EmptyBasket(colour: scheme.onSurfaceVariant),
                            const SizedBox(height: 10),
                            Text(emptyMessage,
                                style: theme.textTheme.bodyMedium
                                    ?.copyWith(color: scheme.onSurfaceVariant)),
                          ],
                        ),
                      )
                    : ListView(
                        padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
                        children: [
                          _Context(
                            tableNumber: tableNumber,
                            covers: covers,
                            clerkName: clerkName,
                            style: small,
                          ),
                          if (customer != null) ...[
                            CustomerCard(
                              customer: customer!,
                              onChange: onChangeCustomer,
                              onRemove: onRemoveCustomer,
                            ),
                            const SizedBox(height: 8),
                          ],
                          const SizedBox(height: 4),
                          for (final entry in rounds) ...[
                            // A single-author bill — every walk-in sale — is
                            // one run with no heading, so the ordinary case
                            // looks exactly as it did. A heading appears only
                            // where there is something to tell apart: a table
                            // two people have served.
                            if (showHeadings && entry.label != null)
                              _StaffHeading(
                                label: entry.label!,
                                style: small,
                              ),
                            for (final line in entry.lines)
                              _LineRow(
                                line: line,
                                body: body,
                                small: small,
                                onTap: onTapLine,
                                selected: selectedLineIds.contains(line.id),
                              ),
                          ],
                        ],
                      ),
              ),

              ?aboveTotals,

              if (onSelectLines == null)
                _Totals(
                  totals: totals,
                  tender: tender,
                  body: body,
                  small: small,
                )
              else
                Container(
                  color: PayPalette.of(context).rowAlt,
                  child: IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(
                          child: _Totals(
                            totals: totals,
                            tender: tender,
                            body: body,
                            small: small,
                          ),
                        ),
                        Container(
                          decoration: BoxDecoration(
                            border: Border(
                              top: BorderSide(
                                color: PayPalette.of(context).panelLine,
                              ),
                            ),
                          ),
                          padding: const EdgeInsets.fromLTRB(0, 8, 8, 8),
                          alignment: Alignment.center,
                          child: _BillNav(
                            order: [
                              for (final r in _roundsOfBill())
                                for (final l in r.lines)
                                  if (l.parentLineId == null) l.id,
                            ],
                            selected: selectedLineIds,
                            onSelect: onSelectLines!,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  /// The bill, cut into the rounds it was rung in.
  ///
  /// The rule used to live here as a private `_blocks`, and moved to
  /// `data/bill_rounds.dart` when the payment screen needed to split a bill by
  /// round: a bill that groups one way on screen and another way when it is
  /// paid is worse than either. See that file for what counts as a round.
  List<BillRound> _roundsOfBill() => roundsOf(
        orderWithModifiers(
          totals.lines,
          idOf: (l) => l.id,
          parentOf: (l) => l.parentLineId,
        ),
      );
}

/// ↓ ↑ and select all, beside the totals.
class _BillNav extends StatelessWidget {
  const _BillNav({
    required this.order,
    required this.selected,
    required this.onSelect,
  });

  /// The items as they are drawn, top to bottom (an item's extras ride
  /// with it, so they are not stops of their own).
  final List<String> order;
  final Set<String> selected;
  final void Function(Set<String> ids) onSelect;

  void _step(int by) {
    if (order.isEmpty) return;
    final at = [
      for (var i = 0; i < order.length; i++)
        if (selected.contains(order[i])) i,
    ];
    final int next;
    if (at.isEmpty) {
      next = by > 0 ? 0 : order.length - 1;
    } else {
      next = (by > 0 ? at.last + 1 : at.first - 1).clamp(0, order.length - 1);
    }
    onSelect({order[next]});
  }

  @override
  Widget build(BuildContext context) {
    final all = order.isNotEmpty && order.every(selected.contains);
    final on = order.isNotEmpty;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _NavKey(
              icon: Icons.arrow_downward_rounded,
              tooltip: 'Next item',
              onTap: on ? () => _step(1) : null,
            ),
            const SizedBox(width: 6),
            _NavKey(
              icon: Icons.arrow_upward_rounded,
              tooltip: 'Previous item',
              onTap: on ? () => _step(-1) : null,
            ),
          ],
        ),
        const SizedBox(height: 6),
        _NavKey(
          icon: all ? Icons.remove_done_rounded : Icons.checklist_rounded,
          tooltip: all ? 'Select none' : 'Select all',
          wide: true,
          active: all,
          onTap: on ? () => onSelect(all ? <String>{} : order.toSet()) : null,
        ),
      ],
    );
  }
}

class _NavKey extends StatelessWidget {
  const _NavKey({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.wide = false,
    this.active = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool wide;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final on = onTap != null;
    return Tooltip(
      message: tooltip,
      child: Material(
        color: active
            ? scheme.primary
            : scheme.surfaceContainerHighest.withValues(alpha: on ? 1 : 0.5),
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: onTap,
          child: SizedBox(
            // Thumb-sized on a counter: 48 high, as the till's other keys.
            width: wide ? 102 : 48,
            height: 44,
            child: Icon(
              icon,
              size: 24,
              color: active
                  ? scheme.onPrimary
                  : on
                      ? scheme.onSurface
                      : scheme.onSurface.withValues(alpha: 0.35),
            ),
          ),
        ),
      ),
    );
  }
}

/// `Sam · 19:42` above the items that person put on the bill.
class _StaffHeading extends StatelessWidget {
  const _StaffHeading({required this.label, this.style});

  final String label;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 3),
      child: Row(
        children: [
          Text(
            label,
            style: style?.copyWith(
              fontWeight: FontWeight.w700,
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 8),
          // A rule out to the edge, so the heading reads as the start of a
          // section rather than as another item on the bill.
          Expanded(
            child: Divider(height: 1, color: scheme.outlineVariant),
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.branding, this.small});

  final Branding branding;
  final TextStyle? small;

  @override
  Widget build(BuildContext context) {
    final name = branding.venueName.isNotEmpty ? branding.venueName : 'VESOPA';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 14),
      // The board's own chip surface rather than a Material container. The
      // scheme is seeded from the brand lime, so its containers carry an olive
      // cast that reads as a tint against the neutral panels around it.
      color: PayPalette.of(context).chip,
      child: Column(
        children: [
          Text(
            name.toUpperCase(),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.1,
                ),
          ),
          if (branding.addressLines.isNotEmpty)
            Text(
              branding.addressLines.first,
              textAlign: TextAlign.center,
              style: small,
            ),
        ],
      ),
    );
  }
}

class _Context extends StatelessWidget {
  const _Context({
    this.tableNumber,
    this.covers,
    this.clerkName,
    this.style,
  });

  final int? tableNumber;
  final int? covers;
  final String? clerkName;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final bits = <String>[
      if (tableNumber != null) 'Table $tableNumber',
      if (covers != null && covers! > 0) '$covers covers',
      if (clerkName?.isNotEmpty ?? false) clerkName!,
      // No clock. It was rebuilt on every frame to say something the clerk can
      // read off the till's own bar, and it cost a line of the check to do it.
      // The time that matters — when each run of items was rung — is already on
      // the staff heading above them.
    ];

    // The customer used to be a bold line here. It is a card now — see
    // CustomerCard — because a name in the same type as "Table 4" was the only
    // sign that a discount had come off the bill.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(bits.join('  ·  '), style: style),
        const Divider(height: 12),
      ],
    );
  }
}

/// One item, with whatever needs explaining underneath it: the unit price on a
/// multiple, a kitchen note, and the offer that reduced it.
class _LineRow extends StatefulWidget {
  const _LineRow({
    required this.line,
    this.body,
    this.small,
    this.onTap,
    this.selected = false,
  });

  final PricedLine line;
  final TextStyle? body;
  final TextStyle? small;

  /// Picks the line out, or puts it back. Tapping is symmetric on purpose: a
  /// clerk who taps the wrong row fixes it by tapping it again, which is the
  /// only thing anyone tries.
  final void Function(PricedLine line)? onTap;

  final bool selected;

  @override
  State<_LineRow> createState() => _LineRowState();
}

class _LineRowState extends State<_LineRow> {
  @override
  void initState() {
    super.initState();
    if (widget.selected) _reveal();
  }

  @override
  void didUpdateWidget(_LineRow old) {
    super.didUpdateWidget(old);
    if (widget.selected && !old.selected) _reveal();
  }

  /// A line the ↓ ↑ keys picked may be below the fold: bring it into view,
  /// without moving a bill whose picked line is already on screen.
  void _reveal() {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted || Scrollable.maybeOf(context) == null) return;
      const d = Duration(milliseconds: 140);
      await Scrollable.ensureVisible(context,
          duration: d,
          alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd);
      if (!mounted) return;
      await Scrollable.ensureVisible(context,
          duration: d,
          alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtStart);
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final line = widget.line;
    final body = widget.body;
    final small = widget.small;
    final selected = widget.selected;
    final onTap = widget.onTap;

    return InkWell(
      onTap: onTap == null ? null : () => onTap(line),
      child: Container(
        // Selection is drawn as a filled band with a lime edge rather than a
        // tint: the clerk is about to void this line, and "which row is picked"
        // must survive a glance across a counter.
        decoration: selected
            ? BoxDecoration(
                color: scheme.primary.withValues(alpha: 0.20),
                borderRadius: BorderRadius.circular(5),
                border: Border(
                  left: BorderSide(color: scheme.primary, width: 3),
                ),
              )
            : null,
        // Padding is constant so the text does not shift as a row is picked
        // out, and the band simply appears around it.
        //
        // This used to be `padding: selected ? 5 : 0` cancelled by a matching
        // `margin: -5`, to make the band bleed past the content edge. Container
        // asserts `margin.isNonNegative`, so selecting any line threw in a
        // debug build — invisible in release, where assertions are stripped,
        // which is why it survived this long.
        padding: EdgeInsets.only(
          left: line.parentLineId == null ? 5 : 19,
          right: 5,
          top: 3,
          bottom: 3,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 28,
                  child: Text(
                    _qty(line.quantity),
                    style: selected
                        ? body?.copyWith(fontWeight: FontWeight.w700)
                        : body,
                  ),
                ),
                Expanded(
                  child: Text(
                    line.name,
                    style: selected
                        ? body?.copyWith(fontWeight: FontWeight.w700)
                        : body,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  _money(line.discounted ? line.netMinor : line.grossMinor),
                  style: body?.copyWith(fontWeight: FontWeight.w600),
                ),

              ],
            ),

            // Unit price, when it is not obvious from a single item.
            if (line.quantity != 1)
              Padding(
                padding: const EdgeInsets.only(left: 28),
                child: Text('@ ${_money(line.unitPriceMinor)} each',
                    style: small),
              ),

            // The kitchen note.
            if (line.note?.isNotEmpty ?? false)
              Padding(
                padding: const EdgeInsets.only(left: 28),
                child: Text(
                  '* ${line.note}',
                  style: small?.copyWith(fontStyle: FontStyle.italic),
                ),
              ),

            // The offer, and what it saved. Shown per line so a customer can
            // see why an item is cheaper than the menu says.
            if (line.discounted)
              Padding(
                padding: const EdgeInsets.only(left: 28, top: 1),
                child: Row(
                  children: [
                    Icon(Icons.local_offer,
                        size: 11, color: scheme.tertiary),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        line.promotionName ?? 'Offer',
                        style: small?.copyWith(
                          color: scheme.tertiary,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    Text(
                      '-${_money(line.discountMinor)}',
                      style: small?.copyWith(
                        color: scheme.tertiary,
                        fontWeight: FontWeight.w600,
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

/// The money block. Reductions only appear when they are non-zero, so a plain
/// cash sale is not padded with rows of zeroes.
class _Totals extends StatelessWidget {
  const _Totals({
    required this.totals,
    this.tender,
    this.body,
    this.small,
  });

  final BasketTotals totals;
  final TenderState? tender;
  final TextStyle? body;
  final TextStyle? small;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final t = totals;
    final showBreakdown = t.savedMinor > 0 || t.gratuityMinor > 0;

    Widget row(String label, int minor,
        {bool bold = false, Color? colour, TextStyle? style}) {
      final base = (style ?? body)?.copyWith(
        fontWeight: bold ? FontWeight.bold : null,
        color: colour,
      );
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 1.5),
        child: Row(
          children: [
            Expanded(child: Text(label, style: base)),
            Text(_money(minor), style: base),
          ],
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
      decoration: BoxDecoration(
        color: PayPalette.of(context).rowAlt,
        border: Border(
          top: BorderSide(color: PayPalette.of(context).panelLine),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (showBreakdown) ...[
            row('Subtotal', t.grossMinor, style: small),
            if (t.promoMinor > 0)
              row('Offers', -t.promoMinor,
                  colour: scheme.tertiary, style: small),
            if (t.manualDiscountMinor > 0)
              row('Discount', -t.manualDiscountMinor,
                  colour: scheme.tertiary, style: small),
            // Named rather than lumped in with the manual discount: the clerk
            // needs to see that attaching the customer actually did something.
            if (t.customerDiscountMinor > 0)
              row('Customer discount', -t.customerDiscountMinor,
                  colour: scheme.tertiary, style: small),
            if (t.voucherMinor > 0)
              row('Voucher', -t.voucherMinor,
                  colour: scheme.tertiary, style: small),
            if (t.pointsMinor > 0)
              row('Points redeemed', -t.pointsMinor,
                  colour: scheme.tertiary, style: small),
            if (t.gratuityMinor > 0)
              row('Service ${(t.gratuityBp / 10).toStringAsFixed(t.gratuityBp % 10 == 0 ? 0 : 1)}%',
                  t.gratuityMinor, style: small),
            const Divider(height: 12),
          ],

          Row(
            children: [
              Expanded(
                child: Text('TOTAL',
                    style: theme.textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w800)),
              ),
              Text(
                _money(t.totalMinor),
                style: theme.textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w800),
              ),
            ],
          ),

          // What has been taken so far, once the bill is being settled.
          if (tender != null && tender!.tenders.isNotEmpty) ...[
            const Divider(height: 14),
            for (final entry in tender!.tenders)
              row(
                entry.entryMode == 'manual'
                    ? '${entry.label} (keyed)'
                    : entry.label,
                entry.amountMinor,
                style: small,
              ),
            if (tender!.changeMinor > 0)
              row('Change', tender!.changeMinor, bold: true),
          ],

          if (tender != null && tender!.outstandingMinor > 0 &&
              tender!.tenders.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Container(
                padding:
                    const EdgeInsets.symmetric(vertical: 6, horizontal: 10),
                decoration: BoxDecoration(
                  color: scheme.errorContainer,
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text('Still to pay',
                          style: body?.copyWith(
                              color: scheme.onErrorContainer,
                              fontWeight: FontWeight.bold)),
                    ),
                    Text(
                      _money(tender!.outstandingMinor),
                      style: body?.copyWith(
                          color: scheme.onErrorContainer,
                          fontWeight: FontWeight.bold),
                    ),
                  ],
                ),
              ),
            ),

          // Which share of a split is being taken.
          if (tender?.isSplit ?? false) ...[
            const SizedBox(height: 8),
            _SplitStrip(tender: tender!),
          ],
        ],
      ),
    );
  }
}

/// The shares of a split bill, with the active one highlighted.
class _SplitStrip extends StatelessWidget {
  const _SplitStrip({required this.tender});

  final TenderState tender;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final share in tender.shares)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
            decoration: BoxDecoration(
              color: share.settled
                  ? scheme.primaryContainer
                  : share.index == tender.activeShare
                      ? scheme.primary
                      : scheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(7),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (share.settled)
                  Icon(Icons.check,
                      size: 13, color: scheme.onPrimaryContainer),
                if (share.settled) const SizedBox(width: 4),
                Text(
                  '${share.name.isEmpty ? share.index + 1 : share.name}: ${_money(share.outstandingMinor)}',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: share.settled
                        ? scheme.onPrimaryContainer
                        : share.index == tender.activeShare
                            ? scheme.onPrimary
                            : scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// The empty sale: a basket that gently bobs over a breathing ring, waiting
/// for the first item. Still when the device asks for less motion, and under
/// tests, so goldens and settles are unchanged.
class _EmptyBasket extends StatefulWidget {
  const _EmptyBasket({required this.colour});
  final Color colour;
  @override
  State<_EmptyBasket> createState() => _EmptyBasketState();
}

class _EmptyBasketState extends State<_EmptyBasket> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1800));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final testing = WidgetsBinding.instance.runtimeType.toString().contains('Test');
    if (!still && !testing && !_c.isAnimating) _c.repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final v = Curves.easeInOut.transform(_c.value);
          return SizedBox(
            width: 96,
            height: 80,
            child: Stack(alignment: Alignment.center, children: [
              Container(
                width: 56 + 22 * v,
                height: 56 + 22 * v,
                decoration: BoxDecoration(shape: BoxShape.circle, color: Pos.brand.withValues(alpha: 0.10 * (1 - v) + 0.04)),
              ),
              Transform.translate(
                offset: Offset(0, -6 * v),
                child: Transform.rotate(angle: (v - 0.5) * 0.12, child: Icon(Icons.shopping_basket_outlined, size: 44, color: widget.colour)),
              ),
            ]),
          );
        },
      );
}
