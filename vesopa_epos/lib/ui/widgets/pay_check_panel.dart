import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/bill_rounds.dart';
import '../../data/modifier_layout.dart';
import '../../data/pricing_engine.dart';
import '../theme.dart';
import 'customer_card.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);

/// The check, as the payment board draws it.
///
/// Deliberately *not* [LiveReceipt]. That widget draws the bill as the paper it
/// will become — monospace, narrow, columns aligned like a till roll — and it is
/// shared with the sale screen, where a clerk is ringing items in and wants to
/// see the receipt taking shape. This screen is a different job. The bill is
/// finished; it is now being read out to a customer standing on the other side
/// of the counter while money changes hands. So it is set in the interface face
/// at 19pt with the quantity in a chip and the price on the right, and the total
/// is the size of a headline rather than a line of receipt text.
///
/// Everything the money block says is still here — offers, discounts, vouchers,
/// points, service — but only when non-zero, so the ordinary cash sale is three
/// rows rather than nine.
class PayCheckPanel extends StatelessWidget {
  const PayCheckPanel({
    super.key,
    required this.totals,
    this.tableNumber,
    this.covers,
    this.customer,
    this.selectedLineIds = const {},
    this.onTapLine,
    this.onChangeCustomer,
    this.onRemoveCustomer,
  });

  final BasketTotals totals;

  final int? tableNumber;
  final int? covers;

  /// Who the bill is for. Null on the ordinary walk-in sale, and then nothing
  /// is drawn — see [CustomerCard].
  final BillCustomer? customer;

  /// Lines picked out for Void. A picked line is what the Void key acts on, so
  /// it is drawn as a filled band with a lime edge rather than a tint — it has
  /// to survive a glance across a counter.
  final Set<String> selectedLineIds;

  /// Picks a line out, or puts it back. Null once money has been taken, when
  /// the bill may no longer be amended.
  final void Function(PricedLine line)? onTapLine;

  /// Attach a different customer, and take the current one off. Both null once
  /// money has been taken.
  final VoidCallback? onChangeCustomer;
  final VoidCallback? onRemoveCustomer;

