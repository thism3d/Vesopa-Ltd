import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/commerce.dart';
import '../../data/tender_engine.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// The tender side of the payment screen: keypad, quick cash, and every way
/// the venue can take money.
///
/// Sits beside the live receipt rather than covering it, so the clerk can see
/// the bill while taking payment for it. On a phone it is the whole screen;
/// on a Windows touch till it is a docked column.
class TenderPanel extends StatelessWidget {
  const TenderPanel({
    super.key,
    required this.state,
    required this.settings,
    required this.entry,
    required this.onKey,
    required this.onTender,
    this.onGratuity,
    this.onSplit,
    this.onSelectShare,
    this.onClearSplit,
    this.onUndo,
    this.onCustomer,
    this.onDiscount,
    this.cashNotes,
    this.compact = false,
  });

  final TenderState state;
  final TenderSettings settings;

  /// What the clerk has keyed in, as typed. Empty means "settle the balance".
  final String entry;

  final void Function(String key) onKey;
  final void Function(TenderKind kind, int amountMinor) onTender;

  final void Function()? onGratuity;
  final void Function()? onSplit;
  final void Function(int index)? onSelectShare;
  final void Function()? onClearSplit;
  final void Function()? onUndo;
  final void Function()? onCustomer;

  /// Take the keyed amount off the bill as the clerk's own discount.
  final void Function()? onDiscount;

  /// The cash note keys (see CashNotesPanel), built by the payment screen so
  /// this widget stays free of database and tally concerns.
  final Widget? cashNotes;

  /// Tighter spacing for a docked column on a desktop till.
  final bool compact;

  /// The amount a tender button will take: what was keyed, or the balance.
  int get _amount {
    final keyed = double.tryParse(entry);
    if (keyed != null && keyed > 0) return (keyed * 100).round();
    return state.dueNowMinor;
  }

  /// Whether the keyed amount is a *part* payment rather than the whole
  /// balance. A venue can turn part-payment by card off — some do, because two
  /// card fees on one bill costs them more than the convenience is worth — and
  /// the setting existed but was never honoured, so the switch did nothing.
  bool get _isPartial => _amount > 0 && _amount < state.dueNowMinor;

  /// What the card keys will take, or null when they should be refused.
  int? get _cardAmount {
    if (state.dueNowMinor <= 0) return null;
    if (_isPartial && !settings.allowPartialCard) return null;
    // Never charge a card more than is owed: an overpayment on a card is a
    // refund to arrange, not change to hand over.
    return _amount > state.dueNowMinor ? state.dueNowMinor : _amount;
  }

  /// Below this the panel is one stacked column; above it, two.
  ///
  /// A single column stretched across a 1920px Windows till turns the keypad
  /// into three 500px-wide bars — the grid takes its width from the parent, so
  /// "more room" made every control worse rather than better. Past this width
  /// the panel splits instead of stretching.
  static const _twoColumnWidth = 640.0;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= _twoColumnWidth;
        if (!wide) return _stacked(context);

