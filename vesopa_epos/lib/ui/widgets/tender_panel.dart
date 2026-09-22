import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/cash_tally.dart';
import '../../data/commerce.dart';
import '../../data/local/database.dart';
import '../../data/tender_engine.dart';
import '../theme.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// The money column of the payment board.
///
/// Reads top to bottom in the order the clerk works: what is left to pay and
/// what has been taken, then the two keys that take almost every payment, then
/// the two that take the rest, then the notes, then everything else.
///
/// The hierarchy is the point and it is expressed in size rather than colour.
/// Cash and Card are 190px tall with 44pt labels; the eight function keys —
/// gift card, voucher, deposit, points and the reductions — are half the height
/// of the note row above them. A clerk reaching for Cash should not have to
/// read the screen to find it, and a clerk reaching for Voucher should have to.
class TenderColumn extends StatelessWidget {
  const TenderColumn({
    super.key,
    required this.state,
    required this.settings,
    required this.denominations,
    required this.onTender,
    this.noteKeys,
    this.onGratuity,
    this.onSplit,
    this.onSelectShare,
    this.onClearSplit,
    this.onUndo,
    this.onCustomer,
    this.onDiscount,
    this.onPrintBill,
    this.amountMinor,
  });

  final TenderState state;
  final TenderSettings settings;

  /// The venue's note keys, only needed here so the Tendered list can spell a
  /// cash payment out as the notes it was made of.
  final List<CashDenomination> denominations;

  final void Function(TenderKind kind, int amountMinor) onTender;

  /// The note pictures (see [CashNotesPanel]), built by the payment screen so
  /// this widget stays clear of the tally and the database.
  final Widget? noteKeys;

  final void Function()? onGratuity;
  final void Function()? onSplit;
  final void Function(int index)? onSelectShare;
  final void Function()? onClearSplit;
  final void Function()? onUndo;
  final void Function()? onCustomer;
  final void Function()? onDiscount;

  /// Print the bill as it stands, before it is paid — the piece of paper a
  /// restaurant table asks for. On the board because it is asked for at exactly
  /// this moment, and backing out to the sale screen to find it is how a table
  /// ends up waiting.
  final void Function()? onPrintBill;

  /// What a tender key will take: the keyed amount, or the balance. Supplied by
  /// the payment screen, which owns the keypad entry.
  final int? amountMinor;

  int get _amount => amountMinor ?? state.dueNowMinor;

  /// Whether the keyed amount is a *part* payment rather than the whole
  /// balance. A venue can switch part-payment by card off — two card fees on
  /// one bill can cost more than the convenience is worth.
  bool get _isPartial => _amount > 0 && _amount < state.dueNowMinor;

  /// What the card keys will take, or null when they must be refused. Never
  /// more than is owed: overpaying a card is a refund to arrange, not change to
  /// hand over.
  int? get _cardAmount {
    if (state.dueNowMinor <= 0) return null;
    if (_isPartial && !settings.allowPartialCard) return null;
    return _amount > state.dueNowMinor ? state.dueNowMinor : _amount;
  }

