/// Vesopa EPOS Lite's mark and the bits of look it adds to Vesopa Tap's theme.
///
/// The family palette (lime #A5C715 on ink) from vesopa_tap's `Tp`, so Lite
/// sits beside the tills and Tap as one product line. Lime is the next thing
/// to press: Pay, Add, Done. The sale screen is ink by default, as the
/// terminal it runs on is usually behind a bar.
library;

import 'package:flutter/material.dart';
import 'package:vesopa_tap/ui/theme.dart';

const appName = 'Vesopa EPOS Lite';

/// The till mark: a lime tile with the register, as the Vesopa EPOS icon.
class LiteMark extends StatelessWidget {
  const LiteMark({super.key, this.size = 40});
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(size * 0.28)),
    child: Icon(Icons.point_of_sale_rounded, size: size * 0.6, color: Tp.ink),
  );
}

/// "Vesopa EPOS" with a small raised "lite", like the product's wordmark.
class LiteWordmark extends StatelessWidget {
  const LiteWordmark({super.key, this.size = 20, this.mark = true});
  final double size;
  final bool mark;

  @override
  Widget build(BuildContext context) {
    final colour = Theme.of(context).colorScheme.onSurface;
    // Scales down rather than overflows: an app bar on a small terminal,
    // beside the clerk's name and the offline mark, has little room.
    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (mark) ...[LiteMark(size: size * 1.5), SizedBox(width: size * 0.45)],
          Text(
            'Vesopa EPOS',
            style: TextStyle(fontSize: size, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: colour),
          ),
          Transform.translate(
            offset: Offset(2, -size * 0.45),
            child: Text(
              'lite',
              style: TextStyle(fontSize: size * 0.55, fontWeight: FontWeight.w700, color: Tp.lime),
            ),
          ),
        ],
      ),
    );
  }
}

/// An icon for a menu category from its name, so the rail reads at a glance
/// without anyone choosing icons in the back office.
IconData categoryIcon(String name) {
  final n = name.toLowerCase();
  bool has(List<String> words) => words.any(n.contains);
  if (has(['coffee', 'tea', 'hot drink'])) return Icons.coffee_rounded;
  if (has(['wine', 'fizz', 'prosecco', 'champagne'])) return Icons.wine_bar_rounded;
  if (has(['beer', 'ale', 'lager', 'draught', 'cider', 'pint', 'bottle'])) return Icons.sports_bar_rounded;
  if (has(['spirit', 'cocktail', 'shot', 'gin', 'vodka', 'whisky'])) return Icons.local_bar_rounded;
  if (has(['soft', 'mixer', 'minerals', 'juice', 'drink'])) return Icons.local_drink_rounded;
  if (has(['starter', 'small plate', 'snack', 'side'])) return Icons.tapas_rounded;
  if (has(['dessert', 'pudding', 'sweet', 'ice cream'])) return Icons.icecream_rounded;
  if (has(['special', 'offer', 'deal', 'set', 'meal'])) return Icons.star_rounded;
  if (has(['burger', 'main', 'food', 'grill', 'kitchen', 'hot food'])) return Icons.restaurant_rounded;
  if (has(['crisp', 'nut', 'confection'])) return Icons.cookie_rounded;
  if (has(['kid', 'child'])) return Icons.child_care_rounded;
  if (has(['merch', 'retail', 'shop'])) return Icons.shopping_bag_rounded;
  return Icons.grid_view_rounded;
}