        // Entering money on the left, taking it on the right. The clerk's hand
        // travels keypad -> Cash/Card, so they sit next to each other rather
        // than a screen apart.
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: _entryColumnWidth,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _amountHeader(context),
                  SizedBox(height: compact ? 8 : 12),
                  _keypadBlock(context),
                ],
              ),
            ),
            const SizedBox(width: 18),
            // Capped as a block rather than per-row: left to fill a 1920px
            // till every one of these would be a metre-wide pill, and the
            // column would stop reading as a column.
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _capped(
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ..._quickCash(context),
                        _primaryTenders(context),
                        ..._partialCardNote(context),
                        const SizedBox(height: 8),
                        _secondaryTenders(context),
                        const SizedBox(height: 8),
                        _extras(context),
                        ..._sharesBlock(context),
                        ..._undoBlock(context),
                      ],
                    ),
                    _actionMaxWidth,
                  ),
                  // The note pictures sit below Customer/Discount/Gratuity and
                  // deliberately outside the cap: they are photographs of
                  // banknotes, and squeezing them into the 520px action column
                  // is what made the old coloured note keys unreadable.
                  ?cashNotes,
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  /// The original single-column arrangement, for phones and narrow docks.
  Widget _stacked(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _amountHeader(context),
        SizedBox(height: compact ? 8 : 12),
        ..._quickCash(context),
        _keypadBlock(context),
        _primaryTenders(context),
        ..._partialCardNote(context),
        const SizedBox(height: 8),
        _secondaryTenders(context),
        const SizedBox(height: 8),
        _extras(context),
        ?cashNotes,
        ..._sharesBlock(context),
        ..._undoBlock(context),
      ],
    );
  }

  /// What is being asked for right now.
  Widget _amountHeader(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final due = state.dueNowMinor;

    return Container(
          padding: EdgeInsets.symmetric(
              vertical: compact ? 10 : 14, horizontal: 14),
          decoration: BoxDecoration(
            color: scheme.primaryContainer,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            children: [
              Text(
                state.isSplit
                    ? 'Share ${state.activeShare + 1} of ${state.shares.length}'
                    : 'To pay',
                style: theme.textTheme.labelMedium?.copyWith(
                  color: scheme.onPrimaryContainer.withValues(alpha: 0.8),
                ),
              ),
              Text(
                _money(due),
                style: theme.textTheme.headlineMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: scheme.onPrimaryContainer,
                ),
              ),
              // The keyed amount, when it differs from the balance — this is
              // what makes a part payment visible before it is taken.
              //
              // This is what the clerk is actually typing, so it is set at
              // title size rather than the caption it used to be: at bodySmall
              // on a desktop till the digits being entered were smaller than
              // the label above them.
              if (entry.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    'Taking ${_money(_amount)}',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: scheme.onPrimaryContainer,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),

              // How much more is needed, when what has been keyed does not cover
              // the balance. Stated here, inline, rather than in a dialog: the
              // confirmation step that used to say this was removed in v1.3.1.0,
              // and the clerk still has to be able to tell the customer they are
              // short before taking the money.
              if (_isPartial)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    '${_money(state.dueNowMinor - _amount)} more needed',
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: scheme.onPrimaryContainer,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
            ],
          ),
    );
  }

  /// Round-up and exact-change keys. Only amounts at or above what is owed, so
  /// one of these can never take a payment the customer has not made.
  List<Widget> _quickCash(BuildContext context) {
    final due = state.dueNowMinor;
    if (due <= 0) return const [];
    return [
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final amount in state.cashSuggestions(settings.cashPresets))
            _Chip(
              label: amount == due ? 'Exact' : _money(amount),
              tone: _ChipTone.cash,
              onTap: () => onTender(TenderKind.cash, amount),
            ),
        ],
      ),
      SizedBox(height: compact ? 8 : 12),
    ];
  }

  /// The entry column on a wide till: amount, notes, keypad. Fixed, because a
  /// number pad is sized by the hand using it, not by the screen it is on —
  /// stretched across a 1920px till the keys stop looking like a calculator and
  /// start looking like a row of banners.
  static const _entryColumnWidth = 360.0;

  /// Caps for the same blocks when the panel is one stacked column.
  static const _keypadMaxWidth = 360.0;

  /// The widest the Cash/Card pair should get. Large, but still buttons.
  static const _actionMaxWidth = 520.0;

  /// Caps a block's width and pins it to the left, so the column can be as wide
  /// as it likes without dragging the controls out of shape.
  Widget _capped(Widget child, double maxWidth) => Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: maxWidth),
          child: child,
        ),
      );

  Widget _keypadBlock(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          _capped(_Keypad(onKey: onKey, compact: compact), _keypadMaxWidth),
          SizedBox(height: compact ? 8 : 12),
        ],
      );

  /// Primary tenders. Deliberately the largest targets on the screen — these
  /// two take almost every payment, and they were previously the same size as
  /// the secondary keys around them.
  Widget _primaryTenders(BuildContext context) {
    final due = state.dueNowMinor;
    return _capped(
      Row(
          children: [
            Expanded(
              child: _TenderButton(
                icon: Icons.payments,
                label: 'Cash',
                onTap: due > 0 ? () => onTender(TenderKind.cash, _amount) : null,
                tone: _ChipTone.cash,
                compact: compact,
                large: true,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _TenderButton(
                icon: Icons.credit_card,
                label: _isPartial && settings.allowPartialCard
                    ? 'Part card'
                    : 'Card',
                onTap: _cardAmount == null
                    ? null
                    : () => onTender(TenderKind.card, _cardAmount!),
                tone: _ChipTone.primary,
                compact: compact,
                large: true,
              ),
            ),
          ],
      ),
      _actionMaxWidth,
    );
  }

  /// Say why the card keys are refused, rather than leaving a dead button the
  /// clerk taps twice before giving up.
  List<Widget> _partialCardNote(BuildContext context) {
    final due = state.dueNowMinor;
    if (!(due > 0 && _isPartial && !settings.allowPartialCard)) return const [];
    return [
      Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text(
          'Part payment by card is switched off for this venue — the card '
          'has to cover the whole ${_money(due)}.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.error),
        ),
      ),
    ];
  }

  /// Manual card: keyed into the reader by hand, for a card that will not read
  /// or a telephone order. Deliberately its own button, because it is recorded
  /// differently and carries different liability.
  Widget _secondaryTenders(BuildContext context) {
    return Row(
          children: [
            Expanded(
              child: _TenderButton(
                icon: Icons.dialpad,
                label: 'Manual card',
                onTap: _cardAmount == null
                    ? null
                    : () => onTender(TenderKind.manualCard, _cardAmount!),
                compact: compact,
              ),
            ),
            if (settings.allowSplitBill) ...[
              const SizedBox(width: 8),
              Expanded(
                child: _TenderButton(
                  icon: Icons.call_split,
                  label: state.isSplit ? 'Shares' : 'Split bill',
                  onTap: onSplit,
                  compact: compact,
                ),
              ),
            ],
          ],
    );
  }

  /// Everything that redeems held money, or applies a reduction.
  Widget _extras(BuildContext context) {
    final due = state.dueNowMinor;
    return Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            _Chip(
              label: 'Gift card',
              icon: Icons.card_giftcard,
              onTap: due > 0
                  ? () => onTender(TenderKind.giftCard, _amount)
                  : null,
            ),
            _Chip(
              label: 'Voucher',
              icon: Icons.confirmation_number_outlined,
              onTap: () => onTender(TenderKind.voucher, _amount),
            ),
            _Chip(
              label: 'Deposit',
              icon: Icons.account_balance_wallet_outlined,
              onTap: due > 0
                  ? () => onTender(TenderKind.deposit, _amount)
                  : null,
            ),
            _Chip(
              label: 'Points',
              icon: Icons.stars_outlined,
              onTap: () => onTender(TenderKind.points, _amount),
            ),
            if (onDiscount != null)
              _Chip(
                label: 'Discount',
                icon: Icons.percent,
                onTap: onDiscount,
              ),
            if (onCustomer != null)
              _Chip(
                label: 'Customer',
                icon: Icons.person_outline,
                onTap: onCustomer,
              ),
            if (settings.gratuityEnabled && onGratuity != null)
              _Chip(
                label: state.totals.gratuityMinor > 0
                    ? 'Service ${_money(state.totals.gratuityMinor)}'
                    : 'Add gratuity',
                icon: Icons.volunteer_activism_outlined,
                tone: state.totals.gratuityMinor > 0
                    ? _ChipTone.active
                    : _ChipTone.plain,
                onTap: onGratuity,
              ),
          ],
    );
  }

  /// Shares of a split, tappable so the clerk can jump between people.
  List<Widget> _sharesBlock(BuildContext context) {
    if (!state.isSplit) return const [];
    final theme = Theme.of(context);
    return [
      const SizedBox(height: 10),
      Row(
        children: [
          Expanded(
            child: Text('Shares',
                style: theme.textTheme.labelMedium
                    ?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
          ),
          if (onClearSplit != null)
            TextButton(
              onPressed: onClearSplit,
              child: const Text('Un-split'),
            ),
        ],
      ),
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final share in state.shares)
            _Chip(
              label: share.settled
                  ? '${share.index + 1} ✓'
                  : '${share.index + 1}: ${_money(share.outstandingMinor)}',
              tone: share.settled
                  ? _ChipTone.done
                  : share.index == state.activeShare
                      ? _ChipTone.active
                      : _ChipTone.plain,
              onTap: onSelectShare == null
                  ? null
                  : () => onSelectShare!(share.index),
            ),
        ],
      ),
    ];
  }

  /// Undo, once something has been taken.
  List<Widget> _undoBlock(BuildContext context) {
    if (state.tenders.isEmpty || onUndo == null) return const [];
    return [
      const SizedBox(height: 10),
      OutlinedButton.icon(
        onPressed: onUndo,
        icon: const Icon(Icons.undo, size: 18),
        label: Text('Undo ${state.tenders.last.label} '
            '${_money(state.tenders.last.amountMinor)}'),
      ),
    ];
  }
}