  /// The height the design was drawn at, for the vertical scale. Everything in
  /// this column is sized as a fraction of the board, so a 1366×768 till gets
  /// the same layout rather than the same pixels with the bottom row cut off.
  static const _designHeight = 944.0;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, box) {
        final v = box.maxHeight.isFinite
            ? (box.maxHeight / _designHeight).clamp(0.62, 1.0)
            : 1.0;
        final gap = 16 * v;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _balance(context, v, box.maxWidth),
            SizedBox(height: gap),
            SizedBox(height: 190 * v, child: _primary(context, v)),
            SizedBox(height: gap),
            SizedBox(height: 86 * v, child: _secondary(context, v)),
            SizedBox(height: gap),
            // The notes take whatever the fixed rows leave. They are the only
            // thing here that is a picture rather than a label, and a picture
            // that has been squeezed has stopped being one.
            if (noteKeys != null) ...[
              Expanded(child: noteKeys!),
              SizedBox(height: gap),
            ] else
              const Spacer(),
            _functions(context, v),
          ],
        );
      },
    );
  }

  /// What is owed, and what has already been handed over.
  ///
  /// Side by side wherever there is room for both, because they are read
  /// together: the clerk says "that's £19.20" and the customer's twenty appears
  /// beside it. Below [_stackTenderedBelow] the two stack instead — squeezed
  /// into a narrow column the balance would be the smaller of the two figures,
  /// which is the wrong way round on the number this whole screen is about.
  Widget _balance(BuildContext context, double v, double width) {
    final pay = PayPalette.of(context);
    final stacked = width < _stackTenderedBelow;
    // min/max rather than clamp: the two bounds are computed from different
    // things — one from the panel's width, one from the board's height — and
    // `clamp` throws outright when the lower ends up above the upper, which on
    // a short wide till it did.
    final tenderedWidth = math.min(260.0 * v, math.max(180.0, width * 0.34));

    final figure = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _label(
          context,
          state.isSplit
              ? 'SHARE ${state.activeShare + 1} OF ${state.shares.length}'
              : 'LEFT TO PAY',
          v,
        ),
        SizedBox(height: 6 * v),
        // The largest number on the till, and read from the far side of a
        // counter by two people at once. FittedBox rather than a fixed size
        // because "£1,234.56" on a split bill is twice the width of "£9.60"
        // and neither may wrap.
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            _money(state.dueNowMinor),
            maxLines: 1,
            style: TextStyle(
              fontSize: 88 * v,
              height: 1.02,
              fontWeight: FontWeight.w700,
              letterSpacing: -2 * v,
              color: pay.accent,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ),
        ..._shares(context, v),
      ],
    );

    return Container(
      padding: EdgeInsets.symmetric(vertical: 22 * v, horizontal: 26 * v),
      decoration: BoxDecoration(
        color: pay.panel,
        border: Border.all(color: pay.panelLine),
        borderRadius: BorderRadius.circular(18),
      ),
      child: stacked
          ? Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                figure,
                SizedBox(height: 14 * v),
                Divider(height: 1, thickness: 1, color: pay.panelLine),
                SizedBox(height: 14 * v),
                _tendered(context, v),
              ],
            )
          // IntrinsicHeight so the rule between the two halves runs the full
          // height of whichever is taller. A stretched Row on its own cannot:
          // this panel sits in a Column that hands it unbounded height, and
          // stretching against infinity is an assertion, not a layout.
          : IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: figure),
                  SizedBox(width: 26 * v),
                  Container(width: 1, color: pay.panelLine),
                  SizedBox(width: 26 * v),
                  SizedBox(width: tenderedWidth, child: _tendered(context, v)),
                ],
              ),
            ),
    );
  }

  /// Narrower than this and the balance and the tendered list stack.
  static const _stackTenderedBelow = 560.0;

  Widget _tendered(BuildContext context, double v) {
    final pay = PayPalette.of(context);
    final labels = labelsFor(denominations);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: _label(context, 'TENDERED', v)),
            // The way back out of a mis-tap, sitting with the money it undoes.
            if (state.tenders.isNotEmpty && onUndo != null)
              _TextKey(
                label: 'Undo',
                scale: v,
                colour: pay.dangerInk,
                onTap: onUndo,
              ),
          ],
        ),
        SizedBox(height: 10 * v),

        if (state.tenders.isEmpty)
          Text(
            'Nothing taken yet',
            style: TextStyle(fontSize: 18 * v, color: pay.inkDim),
          )
        else
          for (final t in state.tenders) ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    t.entryMode == 'manual' ? '${t.label} (keyed)' : t.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 19 * v, color: pay.inkSoft),
                  ),
                ),
                Text(
                  _money(t.amountMinor),
                  style: TextStyle(
                    fontSize: 19 * v,
                    color: pay.ink,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
            // The notes it was made of. A customer who handed over three
            // twenties wants to see three twenties, not "£60" — which is the
            // whole reason the note keys count rather than sum.
            if (t.cashBreakdown != null)
              Padding(
                padding: EdgeInsets.only(bottom: 2 * v),
                child: Text(
                  CashTally.decode(t.cashBreakdown).describe(labels),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14 * v, color: pay.inkMuted),
                ),
              ),
            SizedBox(height: 6 * v),
          ],

        if (state.changeMinor > 0) ...[
          SizedBox(height: 8 * v),
          Container(
            padding: EdgeInsets.symmetric(vertical: 12 * v, horizontal: 14 * v),
            decoration: BoxDecoration(
              color: pay.changeFill,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Expanded(
                  child: Text(
                    'Change',
                    style:
                        TextStyle(fontSize: 15 * v, color: pay.changeLabel),
                  ),
                ),
                Text(
                  _money(state.changeMinor),
                  style: TextStyle(
                    fontSize: 26 * v,
                    fontWeight: FontWeight.w700,
                    color: pay.changeInk,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  /// The shares of a split, tappable so the clerk can jump between people.
  List<Widget> _shares(BuildContext context, double v) {
    if (!state.isSplit) return const [];
    final pay = PayPalette.of(context);

    return [
      SizedBox(height: 10 * v),
      Wrap(
        spacing: 6 * v,
        runSpacing: 6 * v,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (final share in state.shares)
            _ShareChip(
              label: share.settled
                  ? '${share.index + 1} ✓'
                  : '${share.index + 1}  ${_money(share.outstandingMinor)}',
              scale: v,
              active: share.index == state.activeShare,
              settled: share.settled,
              onTap: onSelectShare == null
                  ? null
                  : () => onSelectShare!(share.index),
            ),
          if (onClearSplit != null)
            _TextKey(
              label: 'Un-split',
              scale: v,
              colour: pay.inkMuted,
              onTap: onClearSplit,
            ),
        ],
      ),
    ];
  }

  /// Cash and Card. Deliberately the largest targets on the board.
  Widget _primary(BuildContext context, double v) {
    final pay = PayPalette.of(context);
    final due = state.dueNowMinor;

    return Row(
      children: [
        Expanded(
          child: _BigKey(
            caption: 'TENDER',
            label: 'Cash',
            scale: v,
            fill: pay.cash,
            ink: pay.onCash,
            onTap: due > 0 ? () => onTender(TenderKind.cash, _amount) : null,
          ),
        ),
        SizedBox(width: 16 * v),
        Expanded(
          child: _BigKey(
            caption: 'TENDER',
            label: _isPartial && settings.allowPartialCard ? 'Part card' : 'Card',
            scale: v,
            fill: pay.card,
            ink: pay.onCard,
            onTap: _cardAmount == null
                ? null
                : () => onTender(TenderKind.card, _cardAmount!),
          ),
        ),
      ],
    );
  }

  /// Manual card — keyed into the reader by hand, for a card that will not read
  /// or a telephone order. Its own key because it is recorded differently and
  /// carries different liability from a presented card.
  Widget _secondary(BuildContext context, double v) {
    return Row(
      children: [
        Expanded(
          child: _FlatKey(
            label: 'Manual card',
            scale: v,
            fontSize: 22 * v,
            onTap: _cardAmount == null
                ? null
                : () => onTender(TenderKind.manualCard, _cardAmount!),
          ),
        ),
        if (settings.allowSplitBill) ...[
          SizedBox(width: 16 * v),
          Expanded(
            child: _FlatKey(
              label: state.isSplit ? 'Shares' : 'Split bill',
              scale: v,
              fontSize: 22 * v,
              onTap: onSplit,
            ),
          ),
        ],
      ],
    );
  }

  /// Everything that redeems held money, applies a reduction, or prints.
  ///
  /// Four across and half the height of the notes above them, at the venue's
  /// request: these are the keys a clerk reaches for a few times a shift, and
  /// giving them the same weight as Cash was costing room the note pictures
  /// needed.
  Widget _functions(BuildContext context, double v) {
    final due = state.dueNowMinor;
    final gap = 14 * v;
    final rowHeight = 104 * v;

    final keys = <Widget>[
      _FlatKey(
        label: 'Gift card',
        scale: v,
        fontSize: 19 * v,
        onTap: due > 0 ? () => onTender(TenderKind.giftCard, _amount) : null,
      ),
      _FlatKey(
        label: 'Voucher',
        scale: v,
        fontSize: 19 * v,
        onTap: () => onTender(TenderKind.voucher, _amount),
      ),
      _FlatKey(
        label: 'Deposit',
        scale: v,
        fontSize: 19 * v,
        onTap: due > 0 ? () => onTender(TenderKind.deposit, _amount) : null,
      ),
      _FlatKey(
        label: 'Points',
        scale: v,
        fontSize: 19 * v,
        onTap: () => onTender(TenderKind.points, _amount),
      ),
      _FlatKey(
        label: 'Discount',
        scale: v,
        fontSize: 19 * v,
        onTap: onDiscount,
      ),
      _FlatKey(
        label: 'Customer',
        scale: v,
        fontSize: 19 * v,
        onTap: onCustomer,
      ),
      _FlatKey(
        // The key says what it will do, and what it already did — a clerk who
        // has added service needs to see that from across the counter.
        label: state.totals.gratuityMinor > 0
            ? 'Service ${_money(state.totals.gratuityMinor)}'
            : 'Gratuity',
        scale: v,
        fontSize: 19 * v,
        highlighted: state.totals.gratuityMinor > 0,
        onTap: settings.gratuityEnabled ? onGratuity : null,
      ),
      _FlatKey(
        label: 'Print bill',
        scale: v,
        fontSize: 19 * v,
        onTap: onPrintBill,
      ),
    ];

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var row = 0; row < 2; row++) ...[
          if (row > 0) SizedBox(height: gap),
          SizedBox(
            height: rowHeight,
            child: Row(
              children: [
                for (var col = 0; col < 4; col++) ...[
                  if (col > 0) SizedBox(width: gap),
                  Expanded(child: keys[row * 4 + col]),
                ],
              ],
            ),
          ),
        ],
      ],
    );
  }

  Widget _label(BuildContext context, String text, double v) => Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 14 * v,
          letterSpacing: 2 * v,
          fontWeight: FontWeight.w500,
          color: PayPalette.of(context).inkMuted,
        ),
      );
}

