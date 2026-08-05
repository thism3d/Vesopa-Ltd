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
  final Color? color;
}

/// The strip along the bottom of the till: secondary actions on the left, the
/// large primary tender button on the right.
///
/// Every button carries an icon as well as a label. On a phone the labels were
/// being squeezed to the point of being unreadable — an icon survives the
/// squeeze, and a clerk reaching for "Void" mid-service is reading the shape,
/// not the word.
class PosActionBar extends StatelessWidget {
  const PosActionBar({
    super.key,
    required this.actions,
    required this.primaryLabel,
    required this.primaryIcon,
    required this.onPrimary,
  });

  final List<PosAction> actions;
  final String primaryLabel;
  final IconData primaryIcon;
  final VoidCallback? onPrimary;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final barColor = theme.posActionBar;
    final phone = context.isPhone;

    // Nine buttons across a phone gives each about 40px — below the 48px that
    // is reliably tappable. Keep the two that matter mid-service and move the
    // rest into a sheet.
    final visible = phone ? actions.take(2).toList() : actions;
    final overflow = phone ? actions.skip(2).toList() : const <PosAction>[];

    return Material(
      color: barColor,
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 64,
          child: Row(
            children: [
              for (final action in visible)
                Expanded(child: _Button(action: action, barColor: barColor)),
              if (overflow.isNotEmpty)
                Expanded(
                  child: _Button(
                    barColor: barColor,
                    action: PosAction(
                      label: 'More',
                      icon: Icons.more_horiz,
                      onTap: () => _showMore(context, overflow),
                    ),
                  ),
                ),
              Expanded(
                flex: phone ? 3 : 2,
                child: _PrimaryButton(
                  label: primaryLabel,
                  icon: primaryIcon,
                  onTap: onPrimary,
                ),
              ),
            ],
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

class _Button extends StatelessWidget {
  const _Button({required this.action, required this.barColor});

  final PosAction action;
  final Color barColor;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: action.color ?? barColor,
      child: InkWell(
        onTap: action.onTap,
        child: Container(
          decoration: const BoxDecoration(
            border: Border(
              right: BorderSide(color: Colors.white24, width: 0.5),
            ),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(action.icon, color: Colors.white, size: 20),
              const SizedBox(height: 3),
              // One line, shrunk to fit rather than wrapped or clipped: a
              // half-rendered "Cust…" is worse than a slightly smaller word.
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  action.label,
                  maxLines: 1,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 11.5,
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

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;

    // The brand lime is a light colour: white on it is unreadable, so the
    // primary key carries dark ink. Disabled dims the lime towards the bar
    // rather than fading the whole button out, so it still reads as the PAY
    // key on a dark strip.
    final ink = enabled ? Pos.onBrand : Pos.onBrand.withValues(alpha: 0.45);

    return Material(
      // Dimmed when there is nothing to pay for, so an empty sale cannot be
      // tendered.
      color: enabled ? Pos.brand : Pos.brand.withValues(alpha: 0.35),
      child: InkWell(
        onTap: onTap,
        child: Center(
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
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 0.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