  /// The width the design was drawn at. Everything scales off this, so the
  /// panel keeps its proportions on a 1280px till as well as a 1920px one
  /// rather than turning into large type in a narrow box.
  static const _designWidth = 460.0;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);

    return Container(
      decoration: BoxDecoration(
        color: pay.panel,
        border: Border.all(color: pay.panelLine),
        borderRadius: BorderRadius.circular(18),
      ),
      clipBehavior: Clip.antiAlias,
      child: LayoutBuilder(
        builder: (context, box) {
          final s = (box.maxWidth / _designWidth).clamp(0.72, 1.0);

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _header(context, pay, s),
              Expanded(child: _lines(context, pay, s)),
              _footer(context, pay, s),
            ],
          );
        },
      ),
    );
  }

  /// Which bill this is, and nothing else.
  ///
  /// This block used to open with the venue's name in caps, then a line reading
  /// `Table 4 · 2 covers · Nicky · 12 High Street · 19:08`. All of it went in
  /// v1.6.6 except the table and the covers, at the venue's request, and the
  /// reasoning is worth keeping because it is not "less is more":
  ///
  ///   * the **venue name and address** are the top of a *printed receipt*.
  ///     Nobody standing at the till needs telling which building they are in,
  ///     and the printed receipt and the PDF still carry both. This is the same
  ///     judgement LiveReceipt.showHeader made, arriving late at this screen.
  ///   * the **clerk's name** is in the top bar, three inches away, all shift.
  ///   * the **time** is on the wall, on the receipt and in the top bar.
  ///
  /// What survives is the pair a clerk genuinely cannot get anywhere else on a
  /// handheld, where the header bar drops its chips below 1100px and the check
  /// moves to a tab of its own: whether this is table 12's bill or table 2's.
  ///
  /// Note the staff *headings inside the list* are a different thing and stay —
  /// they are how a round is picked out to be paid on its own. See
  /// [_showRoundHeadings].
  Widget _header(BuildContext context, PayPalette pay, double s) {
    final where = <String>[
      if (tableNumber != null) 'Table $tableNumber',
      if (covers != null && covers! > 0) '$covers covers',
    ].join('  ·  ');

    final person = customer;

    // A counter sale with no customer has nothing left to say, and an empty bar
    // with a rule under it is worse than no bar at all.
    if (where.isEmpty && person == null) return const SizedBox.shrink();

    return Container(
      padding: EdgeInsets.symmetric(vertical: 16 * s, horizontal: 24 * s),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: pay.panelLine)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (where.isNotEmpty)
            Text(
              where,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 17 * s,
                fontWeight: FontWeight.w700,
                color: pay.ink,
              ),
            ),
          if (person != null) ...[
            if (where.isNotEmpty) SizedBox(height: 9 * s),
            CustomerCard(
              customer: person,
              scale: s,
              onChange: onChangeCustomer,
              onRemove: onRemoveCustomer,
            ),
          ],
        ],
      ),
    );
  }

  /// Whether to head each run of items with who rang it and when.
  ///
  /// This is the resolution of a genuine conflict between two of the venue's
  /// requests. One asked for the staff name to come off this screen; the other
  /// asked to be able to pay Nicky's round without paying Muzahid's, and the
  /// heading is what tells the two rounds apart.
  ///
  /// So: gone on an ordinary sale, where a heading over the whole bill names
  /// something there is nothing to distinguish; kept on a table two people have
  /// served, where it is doing a job. The rule itself is [hasRounds], shared
  /// with the sale screen's check so a bill cannot group one way while it is
  /// being rung and another way while it is being paid.
  Widget _lines(BuildContext context, PayPalette pay, double s) {
    if (totals.lines.isEmpty) {
      return Center(
        child: Text(
          'No items yet',
          style: TextStyle(fontSize: 16 * s, color: pay.inkDim),
        ),
      );
    }

    final ordered = orderWithModifiers(
      totals.lines,
      idOf: (l) => l.id,
      parentOf: (l) => l.parentLineId,
    );
    final rounds = roundsOf(ordered);
    final headed = hasRounds(rounds);

    // Flattened to rows so the list keeps scrolling as one thing rather than
    // becoming a column of nested lists on a long table bill.
    final rows = <Widget>[];
    var striped = false;
    for (final round in rounds) {
      final label = round.label;
      if (headed && label != null) {
        rows.add(_RoundHeading(label: label, scale: s));
        // Banding restarts under each heading, so a round always opens on the
        // same footing rather than inheriting the stripe of the round above.
        striped = false;
      }
      for (final line in round.lines) {
        rows.add(
          _CheckRow(
            line: line,
            scale: s,
            // Banded on alternate rows rather than ruled: a rule between every
            // item on a twenty-line bill is twenty more things to read past.
            striped: striped,
            selected: selectedLineIds.contains(line.id),
            onTap: onTapLine == null ? null : () => onTapLine!(line),
          ),
        );
        striped = !striped;
      }
    }

    return ListView(
      padding: EdgeInsets.symmetric(vertical: 8 * s, horizontal: 10 * s),
      children: rows,
    );
  }

  Widget _footer(BuildContext context, PayPalette pay, double s) {
    final t = totals;

    Widget row(String label, int minor, {Color? colour}) => Padding(
          padding: EdgeInsets.only(bottom: 10 * s),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 15 * s,
                    color: colour ?? pay.inkMuted,
                  ),
                ),
              ),
              Text(
                _money(minor),
                style: TextStyle(
                  fontSize: 15 * s,
                  color: colour ?? pay.inkMuted,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        );

    final teal = Theme.of(context).colorScheme.tertiary;

    return Container(
      padding: EdgeInsets.fromLTRB(24 * s, 18 * s, 24 * s, 18 * s),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: pay.panelLine)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          row('Subtotal', t.grossMinor),
          if (t.promoMinor > 0) row('Offers', -t.promoMinor, colour: teal),
          if (t.manualDiscountMinor > 0)
            row('Discount', -t.manualDiscountMinor, colour: teal),
          if (t.customerDiscountMinor > 0)
            row('Customer discount', -t.customerDiscountMinor, colour: teal),
          if (t.voucherMinor > 0) row('Voucher', -t.voucherMinor, colour: teal),
          if (t.pointsMinor > 0)
            row('Points redeemed', -t.pointsMinor, colour: teal),
          row(
            t.gratuityBp > 0
                ? 'Service ${(t.gratuityBp / 10).toStringAsFixed(t.gratuityBp % 10 == 0 ? 0 : 1)}%'
                : 'Service',
            t.gratuityMinor,
          ),
          Container(
            padding: EdgeInsets.only(top: 12 * s),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: pay.panelLine)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Expanded(
                  child: Text(
                    'TOTAL',
                    style: TextStyle(
                      fontSize: 17 * s,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 1.0 * s,
                      color: pay.ink,
                    ),
                  ),
                ),
                Text(
                  _money(t.totalMinor),
                  style: TextStyle(
                    fontSize: 34 * s,
                    fontWeight: FontWeight.w700,
                    color: pay.ink,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// One item on the check.
///
/// Whatever needs explaining hangs underneath it — the unit price on a
/// multiple, the kitchen note, and the offer that reduced it — indented past
/// the quantity chip so the column of names stays a column.
class _CheckRow extends StatelessWidget {
  const _CheckRow({
    required this.line,
    required this.scale,
    required this.striped,
    required this.selected,
    this.onTap,
  });

  final PricedLine line;
  final double scale;
  final bool striped;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = scale;
    final pay = PayPalette.of(context);
    final teal = Theme.of(context).colorScheme.tertiary;
    final chip = 30 * s;

    final detail = <Widget>[
      if (line.quantity != 1)
        Text(
          '@ ${_money(line.unitPriceMinor)} each',
          style: TextStyle(fontSize: 14 * s, color: pay.inkMuted),
        ),
      if (line.note?.isNotEmpty ?? false)
        Text(
          '* ${line.note}',
          style: TextStyle(
            fontSize: 14 * s,
            color: pay.inkMuted,
            fontStyle: FontStyle.italic,
          ),
        ),
      if (line.discounted)
        Text(
          '${line.promotionName ?? 'Offer'}  −${_money(line.discountMinor)}',
          style: TextStyle(
            fontSize: 14 * s,
            color: teal,
            fontWeight: FontWeight.w600,
          ),
        ),
    ];

    return Material(
      color: selected
          ? pay.accent.withValues(alpha: 0.18)
          : striped
              ? pay.rowAlt
              : Colors.transparent,
      borderRadius: BorderRadius.circular(12 * s),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12 * s),
        child: Container(
          // The lime edge is what says "Void acts on this one".
          decoration: selected
              ? BoxDecoration(
                  borderRadius: BorderRadius.circular(12 * s),
                  border: Border(
                    left: BorderSide(color: pay.accent, width: 3 * s),
                  ),
                )
              : null,
          padding: EdgeInsets.symmetric(vertical: 13 * s, horizontal: 14 * s),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: chip,
                    height: chip,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: selected ? pay.accent : pay.rowAlt,
                      borderRadius: BorderRadius.circular(8 * s),
                      border: Border.all(color: pay.panelLine),
                    ),
                    child: selected
                        ? Icon(Icons.check,
                            size: 17 * s,
                            color: Theme.of(context).brightness ==
                                    Brightness.dark
                                ? Pos.onBrand
                                : Colors.white)
                        : Text(
                            _qty(line.quantity),
                            style: TextStyle(
                              fontSize: 15 * s,
                              color: pay.inkSoft,
                            ),
                          ),
                  ),
                  SizedBox(width: 14 * s),
                  Expanded(
                    child: Text(
                      line.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 19 * s,
                        color: pay.ink,
                        fontWeight:
                            selected ? FontWeight.w700 : FontWeight.w400,
                      ),
                    ),
                  ),
                  SizedBox(width: 10 * s),
                  Text(
                    _money(line.discounted ? line.netMinor : line.grossMinor),
                    style: TextStyle(
                      fontSize: 19 * s,
                      color: pay.inkSoft,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
              if (detail.isNotEmpty)
                Padding(
                  padding: EdgeInsets.only(left: chip + 14 * s, top: 3 * s),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: detail,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// `Nicky · 19:08` over the run of items that person rang.
///
/// The one thing left on this screen that names a member of staff, and it earns
/// it: this is what a clerk taps past to see whose round is whose before
/// splitting the bill by round.
class _RoundHeading extends StatelessWidget {
  const _RoundHeading({required this.label, required this.scale});

  final String label;
  final double scale;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);

    return Padding(
      padding: EdgeInsets.fromLTRB(8 * scale, 12 * scale, 8 * scale, 4 * scale),
      child: Row(
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 13 * scale,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.6 * scale,
              color: pay.inkMuted,
            ),
          ),
          SizedBox(width: 10 * scale),
          Expanded(child: Container(height: 1, color: pay.panelLine)),
        ],
      ),
    );
  }
}