/// The keypad column: what is being taken, the round-up keys, and the digits.
class PayKeypad extends StatelessWidget {
  const PayKeypad({
    super.key,
    required this.state,
    required this.settings,
    required this.entry,
    required this.amountMinor,
    required this.onKey,
    required this.onTender,
  });

  final TenderState state;
  final TenderSettings settings;

  /// What the clerk has keyed, as typed. Empty means "settle the balance".
  final String entry;

  /// What a tender key will take, worked out by the payment screen.
  final int amountMinor;

  final void Function(String key) onKey;
  final void Function(TenderKind kind, int amountMinor) onTender;

  static const _keys = [
    '7', '8', '9', //
    '4', '5', '6',
    '1', '2', '3',
    '.', '0',
  ];

  static const _designHeight = 944.0;

  bool get _isPartial =>
      amountMinor > 0 && amountMinor < state.dueNowMinor;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, box) {
        final v = box.maxHeight.isFinite
            ? (box.maxHeight / _designHeight).clamp(0.62, 1.0)
            : 1.0;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _amount(context, v),
            SizedBox(height: 16 * v),
            ..._quickCash(context, v),
            Expanded(child: _pad(context, v)),
          ],
        );
      },
    );
  }

  Widget _amount(BuildContext context, double v) {
    final pay = PayPalette.of(context);
    final keyed = entry.isNotEmpty;

    return Container(
      padding: EdgeInsets.symmetric(vertical: 18 * v, horizontal: 24 * v),
      decoration: BoxDecoration(
        color: pay.panel,
        border: Border.all(
          // The box lights up once the clerk starts typing, so a part payment
          // is never taken by a keypad nobody noticed was loaded.
          color: keyed ? pay.accentLine : pay.panelLine,
          width: keyed ? 2 : 1,
        ),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            keyed ? 'TAKING' : 'AMOUNT',
            style: TextStyle(
              fontSize: 14 * v,
              letterSpacing: 2 * v,
              fontWeight: FontWeight.w500,
              color: pay.inkMuted,
            ),
          ),
          SizedBox(height: 4 * v),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerRight,
            child: Text(
              _money(amountMinor),
              maxLines: 1,
              style: TextStyle(
                fontSize: 56 * v,
                fontWeight: FontWeight.w700,
                letterSpacing: -1.5 * v,
                // Dimmed until it is the clerk's own figure: what is shown
                // before anything is keyed is simply the balance restated.
                color: keyed ? pay.ink : pay.inkDim,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
          // How much more is needed, stated inline rather than in a dialog: the
          // clerk has to be able to tell the customer they are short *before*
          // taking the money.
          if (_isPartial)
            Padding(
              padding: EdgeInsets.only(top: 6 * v),
              child: Text(
                settings.allowPartialCard
                    ? '${_money(state.dueNowMinor - amountMinor)} more needed'
                    : '${_money(state.dueNowMinor - amountMinor)} more needed '
                        '— card must cover the whole bill',
                textAlign: TextAlign.right,
                style: TextStyle(
                  fontSize: 15 * v,
                  fontWeight: FontWeight.w600,
                  color: pay.accent,
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// Round-up and exact-change keys. Only amounts at or above what is owed, so
  /// one of these can never take a payment the customer has not made.
  List<Widget> _quickCash(BuildContext context, double v) {
    final due = state.dueNowMinor;
    if (due <= 0) return const [];

    final amounts = state.cashSuggestions(settings.cashPresets).take(3).toList();
    if (amounts.isEmpty) return const [];

    return [
      SizedBox(
        height: 72 * v,
        child: Row(
          children: [
            for (var i = 0; i < amounts.length; i++) ...[
              if (i > 0) SizedBox(width: 12 * v),
              Expanded(
                child: _QuickKey(
                  label: amounts[i] == due ? 'Exact' : _money(amounts[i]),
                  scale: v,
                  onTap: () => onTender(TenderKind.cash, amounts[i]),
                ),
              ),
            ],
            // Keeps three columns however many suggestions there are, so the
            // keys do not change width — and therefore position — as the
            // balance changes under the clerk's hand.
            for (var i = amounts.length; i < 3; i++) ...[
              SizedBox(width: 12 * v),
              const Expanded(child: SizedBox.shrink()),
            ],
          ],
        ),
      ),
      SizedBox(height: 16 * v),
    ];
  }

  Widget _pad(BuildContext context, double v) {
    final pay = PayPalette.of(context);
    final gap = 12 * v;

    return LayoutBuilder(
      builder: (context, box) {
        final keyHeight = (box.maxHeight - gap * 3) / 4;

        Widget key(String label) => _PadKey(
              label: label,
              scale: v,
              onTap: () => onKey(label),
            );

        return Column(
          children: [
            for (var row = 0; row < 4; row++) ...[
              if (row > 0) SizedBox(height: gap),
              SizedBox(
                height: keyHeight,
                child: Row(
                  children: [
                    for (var col = 0; col < 3; col++) ...[
                      if (col > 0) SizedBox(width: gap),
                      Expanded(
                        child: row == 3 && col == 2
                            // CL is the only destructive key on the pad, and it
                            // is the one a clerk hits fastest when a customer
                            // changes their mind. It is coloured as such.
                            ? _PadKey(
                                label: 'CL',
                                scale: v,
                                fill: pay.dangerFill,
                                ink: pay.dangerInk,
                                border: false,
                                onTap: () => onKey('CL'),
                              )
                            : key(_keys[row * 3 + col]),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

/// Cash and Card: a caption above a very large word.
class _BigKey extends StatelessWidget {
  const _BigKey({
    required this.caption,
    required this.label,
    required this.scale,
    required this.fill,
    required this.ink,
    this.onTap,
  });

  final String caption;
  final String label;
  final double scale;
  final Color fill;
  final Color ink;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);
    final off = onTap == null;
    final s = scale;

    return Material(
      color: off ? pay.softFill : fill,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: 22 * s, horizontal: 26 * s),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                caption,
                style: TextStyle(
                  fontSize: 15 * s,
                  letterSpacing: 2 * s,
                  fontWeight: FontWeight.w500,
                  color: off ? pay.inkDim : ink.withValues(alpha: 0.6),
                ),
              ),
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  label,
                  maxLines: 1,
                  style: TextStyle(
                    fontSize: 44 * s,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -1 * s,
                    color: off ? pay.inkDim : ink,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A quiet key: manual card, split, and the eight function keys.
class _FlatKey extends StatelessWidget {
  const _FlatKey({
    required this.label,
    required this.scale,
    required this.fontSize,
    this.highlighted = false,
    this.onTap,
  });

  final String label;
  final double scale;
  final double fontSize;

  /// Says the key has already done something — service added, for instance.
  final bool highlighted;

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);
    final off = onTap == null;

    return Material(
      color: highlighted ? pay.accentFill : pay.softFill,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          alignment: Alignment.center,
          padding: EdgeInsets.symmetric(horizontal: 8 * scale),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: highlighted ? pay.accentLine : pay.softLine,
            ),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: fontSize,
              fontWeight: highlighted ? FontWeight.w700 : FontWeight.w500,
              color: off
                  ? pay.inkDim
                  : highlighted
                      ? pay.accent
                      : pay.ink,
            ),
          ),
        ),
      ),
    );
  }
}

/// A round-up key. Brand-tinted, because pressing one takes cash.
class _QuickKey extends StatelessWidget {
  const _QuickKey({
    required this.label,
    required this.scale,
    this.onTap,
  });

  final String label;
  final double scale;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);

    return Material(
      color: pay.accentFill,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: pay.accentLine),
          ),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 8 * scale),
              child: Text(
                label,
                maxLines: 1,
                style: TextStyle(
                  fontSize: 21 * scale,
                  fontWeight: FontWeight.w600,
                  color: pay.accent,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One digit.
class _PadKey extends StatelessWidget {
  const _PadKey({
    required this.label,
    required this.scale,
    this.fill,
    this.ink,
    this.border = true,
    this.onTap,
  });

  final String label;
  final double scale;
  final Color? fill;
  final Color? ink;
  final bool border;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);

    return Material(
      color: fill ?? pay.keyFill,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: border ? Border.all(color: pay.keyLine) : null,
          ),
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              label,
              style: TextStyle(
                fontSize: (label == 'CL' ? 30 : 38) * scale,
                fontWeight: label == 'CL' ? FontWeight.w700 : FontWeight.w600,
                color: ink ?? pay.ink,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One share of a split bill.
class _ShareChip extends StatelessWidget {
  const _ShareChip({
    required this.label,
    required this.scale,
    required this.active,
    required this.settled,
    this.onTap,
  });

  final String label;
  final double scale;
  final bool active;
  final bool settled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);
    final fill = settled
        ? pay.changeFill
        : active
            ? pay.card
            : pay.softFill;
    final ink = settled
        ? pay.changeInk
        : active
            ? pay.onCard
            : pay.inkSoft;

    return Material(
      color: fill,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: 14 * scale,
            vertical: 8 * scale,
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 15 * scale,
              fontWeight: FontWeight.w600,
              color: ink,
            ),
          ),
        ),
      ),
    );
  }
}

/// A word that acts like a button — Undo, Un-split. Deliberately understated:
/// these are the rare paths, and they sit beside things that take money.
class _TextKey extends StatelessWidget {
  const _TextKey({
    required this.label,
    required this.scale,
    required this.colour,
    this.onTap,
  });

  final String label;
  final double scale;
  final Color colour;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: 8 * scale,
            vertical: 4 * scale,
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 15 * scale,
              fontWeight: FontWeight.w700,
              color: colour,
            ),
          ),
        ),
      ),
    );
  }
}
