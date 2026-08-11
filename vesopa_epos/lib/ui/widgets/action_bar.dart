import 'package:flutter/material.dart';

import '../layout.dart';
import '../theme.dart';

/// One button on the till's action bar.
class PosAction {
  const PosAction({
    required this.label,
    required this.icon,
    required this.onTap,
    this.color,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;

  /// A tint for the destructive keys. Left null for the ordinary ones, which
  /// take the bar's own surface.
  final Color? color;
}

/// The strip along the bottom of the till: the function keys on the left, the
/// large tender key on the right.
///
/// ## Room to grow
///
/// The keys are laid out by measuring, not by assuming a count. Each one is
/// given at least [_minKeyWidth] so it stays a real touch target, and the bar
/// works out how many fit across the space it has been handed: they fill one
/// row while they fit, spill onto a second when they do not, and anything past
/// two rows goes into a More sheet rather than shrinking every key past the
/// point of being hittable.
///
/// That is deliberate. Keys get added to this bar over time — it has taken
/// several already, and more are wanted — and the failure mode of a fixed
/// layout is that the tenth key silently makes the other nine too small to
/// press. Adding one here now costs a line in the caller's list and nothing
/// else.
class PosActionBar extends StatelessWidget {
  const PosActionBar({
    super.key,
    required this.actions,
    required this.primaryLabel,
    required this.primaryIcon,
    required this.onPrimary,
    this.primaryValue,
  });

  final List<PosAction> actions;
  final String primaryLabel;
  final IconData primaryIcon;
  final VoidCallback? onPrimary;

  /// What tendering will take, shown on the key itself. The clerk reads the
  /// figure they are about to charge off the key they are pressing rather than
  /// off the other side of the screen.
  final String? primaryValue;

  /// Below this a key stops being reliably hittable with a thumb on a busy
  /// counter. Everything about the layout follows from it.
  static const _minKeyWidth = 88.0;

  /// One row is the intent; two is the give. Past that the bar starts eating
  /// the grid, which is the screen a clerk actually works in.
  static const _maxRows = 2;

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final phone = context.isPhone;

    return Material(
      color: pal.canvas,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
          child: LayoutBuilder(
            builder: (context, box) {
              // The tender key first: it is the one thing that must never be
              // squeezed, so it is given its share and the function keys lay
              // out in what is left.
              final primaryWidth = (box.maxWidth * (phone ? 0.42 : 0.28))
                  .clamp(150.0, 340.0);
              final keysWidth = box.maxWidth - primaryWidth - 10;

              final perRow = (keysWidth / _minKeyWidth).floor().clamp(1, 12);
              final capacity = perRow * _maxRows;

              // Only spill into More when there is genuinely no room. With a
              // single key over capacity the More key would replace it and buy
              // nothing, so the last slot is spent on the sheet only when it
              // holds at least two.
              final needsOverflow = actions.length > capacity;
              final shown = needsOverflow
                  ? actions.take(capacity - 1).toList()
                  : actions;
              final hidden = needsOverflow
                  ? actions.skip(capacity - 1).toList()
                  : const <PosAction>[];

              final keys = <PosAction>[
                ...shown,
                if (hidden.isNotEmpty)
                  PosAction(
                    label: 'More',
                    icon: Icons.more_horiz,
                    onTap: () => _showMore(context, hidden),
                  ),
              ];

              // Rows are filled evenly rather than packing the first one full:
              // seven keys over two rows reads better as 4+3 than 6+1, and the
              // keys stay the same size as each other.
              final rows = (keys.length / perRow).ceil().clamp(1, _maxRows);
              final perRowEven = (keys.length / rows).ceil();

              return IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: Column(
                        children: [
                          for (var r = 0; r < rows; r++) ...[
                            if (r > 0) const SizedBox(height: 8),
                            Expanded(
                              child: Row(
                                children: [
                                  for (
                                    var i = r * perRowEven;
                                    i < (r + 1) * perRowEven;
                                    i++
                                  ) ...[
                                    if (i > r * perRowEven)
                                      const SizedBox(width: 8),
                                    Expanded(
                                      child: i < keys.length
                                          ? _Key(action: keys[i])
                                          // A short last row keeps its keys
                                          // the same width as the row above
                                          // rather than stretching them.
                                          : const SizedBox.shrink(),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 10),
                    SizedBox(
                      width: primaryWidth,
                      child: _PrimaryKey(
                        label: primaryLabel,
                        value: primaryValue,
                        icon: primaryIcon,
                        onTap: onPrimary,
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  void _showMore(BuildContext context, List<PosAction> actions) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Wrap(
          children: [
            for (final action in actions)
              ListTile(
                leading: Icon(action.icon, color: action.color),
                title: Text(action.label),
                onTap: () {
                  Navigator.pop(sheet);
                  action.onTap();
                },
              ),
          ],
        ),
      ),
    );
  }
}

/// One function key.
class _Key extends StatelessWidget {
  const _Key({required this.action});

  final PosAction action;

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final danger = action.color != null;

    // The destructive keys are the one place colour is spent on this bar.
    // Everything else takes the panel surface, so Void and Cancel are found by
    // colour at a glance rather than by reading eight labels.
    final fill = danger ? pal.dangerFill : pal.softFill;
    final ink = danger ? pal.dangerInk : pal.ink;

    return Material(
      color: fill,
      borderRadius: BorderRadius.circular(9),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: action.onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 56),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: danger ? pal.dangerInk : pal.softLine),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(action.icon, color: ink, size: 19),
              const SizedBox(height: 4),
              // One line, shrunk to fit rather than wrapped or clipped: a
              // half-rendered "Cust…" is worse than a slightly smaller word.
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  action.label,
                  maxLines: 1,
                  style: TextStyle(
                    color: ink,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
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

/// The tender key, carrying what it is about to take.
class _PrimaryKey extends StatelessWidget {
  const _PrimaryKey({
    required this.label,
    required this.value,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final String? value;
  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;

    // The brand lime is a light colour: white on it is unreadable, so this key
    // carries dark ink. Disabled dims the lime towards the board rather than
    // fading the whole button out, so it still reads as the Pay key.
    final ink = enabled ? Pos.onBrand : Pos.onBrand.withValues(alpha: 0.45);

    return Material(
      // Dimmed when there is nothing to pay for, so an empty sale cannot be
      // tendered.
      color: enabled ? Pos.brand : Pos.brand.withValues(alpha: 0.3),
      borderRadius: BorderRadius.circular(9),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, color: ink, size: 22),
                  const SizedBox(width: 10),
                  Text(
                    label,
                    style: TextStyle(
                      color: ink,
                      fontSize: 19,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.3,
                    ),
                  ),
                  if (value != null) ...[
                    const SizedBox(width: 12),
                    Text(
                      value!,
                      style: TextStyle(
                        color: ink,
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.4,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
