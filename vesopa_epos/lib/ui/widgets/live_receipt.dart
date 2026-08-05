import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/branding.dart';
import '../../data/pricing_engine.dart';
import '../../data/tender_engine.dart';

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
    this.customerName,
    this.tableNumber,
    this.covers,
    this.clerkName,
    this.onTapLine,
    this.onEditLine,
    this.selectedLineIds = const {},
    this.showHeader = true,
    this.emptyMessage = 'No items yet',
    this.aboveTotals,
  });

  final BasketTotals totals;
  final Branding branding;

  /// Payment progress, when the bill is being settled. Null on the sale
  /// screen, where nothing has been tendered yet.
  final TenderState? tender;

  final String? customerName;
  final int? tableNumber;
  final int? covers;
  final String? clerkName;

  /// Picks a line out, or puts it back — tapping is symmetric.
  final void Function(PricedLine line)? onTapLine;

  /// Opens the item box for a line. Surfaced as a pencil on the selected row.
  final void Function(PricedLine line)? onEditLine;

  /// Lines the clerk has picked out, by line id. A selected line is what Void
  /// acts on, so it has to be unmistakable at a glance on a busy counter —
  /// hence a filled band and a tick, not a faint tint.
  final Set<String> selectedLineIds;

  final bool showHeader;
  final String emptyMessage;

  /// Slotted in directly above Subtotal. The sale screen puts the quantity
  /// stepper for a single picked line here, so the control sits with the money
  /// it is about to change rather than in a dialog somewhere else.
  final Widget? aboveTotals;

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
  static double _bodySizeFor(double listHeight) {
    // Vertical padding (3 top + 3 bottom) plus the line-height multiplier.
    const chromePerRow = 6.0;
    const lineHeight = 1.35;
    final perRow = listHeight / _targetVisibleLines;
    return ((perRow - chromePerRow) / lineHeight).clamp(14.0, 22.0);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Container(
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant),
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
          final size = _bodySizeFor(listHeight);

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
                            Icon(Icons.receipt_long_outlined,
                                size: 40, color: scheme.outlineVariant),
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
                            customerName: customerName,
                            style: small,
                          ),
                          const SizedBox(height: 4),
                          for (final entry in _blocks(totals.lines)) ...[
                            if (entry.header != null)
                              _StaffHeading(
                                label: entry.header!,
                                style: small,
                              ),
                            for (final line in entry.lines)
                              _LineRow(
                                line: line,
                                body: body,
                                small: small,
                                onTap: onTapLine,
                                onEdit: onEditLine,
                                selected: selectedLineIds.contains(line.id),
                              ),
                          ],
                        ],
                      ),
              ),

              ?aboveTotals,

              _Totals(
                totals: totals,
                tender: tender,
                body: body,
                small: small,
              ),
            ],
          );
        },
      ),
    );
  }

  /// Group the bill into runs of items added by the same person.
  ///
  /// A single-author bill — which is every walk-in sale — gets one block with no
  /// header, so the ordinary case looks exactly as it did before. A header only
  /// appears where there is genuinely something to distinguish: a table that two
  /// people have served, which is the case the venue asked about.
  ///
  /// Runs, not a grouping: items stay in the order they were rung up. Sorting a
  /// bill by who rang it would reorder a kitchen ticket, and the order items were
  /// called in is information in its own right.
  static List<_Block> _blocks(List<PricedLine> lines) {
    final blocks = <_Block>[];

    for (final line in lines) {
      final who = line.addedBy?.trim();
      final open = blocks.isEmpty ? null : blocks.last;

      if (open != null && open.who == who) {
        open.lines.add(line);
      } else {
        blocks.add(_Block(who: who, at: line.addedAt, lines: [line]));
      }
    }

    // One block covering the whole bill needs no heading — there is nothing to
    // tell it apart from.
    final attributed = blocks.where((b) => b.who?.isNotEmpty ?? false).length;
    if (blocks.length <= 1 || attributed == 0) {
      for (final b in blocks) {
        b.header = null;
      }
      return blocks;
    }

    for (final b in blocks) {
      final who = b.who;
      if (who == null || who.isEmpty) {
        b.header = null;
        continue;
      }
      final at = b.at;
      b.header = at == null ? who : '$who  ·  ${DateFormat('HH:mm').format(at)}';
    }
    return blocks;
  }
}

/// A run of items on the check, and the staff heading above it.
class _Block {
  _Block({required this.who, required this.at, required this.lines});

  final String? who;
  final DateTime? at;
  final List<PricedLine> lines;

  /// The line drawn above the run, or null when there is nothing worth saying.
  String? header;
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
    final scheme = Theme.of(context).colorScheme;
    final name = branding.venueName.isNotEmpty ? branding.venueName : 'VESOPA';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 14),
      color: scheme.surfaceContainerHighest,
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
    this.customerName,
    this.style,
  });

  final int? tableNumber;
  final int? covers;
  final String? clerkName;
  final String? customerName;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final bits = <String>[
      if (tableNumber != null) 'Table $tableNumber',
      if (covers != null && covers! > 0) '$covers covers',
      if (clerkName?.isNotEmpty ?? false) clerkName!,
      DateFormat('HH:mm').format(DateTime.now()),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(bits.join('  ·  '), style: style),
        if (customerName?.isNotEmpty ?? false)
          Text(customerName!,
              style: style?.copyWith(fontWeight: FontWeight.bold)),
        const Divider(height: 12),
      ],
    );
  }
}

/// One item, with whatever needs explaining underneath it: the unit price on a
/// multiple, a kitchen note, and the offer that reduced it.
class _LineRow extends StatelessWidget {
  const _LineRow({
    required this.line,
    this.body,
    this.small,
    this.onTap,
    this.onEdit,
    this.selected = false,
  });

  final PricedLine line;
  final TextStyle? body;
  final TextStyle? small;

  /// Picks the line out, or puts it back. Tapping is symmetric on purpose: a
  /// clerk who taps the wrong row fixes it by tapping it again, which is the
  /// only thing anyone tries.
  final void Function(PricedLine line)? onTap;

  /// Opens the item box. Reached from a pencil that appears on the row once it
  /// is selected — deliberately a visible control rather than a long press,
  /// because a hidden gesture has to be taught to every new member of staff and
  /// costs half a second every time it is used.
  final void Function(PricedLine line)? onEdit;

  final bool selected;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return InkWell(
      onTap: onTap == null ? null : () => onTap!(line),
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
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 28,
                  child: selected
                      ? Icon(Icons.check_circle,
                          size: 15, color: scheme.primary)
                      : Text(_qty(line.quantity), style: body),
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

                // The door to the item box, and only shown on the row it acts
                // on. Sized to 40px square — a receipt row is narrow, but this
                // still has to be hittable with a thumb on a busy counter.
                if (selected && onEdit != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 4),
                    child: Material(
                      color: scheme.primary,
                      borderRadius: BorderRadius.circular(7),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(7),
                        onTap: () => onEdit!(line),
                        child: Tooltip(
                          message: 'Quantity, discount, note',
                          child: SizedBox(
                            width: 40,
                            height: 40,
                            child: Icon(
                              Icons.edit,
                              size: 18,
                              color: scheme.onPrimary,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),

            // The quantity moves out of the gutter when a tick takes its place,
            // so a selected "3x Latte" still shows it is three.
            if (selected)
              Padding(
                padding: const EdgeInsets.only(left: 28),
                child: Text('${_qty(line.quantity)} × selected', style: small),
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
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.45),
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
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
                  '${share.index + 1}: ${_money(share.outstandingMinor)}',
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
