/// The customer's half of the screen.
///
/// A bill read from three or four feet away by somebody who is not wearing
/// their glasses. Everything about this panel follows from that: large type, a
/// total that is the biggest thing on the screen, and the newest line always
/// visible without anybody touching anything.
library;

import 'package:flutter/material.dart';

import '../data/basket_feed.dart';
import 'theme.dart';

class BillPanel extends StatefulWidget {
  const BillPanel({
    super.key,
    required this.basket,
    required this.showPrices,
    required this.thankYou,
  });

  final Basket basket;
  final bool showPrices;
  final String thankYou;

  @override
  State<BillPanel> createState() => _BillPanelState();
}

class _BillPanelState extends State<BillPanel> {
  final _scroll = ScrollController();

  @override
  void didUpdateWidget(BillPanel old) {
    super.didUpdateWidget(old);
    // Follow the bottom as items are rung up.
    //
    // The whole point of the screen is that the customer sees the thing that
    // just went on — a bill that has scrolled past the visible area and stayed
    // there is showing them the start of their round while the clerk adds the
    // end of it. Jumped rather than animated: an item lands in well under the
    // time an animation would take, and a queue of them would never settle.
    if (old.basket.lines.length != widget.basket.lines.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) {
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        }
      });
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final basket = widget.basket;

    return ColoredBox(
      color: Brand.panel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(28, 28, 28, 8),
              itemCount: basket.lines.length,
              itemBuilder: (_, i) =>
                  _Line(line: basket.lines[i], showPrice: widget.showPrices),
            ),
          ),
          _Totals(basket: basket, thankYou: widget.thankYou),
        ],
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.line, required this.showPrice});

  final BasketLine line;
  final bool showPrice;

  @override
  Widget build(BuildContext context) {
    // A modifier is a choice under the item above it. Indented, quieter, and
    // without a price of its own unless it has one — "Dash Lime" costing
    // nothing does not need a £0.00 beside it to be understood.
    final modifier = line.isModifier;
    final quantity = line.quantity;
    final showQuantity = !modifier && quantity != 1;

    return Padding(
      padding: EdgeInsets.only(left: modifier ? 26 : 0, bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (showQuantity)
            SizedBox(
              width: 56,
              child: Text(
                _quantity(quantity),
                style: const TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w700,
                  color: Brand.lime,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ),
          Expanded(
            child: Text(
              line.name,
              style: TextStyle(
                fontSize: modifier ? 20 : 26,
                fontWeight: modifier ? FontWeight.w400 : FontWeight.w600,
                color: modifier ? Brand.inkSoft : Brand.ink,
                height: 1.2,
              ),
            ),
          ),
          if (showPrice && !(modifier && line.totalMinor == 0)) ...[
            const SizedBox(width: 16),
            Text(
              money(line.totalMinor),
              style: TextStyle(
                fontSize: modifier ? 20 : 26,
                fontWeight: modifier ? FontWeight.w400 : FontWeight.w600,
                color: modifier ? Brand.inkSoft : Brand.ink,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// "2" rather than "2.0", but "0.5" where a venue sells by weight.
  static String _quantity(double value) =>
      value == value.roundToDouble()
          ? '${value.round()}'
          : value.toStringAsFixed(2);
}

class _Totals extends StatelessWidget {
  const _Totals({required this.basket, required this.thankYou});

  final Basket basket;
  final String thankYou;

  @override
  Widget build(BuildContext context) {
    final paid = basket.state == 'paid';

    return Container(
      padding: const EdgeInsets.fromLTRB(28, 20, 28, 28),
      decoration: const BoxDecoration(
        color: Brand.panelSoft,
        border: Border(top: BorderSide(color: Brand.line, width: 2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (basket.discountMinor > 0)
            _Row(
              label: 'Discount',
              value: '-${money(basket.discountMinor)}',
              size: 20,
              muted: true,
            ),
          _Row(
            label: 'Total',
            value: money(basket.totalMinor),
            size: 46,
            bold: true,
          ),
          if (paid) ...[
            const SizedBox(height: 10),
            _Row(label: 'Paid', value: money(basket.paidMinor), size: 24),
            // The one moment this screen genuinely earns its keep: a customer
            // checking their change without having to ask.
            if (basket.changeMinor > 0)
              _Row(
                label: 'Change',
                value: money(basket.changeMinor),
                size: 34,
                bold: true,
                accent: true,
              ),
            const SizedBox(height: 12),
            Text(
              basket.message ?? thankYou,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 24,
                color: Brand.lime,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.label,
    required this.value,
    required this.size,
    this.bold = false,
    this.muted = false,
    this.accent = false,
  });

  final String label;
  final String value;
  final double size;
  final bool bold;
  final bool muted;
  final bool accent;

  @override
  Widget build(BuildContext context) {
    final colour = accent
        ? Brand.lime
        : muted
        ? Brand.inkSoft
        : Brand.ink;
    final style = TextStyle(
      fontSize: size,
      color: colour,
      fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
      fontFeatures: const [FontFeature.tabularFigures()],
    );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: style),
          Text(value, style: style),
        ],
      ),
    );
  }
}
