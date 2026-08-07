import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/branding.dart';
import '../../data/pricing_engine.dart';
import '../theme.dart';

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
    required this.branding,
    this.tableNumber,
    this.covers,
    this.clerkName,
    this.customerName,
    this.selectedLineIds = const {},
    this.onTapLine,
  });

  final BasketTotals totals;
  final Branding branding;

  final int? tableNumber;
  final int? covers;
  final String? clerkName;
  final String? customerName;

  /// Lines picked out for Void. A picked line is what the Void key acts on, so
  /// it is drawn as a filled band with a lime edge rather than a tint — it has
  /// to survive a glance across a counter.
  final Set<String> selectedLineIds;

  /// Picks a line out, or puts it back. Null once money has been taken, when
  /// the bill may no longer be amended.
  final void Function(PricedLine line)? onTapLine;

  /// The width the design was drawn at. Everything scales off this, so the
  /// panel keeps its proportions on a 1280px till as well as a 1920px one
  /// rather than turning into large type in a narrow box.
  static const _designWidth = 460.0;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);
    final venue =
        branding.venueName.isNotEmpty ? branding.venueName : 'VESOPA';

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
              _header(context, pay, s, venue),
              Expanded(child: _lines(context, pay, s)),
              _footer(context, pay, s),
            ],
          );
        },
      ),
    );
  }

  Widget _header(
    BuildContext context,
    PayPalette pay,
    double s,
    String venue,
  ) {
    // Which bill this is, on one line under the venue.
    //
    // The header bar carries the same facts on a wide till — but only there.
    // Below 1100px it drops the chips for room, and the check moves to a tab of
    // its own, so this is the only place a clerk on a handheld can confirm they
    // are reading table 12's bill and not table 2's. It has to be on the bill.
    final where = <String>[
      if (tableNumber != null) 'Table $tableNumber',
      if (covers != null && covers! > 0) '$covers covers',
      if (clerkName?.isNotEmpty ?? false) clerkName!,
      if (branding.addressLines.isNotEmpty && tableNumber == null)
        branding.addressLines.first,
      DateFormat('HH:mm').format(DateTime.now()),
    ].join('  ·  ');

    return Container(
      padding: EdgeInsets.symmetric(vertical: 22 * s, horizontal: 24 * s),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: pay.panelLine)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            venue.toUpperCase(),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 17 * s,
              fontWeight: FontWeight.w700,
              letterSpacing: 1.4 * s,
              color: pay.ink,
            ),
          ),
          SizedBox(height: 5 * s),
          Text(
            where,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 14 * s, color: pay.inkMuted),
          ),
          if (customerName?.isNotEmpty ?? false) ...[
            SizedBox(height: 5 * s),
            Text(
              customerName!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 14 * s,
                fontWeight: FontWeight.w700,
                color: pay.accent,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _lines(BuildContext context, PayPalette pay, double s) {
    if (totals.lines.isEmpty) {
      return Center(
        child: Text(
          'No items yet',
          style: TextStyle(fontSize: 16 * s, color: pay.inkDim),
        ),
      );
    }

    return ListView.builder(
      padding: EdgeInsets.symmetric(vertical: 8 * s, horizontal: 10 * s),
      itemCount: totals.lines.length,
      itemBuilder: (context, i) {
        final line = totals.lines[i];
        return _CheckRow(
          line: line,
          scale: s,
          // Banded on alternate rows rather than ruled: a rule between every
          // item on a twenty-line bill is twenty more things to read past.
          striped: i.isOdd,
          selected: selectedLineIds.contains(line.id),
          onTap: onTapLine == null ? null : () => onTapLine!(line),
        );
      },
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