enum _ChipTone { plain, cash, primary, active, done }

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    this.icon,
    this.onTap,
    this.tone = _ChipTone.plain,
  });

  final String label;
  final IconData? icon;
  final VoidCallback? onTap;
  final _ChipTone tone;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (bg, fg) = switch (tone) {
      _ChipTone.cash => (scheme.tertiaryContainer, scheme.onTertiaryContainer),
      _ChipTone.primary => (scheme.primary, scheme.onPrimary),
      _ChipTone.active => (scheme.primary, scheme.onPrimary),
      _ChipTone.done => (scheme.primaryContainer, scheme.onPrimaryContainer),
      _ChipTone.plain => (scheme.surfaceContainerHighest, scheme.onSurface),
    };

    return Material(
      color: onTap == null ? scheme.surfaceContainerHighest : bg,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(9),
        child: Padding(
          // Grown with the tender keys above them — a quick-cash chip is a
          // payment key too, and £20 being harder to hit than Cash made no sense.
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 17,
                    color: onTap == null ? scheme.outline : fg),
                const SizedBox(width: 7),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: onTap == null ? scheme.outline : fg,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TenderButton extends StatelessWidget {
  const _TenderButton({
    required this.icon,
    required this.label,
    this.onTap,
    this.tone = _ChipTone.plain,
    this.compact = false,
    this.large = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final _ChipTone tone;
  final bool compact;

  /// Cash and Card. They take the overwhelming majority of payments, so they
  /// get roughly half again the height and a much bigger label than the
  /// secondary tenders beside them.
  final bool large;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (bg, fg) = switch (tone) {
      _ChipTone.cash => (scheme.tertiaryContainer, scheme.onTertiaryContainer),
      _ChipTone.primary => (scheme.primary, scheme.onPrimary),
      _ => (scheme.surfaceContainerHighest, scheme.onSurface),
    };

    // Grown in v1.3.1.0: the venue reported these as too small to hit reliably.
    // Cash/Card went 92 → 120 (76 → 104 in the docked desktop column) and the
    // secondary keys 60 → 76, which is where a 9mm minimum touch target lands
    // once the label inside it is legible at arm's length across a counter.
    final height = large ? (compact ? 104 : 120) : (compact ? 68 : 76);

    return SizedBox(
      height: height.toDouble(),
      child: FilledButton.icon(
        onPressed: onTap,
        style: FilledButton.styleFrom(
          backgroundColor: bg,
          foregroundColor: fg,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(large ? 16 : 20),
          ),
        ),
        icon: Icon(icon, size: large ? 34 : 22),
        label: Text(
          label,
          style: TextStyle(
            fontWeight: FontWeight.w800,
            fontSize: large ? 26 : 16,
            letterSpacing: large ? 0.4 : 0,
          ),
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }
}

/// A £20 / £10 / £5 key, drawn as the note it stands for.
///
/// Deliberately *drawn* rather than a photograph of a Bank of England note:
/// reproducing banknote artwork is restricted, and a scan would also read
/// badly at this size. What makes a note recognisable on a till at a glance is
/// its colour and its number, and both are here. If licensed note images are
/// ever supplied, they drop into this one widget.
class _Keypad extends StatelessWidget {
  const _Keypad({required this.onKey, this.compact = false});

  final void Function(String key) onKey;
  final bool compact;

  static const _keys = [
    '7', '8', '9',
    '4', '5', '6',
    '1', '2', '3',
    '.', '0', 'CL',
  ];

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return GridView.count(
      crossAxisCount: 3,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 6,
      crossAxisSpacing: 6,
      // Close to square, like a calculator. The old 2.1:1 keys read as
      // wide bars even before the panel was widened.
      childAspectRatio: compact ? 1.45 : 1.35,
      children: [
        for (final key in _keys)
          Material(
            color: key == 'CL'
                ? scheme.errorContainer
                : scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(9),
            child: InkWell(
              onTap: () => onKey(key),
              borderRadius: BorderRadius.circular(9),
              // Sized off the key itself, not off `compact`.
              //
              // `compact` is true on a desktop till (the panel sits beside the
              // receipt), so the old `compact ? 17 : 19` gave the big screen the
              // *smaller* digits — a 120px key carrying 17pt text, which is what
              // made the calculator look shrunken on the desktop. The key is a
              // known aspect ratio, so its height is a reliable basis.
              child: LayoutBuilder(
                builder: (context, box) => Center(
                  child: Text(
                    key,
                    style: TextStyle(
                      fontSize: (box.maxHeight * 0.46).clamp(18.0, 34.0),
                      fontWeight: FontWeight.w700,
                      color: key == 'CL'
                          ? scheme.onErrorContainer
                          : scheme.onSurface,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
